'use strict';

// Shortlet money flow, modelled on Airbnb:
//
//   1. Booking   — the guest's wallet is charged the full total. The platform
//                  HOLDS it (no host credit yet). See bookShortlet.
//   2. Payout    — 24h after check-in, the host is credited their share of
//                  (nights + cleaning fee), using the admin-set commission
//                  snapshotted on the booking.
//   3. Check-out — the stay is marked completed.
//   4. Deposit   — held until 48h after check-out (the host's claim window).
//                  No claim → refunded to the guest automatically. A claim →
//                  an admin decides how much goes to the host; the rest goes
//                  back to the guest.
//   5. Cancel    — by the listing's cancellation policy (snapshotted on the
//                  booking). See POLICIES below. Allowed until check-out:
//                  cancelling during a stay ends it early and refunds unused
//                  nights according to the policy.
//
// Every step locks the booking row first, re-checks its state, and moves money
// in a single DB transaction, so running the job twice (or a cancel racing a
// payout) can never pay or refund the same money twice.

const crypto = require('crypto');
const { Op } = require('sequelize');
const { ShortletBookings, Wallet, WalletTransactions, Users } = require('../models');
const { withTransaction } = require('./rollback');
const { applyKoboDelta } = require('./wallet');
const { createHostDebt, recoverHostDebt, hostsWithOpenDebts } = require('./hostDebt');
const { preCheckInPercent, describeStandardPolicy } = require('./cancellationPolicy');
const { toKobo, fromKobo } = require('./money');
const logger = require('./logger');

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const PAYOUT_DELAY_MS = 24 * HOUR_MS;           // host paid 24h after check-in
const DEPOSIT_CLAIM_WINDOW_MS = 48 * HOUR_MS;   // host may claim the deposit until 48h after check-out
const MID_STAY_GUEST_BUFFER_MS = 24 * HOUR_MS;  // guest pays for the next 24h when ending a stay early
const LAGOS_OFFSET = '+01:00';                  // WAT, no daylight saving

class BookingActionError extends Error {
  constructor(status, message, code, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details; // extra fields merged into the error response
  }
}

// ── Time helpers (all listing times are Lagos local time) ──
function todayInLagos(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Lagos' }).format(now);
}

function lagosDateTime(dateOnly, time) {
  const t = String(time || '00:00:00');
  const hhmmss = t.length === 5 ? `${t}:00` : t.slice(0, 8);
  return new Date(`${dateOnly}T${hhmmss}${LAGOS_OFFSET}`);
}

function addDays(dateOnly, days) {
  const d = new Date(`${dateOnly}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function checkInAt(booking) {
  return lagosDateTime(booking.check_in, booking.check_in_time);
}

function checkOutAt(booking) {
  return lagosDateTime(booking.check_out, booking.check_out_time);
}

// ── Cancellation policies (Airbnb's standard four) ──
// Before check-in: the share of the NIGHTLY total refunded. Cleaning fee and
// security deposit are always refunded before check-in. A host cancelling is
// always a full refund.
// During the stay: `midStayPercent` of the unused nights is refunded (the
// night in progress + the next 24h count as used); cleaning isn't refunded.
const POLICIES = {
  flexible: {
    label: 'Flexible',
    summary: 'Full refund up to 24 hours before check-in. After that, the first night is non-refundable. If you leave early, unused nights are refunded (the next 24 hours count as used).',
    midStayPercent: 100,
    freeUntil: (inAt) => new Date(inAt.getTime() - 24 * HOUR_MS),
    refundNights: ({ hoursBefore, nightsKobo, nightKobo }) =>
      hoursBefore >= 24 ? nightsKobo : Math.max(0, nightsKobo - nightKobo),
  },
  moderate: {
    label: 'Moderate',
    summary: 'Full refund up to 5 days before check-in. After that, the first night is non-refundable and 50% of the other nights are refunded. If you leave early, 50% of unused nights are refunded (the next 24 hours count as used).',
    midStayPercent: 50,
    freeUntil: (inAt) => new Date(inAt.getTime() - 5 * DAY_MS),
    refundNights: ({ hoursBefore, nightsKobo, nightKobo }) =>
      hoursBefore >= 5 * 24 ? nightsKobo : Math.round(Math.max(0, nightsKobo - nightKobo) * 0.5),
  },
  firm: {
    label: 'Firm',
    summary: 'Full refund up to 30 days before check-in. 50% refund of nights up to 7 days before check-in. No refund of nights after that, or if you leave early.',
    midStayPercent: 0,
    freeUntil: (inAt) => new Date(inAt.getTime() - 30 * DAY_MS),
    refundNights: ({ hoursBefore, nightsKobo }) =>
      hoursBefore >= 30 * 24 ? nightsKobo : hoursBefore >= 7 * 24 ? Math.round(nightsKobo * 0.5) : 0,
  },
  strict: {
    label: 'Strict',
    summary: 'Full refund only if you cancel within 48 hours of booking and at least 14 days before check-in. 50% refund of nights up to 7 days before check-in. No refund of nights after that, or if you leave early.',
    midStayPercent: 0,
    freeUntil: (inAt, bookedAt) => {
      const deadline = new Date(Math.min(bookedAt.getTime() + 48 * HOUR_MS, inAt.getTime() - 14 * DAY_MS));
      return deadline > bookedAt ? deadline : null;
    },
    refundNights: ({ hoursBefore, hoursSinceBooking, nightsKobo }) =>
      hoursSinceBooking <= 48 && hoursBefore >= 14 * 24 ? nightsKobo
        : hoursBefore >= 7 * 24 ? Math.round(nightsKobo * 0.5) : 0,
  },
};
const POLICY_NAMES = Object.keys(POLICIES);

// What a guest sees on the listing/quote: the rule and the free-cancellation deadline.
function describePolicy(policyName, { checkIn, checkInTime, bookedAt = new Date() }) {
  const policy = POLICIES[policyName] || POLICIES.flexible;
  const deadline = policy.freeUntil(lagosDateTime(checkIn, checkInTime), bookedAt);
  return {
    policy: POLICIES[policyName] ? policyName : 'flexible',
    label: policy.label,
    // null = there's no point (any more) at which cancelling is free
    freeCancellationUntil: deadline && deadline > bookedAt ? deadline : null,
    summary: `${policy.summary} The cleaning fee is refunded if you cancel before check-in, and the security deposit is always returned unless the host makes an approved damage claim.`,
  };
}

// ── Commission ──
// Shortlet commission is ONLY the per-landlord value a super admin sets. If
// none is set, the platform keeps everything (same default as other payments).
async function getShortletCommissionPercent(hostUserId, transaction) {
  if (!hostUserId) return 100;
  const host = await Users.findByPk(hostUserId, { attributes: ['id', 'commission_percent'], transaction });
  const pct = Number(host?.commission_percent);
  if (host?.commission_percent === null || host?.commission_percent === undefined) return 100;
  return Number.isFinite(pct) && pct >= 0 && pct <= 100 ? pct : 100;
}

// Host share rounded to the kobo; the platform keeps the remainder, so the
// two parts always sum exactly to the base.
function splitKobo(baseKobo, commissionPercent) {
  const pct = Math.min(100, Math.max(0, Number(commissionPercent) || 0));
  const hostKobo = Math.round(baseKobo * (100 - pct) / 100);
  return { hostKobo, platformKobo: baseKobo - hostKobo };
}

// ── Wallet moves (inside a transaction) ──
// creditWallet returns the wallet, or null if the user has no active wallet.
async function creditWallet({ userId, amountKobo, type, role = null, narration, fromName, meta, refs }, t) {
  if (!userId || amountKobo <= 0) return null;
  const wallet = await Wallet.findOne({ where: { user_id: userId }, transaction: t, lock: t.LOCK.UPDATE });
  if (!wallet || wallet.status !== 'ACTIVE') return null;

  await applyKoboDelta(wallet, amountKobo, t);
  const tx_ref = `RENTULO-${type.replace(/[\s_]+/g, '').toUpperCase()}-${crypto.randomUUID()}`;
  if (Array.isArray(refs)) refs.push(tx_ref);
  await WalletTransactions.create({
    wallet_id: wallet.id,
    user_id: userId,
    tx_ref,
    type,
    role,
    amount: fromKobo(amountKobo),
    status: 'success',
    narration,
    from_account_name: fromName || 'RentULO',
    to_account_number: wallet.accountNumber,
    to_account_name: wallet.accountName,
    meta,
  }, { transaction: t });
  return wallet;
}

// debitWallet throws InsufficientBalanceError (nothing written) if the user
// can't cover it, and returns null if they have no active wallet.
async function debitWallet({ userId, amountKobo, type, role = 'payer', narration, meta, refs }, t) {
  if (!userId || amountKobo <= 0) return null;
  const wallet = await Wallet.findOne({ where: { user_id: userId }, transaction: t, lock: t.LOCK.UPDATE });
  if (!wallet || wallet.status !== 'ACTIVE') return null;

  await applyKoboDelta(wallet, -amountKobo, t);
  const tx_ref = `RENTULO-${type.replace(/[\s_]+/g, '').toUpperCase()}-${crypto.randomUUID()}`;
  if (Array.isArray(refs)) refs.push(tx_ref);
  await WalletTransactions.create({
    wallet_id: wallet.id,
    user_id: userId,
    tx_ref,
    type,
    role,
    amount: fromKobo(amountKobo),
    status: 'success',
    narration,
    from_account_number: wallet.accountNumber,
    from_account_name: wallet.accountName,
    to_account_name: 'RentULO',
    meta,
  }, { transaction: t });
  return wallet;
}

function lockBooking(bookingId, t) {
  return ShortletBookings.findByPk(bookingId, { transaction: t, lock: t.LOCK.UPDATE });
}

// ─────────────────────────────────────────────
// Payout — credit the host once payout_due_at has passed
// ─────────────────────────────────────────────
async function payoutBooking(bookingId, now = new Date()) {
  return withTransaction(async (t) => {
    const booking = await lockBooking(bookingId, t);
    if (!booking) return { skipped: 'not_found' };
    if (!['confirmed', 'completed'].includes(booking.status)) return { skipped: 'not_active' };
    if (booking.payout_status !== 'pending') return { skipped: 'already_settled' };
    if (!booking.payout_due_at || new Date(booking.payout_due_at) > now) return { skipped: 'not_due' };

    const hostKobo = toKobo(booking.host_payout);
    if (hostKobo > 0) {
      const wallet = await creditWallet({
        userId: booking.host_id,
        amountKobo: hostKobo,
        type: 'shortlet booking',
        role: 'landlord',
        narration: `Shortlet payout: ${booking.nights} night(s) from ${booking.check_in}`,
        meta: { booking_id: booking.id, commissionPercent: Number(booking.commission_percent), platformShare: Number(booking.platform_fee), landlordShare: Number(booking.host_payout) },
      }, t);
      if (!wallet) {
        // Leave it pending so it's retried once the host has an active wallet.
        logger.warn('Shortlet payout deferred: host has no active wallet', { booking_id: booking.id, host_id: booking.host_id });
        return { skipped: 'host_wallet_unavailable' };
      }
      // A payout first pays off anything the host owes from a past refund.
      await recoverHostDebt(booking.host_id, wallet, t);
    }

    booking.payout_status = 'paid';
    booking.paid_out_at = now;
    await booking.save({ transaction: t });
    return { paid: true, booking };
  }, { context: 'shortletPayout', bookingId });
}

// ─────────────────────────────────────────────
// Completion — mark the stay finished once check-out time passes.
// (The deposit is released separately, after the claim window.)
// ─────────────────────────────────────────────
async function completeBooking(bookingId, now = new Date()) {
  return withTransaction(async (t) => {
    const booking = await lockBooking(bookingId, t);
    if (!booking) return { skipped: 'not_found' };
    if (booking.status !== 'confirmed') return { skipped: 'not_active' };
    if (checkOutAt(booking) > now) return { skipped: 'not_due' };

    booking.status = 'completed';
    booking.completed_at = now;
    await booking.save({ transaction: t });
    return { completed: true, booking };
  }, { context: 'shortletComplete', bookingId });
}

// ─────────────────────────────────────────────
// Deposit release — refund the deposit once the claim window closes
// with no claim filed
// ─────────────────────────────────────────────
async function releaseDeposit(bookingId, now = new Date()) {
  return withTransaction(async (t) => {
    const booking = await lockBooking(bookingId, t);
    if (!booking) return { skipped: 'not_found' };
    if (booking.deposit_status !== 'held') return { skipped: 'not_held' };
    if (booking.status === 'confirmed') return { skipped: 'stay_not_finished' };
    if (!booking.deposit_refund_due_at || new Date(booking.deposit_refund_due_at) > now) return { skipped: 'not_due' };

    const depositKobo = toKobo(booking.security_deposit);
    const wallet = await creditWallet({
      userId: booking.user_id,
      amountKobo: depositKobo,
      type: 'refund_payment',
      narration: `Security deposit refund for your stay from ${booking.check_in}`,
      meta: { booking_id: booking.id, reason: 'security_deposit' },
    }, t);
    if (!wallet && depositKobo > 0) {
      logger.warn('Deposit release deferred: guest has no active wallet', { booking_id: booking.id });
      return { skipped: 'guest_wallet_unavailable' };
    }
    booking.deposit_status = 'refunded';
    booking.refunded_amount = fromKobo(toKobo(booking.refunded_amount) + depositKobo);
    await booking.save({ transaction: t });
    return { released: true, booking };
  }, { context: 'shortletDepositRelease', bookingId });
}

// ─────────────────────────────────────────────
// Cancellation terms — what happens if `cancelledBy` cancels at `now`
// ─────────────────────────────────────────────
//
// Two engines:
//  - 'standard' bookings (the RentULO policy): rules come from the booking's
//    own cancellation_policy_snapshot, so admin changes never affect it.
//      before check-in, guest → grace period, else the matching window %
//      during the stay, guest → early check-out: the guest picks the day they
//        leave; each unused night is refunded in full only if the listing
//        allows it AND the guest gave at least `noticeHours` before that
//        night's check-out time. Nights already used are never refunded.
//  - legacy bookings (flexible/moderate/firm/strict): unchanged maths.
// A host cancelling is always a full refund of everything not yet used.

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function isValidDateOnly(v) {
  if (typeof v !== 'string' || !DATE_RE.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS);
const round2 = (n) => Math.round(n * 100) / 100;

// The days a guest can choose to leave on, if they check out early now.
// Earliest: today if it's still before today's check-out time, otherwise
// tomorrow — and never before the first night has been used.
// Latest: the day before their original check-out.
function checkOutDateRange(booking, now = new Date()) {
  const today = todayInLagos(now);
  const base = now < lagosDateTime(today, booking.check_out_time) ? today : addDays(today, 1);
  const firstPossible = addDays(booking.check_in, 1);
  const earliest = base > firstPossible ? base : firstPossible;
  const latest = addDays(booking.check_out, -1);
  return { earliest, latest, available: earliest <= latest };
}

function isStandardBooking(booking) {
  return booking.cancellation_policy === 'standard' && !!booking.cancellation_policy_snapshot?.rules;
}

function cancellationTerms(booking, cancelledBy, now = new Date(), { checkOutDate } = {}) {
  if (booking.status !== 'confirmed') {
    throw new BookingActionError(400, 'Only confirmed bookings can be cancelled', 'NOT_CANCELLABLE');
  }
  const inAt = checkInAt(booking);
  const outAt = checkOutAt(booking);
  if (now >= outAt) {
    throw new BookingActionError(400, 'This stay has already ended and can no longer be cancelled', 'STAY_ENDED');
  }

  const standard = isStandardBooking(booking);
  const snapshot = standard ? booking.cancellation_policy_snapshot : null;
  const policyName = standard ? 'standard' : (POLICIES[booking.cancellation_policy] ? booking.cancellation_policy : 'flexible');
  const legacy = POLICIES[policyName];
  const nights = Number(booking.nights);
  const nightKobo = toKobo(booking.price_per_night);
  const nightsKobo = nightKobo * nights;
  const cleaningKobo = toKobo(booking.cleaning_fee);
  const depositHeld = booking.deposit_status === 'held';
  const depositKobo = depositHeld ? toKobo(booking.security_deposit) : 0;
  const bookedAt = new Date(booking.createdAt || now);
  const hoursBefore = (inAt - now) / HOUR_MS;
  const hoursSinceBooking = (now - bookedAt) / HOUR_MS;

  let stage, rule, refundPercent, nightsRefundKobo, cleaningRefundKobo, depositRefundNowKobo;
  let usedNights = null, chargedNights = null, refundedNights = null, actualCheckOut = null;
  let noticeHours = null, earlyCheckoutRefundable = null, checkOutDateOptions = null;

  if (now < inAt) {
    stage = 'before_check_in';
    if (cancelledBy === 'host') {
      rule = 'host_cancelled';
      refundPercent = 100;
      nightsRefundKobo = nightsKobo;
    } else if (standard) {
      const r = preCheckInPercent(snapshot.rules, { hoursBefore, hoursSinceBooking });
      rule = r.rule; // 'grace_period' | 'cancellation_window'
      refundPercent = r.percent;
      nightsRefundKobo = Math.round(nightsKobo * r.percent / 100);
    } else {
      rule = 'legacy_policy';
      nightsRefundKobo = legacy.refundNights({ hoursBefore, hoursSinceBooking, nightsKobo, nightKobo });
      refundPercent = nightsKobo ? round2(nightsRefundKobo * 100 / nightsKobo) : 0;
    }
    cleaningRefundKobo = cleaningKobo;   // no cleaning service provided yet
    depositRefundNowKobo = depositKobo;  // no stay, nothing to claim
  } else {
    stage = 'during_stay';
    if (cancelledBy === 'host') {
      // Host ending the stay keeps only the nights that have started.
      rule = 'host_cancelled';
      usedNights = Math.min(nights, Math.max(1, Math.ceil((now.getTime() - inAt.getTime()) / DAY_MS)));
      chargedNights = usedNights;
      refundedNights = nights - usedNights;
      nightsRefundKobo = refundedNights * nightKobo;
      refundPercent = 100;
      actualCheckOut = addDays(booking.check_in, usedNights);
    } else if (standard) {
      rule = 'early_checkout';
      noticeHours = Number(snapshot.rules.earlyCheckout?.noticeHours ?? 24);
      earlyCheckoutRefundable = !!snapshot.earlyCheckoutRefundable;
      const range = checkOutDateRange(booking, now);
      checkOutDateOptions = { earliest: range.earliest, latest: range.latest };
      if (!range.available) {
        throw new BookingActionError(400, `Your stay ends on ${booking.check_out}, so there are no nights left to cancel.`, 'NO_UNUSED_NIGHTS');
      }
      const dep = checkOutDate === undefined || checkOutDate === null || checkOutDate === '' ? range.earliest : checkOutDate;
      if (!isValidDateOnly(dep)) {
        throw new BookingActionError(400, 'checkOutDate must be a date in YYYY-MM-DD format', 'INVALID_CHECKOUT_DATE');
      }
      if (dep < range.earliest) {
        throw new BookingActionError(400, `The earliest you can check out is ${range.earliest}`, 'INVALID_CHECKOUT_DATE');
      }
      if (dep > range.latest) {
        throw new BookingActionError(400, `checkOutDate must be before your original check-out date (${booking.check_out})`, 'INVALID_CHECKOUT_DATE');
      }
      usedNights = daysBetween(booking.check_in, dep);
      // Unused nights are the dates from the new departure day up to the
      // original check-out. Each is refundable only with enough notice,
      // measured to that night's check-out time.
      const unused = [];
      for (let i = usedNights; i < nights; i++) unused.push(addDays(booking.check_in, i));
      const refundable = earlyCheckoutRefundable
        ? unused.filter((d) => now.getTime() <= lagosDateTime(d, booking.check_out_time).getTime() - noticeHours * HOUR_MS)
        : [];
      refundedNights = refundable.length;
      chargedNights = nights - refundedNights;
      nightsRefundKobo = refundedNights * nightKobo;
      refundPercent = earlyCheckoutRefundable ? 100 : 0;
      actualCheckOut = dep;
    } else {
      // Legacy guest early check-out: night in progress + next 24h count as used.
      rule = 'legacy_policy';
      const effectiveEnd = now.getTime() + MID_STAY_GUEST_BUFFER_MS;
      usedNights = Math.min(nights, Math.max(1, Math.ceil((effectiveEnd - inAt.getTime()) / DAY_MS)));
      chargedNights = usedNights;
      refundPercent = legacy.midStayPercent;
      nightsRefundKobo = Math.round((nights - usedNights) * nightKobo * refundPercent / 100);
      refundedNights = nights - usedNights;
      actualCheckOut = addDays(booking.check_in, usedNights);
    }
    cleaningRefundKobo = 0;   // the stay started: cleaning is needed anyway
    depositRefundNowKobo = 0; // held for the 48h claim window after they leave
  }

  const refundKobo = nightsRefundKobo + cleaningRefundKobo + depositRefundNowKobo;
  const retainedKobo = nightsKobo + cleaningKobo - nightsRefundKobo - cleaningRefundKobo;
  const { hostKobo, platformKobo } = splitKobo(retainedKobo, booking.commission_percent);

  const freeCancellationUntil = standard
    ? describeStandardPolicy(snapshot.rules, { checkInAt: inAt, bookedAt, earlyCheckoutRefundable: snapshot.earlyCheckoutRefundable, now: bookedAt }).freeCancellationUntil
    : describePolicy(policyName, { checkIn: booking.check_in, checkInTime: booking.check_in_time, bookedAt }).freeCancellationUntil;

  return {
    policy: policyName,
    policyVersion: standard ? (snapshot.version ?? booking.cancellation_policy_version ?? null) : null,
    stage,
    rule,
    cancelledBy,
    refundPercent,
    hoursBeforeCheckIn: round2(hoursBefore),
    fullRefund: retainedKobo === 0,
    refundKobo,
    refundAmount: fromKobo(refundKobo),
    nonRefundableAmount: fromKobo(retainedKobo),
    depositHeldForClaims: stage === 'during_stay' && depositHeld,
    usedNights,
    chargedNights,
    refundedNights,
    actualCheckOut,
    noticeHours,
    earlyCheckoutRefundable,
    checkOutDateOptions,
    hostKobo,
    platformKobo,
    retainedKobo,
    nightsRefundKobo,
    cleaningRefundKobo,
    depositRefundNowKobo,
    freeCancellationUntil,
  };
}

// The guest/host-facing view of the terms (cancel dialog, REFUND_CHANGED).
function presentTerms(terms, booking) {
  return {
    canCancel: true,
    policy: terms.policy,
    policyVersion: terms.policyVersion,
    stage: terms.stage,
    rule: terms.rule,
    refundPercent: terms.refundPercent,
    hoursBeforeCheckIn: terms.hoursBeforeCheckIn,
    refundAmount: terms.refundAmount,
    nonRefundableAmount: terms.nonRefundableAmount,
    breakdown: {
      nightsRefund: fromKobo(terms.nightsRefundKobo),
      cleaningFeeRefund: fromKobo(terms.cleaningRefundKobo),
      securityDepositRefund: fromKobo(terms.depositRefundNowKobo),
      securityDepositHeldForClaims: terms.depositHeldForClaims ? fromKobo(toKobo(booking.security_deposit)) : '0.00',
    },
    nights: { total: Number(booking.nights), used: terms.usedNights, charged: terms.chargedNights, refunded: terms.refundedNights },
    actualCheckOut: terms.actualCheckOut,
    checkOutDateOptions: terms.checkOutDateOptions,
    noticeHours: terms.noticeHours,
    earlyCheckoutRefundable: terms.earlyCheckoutRefundable,
    depositHeldForClaims: terms.depositHeldForClaims,
    freeCancellationUntil: terms.freeCancellationUntil,
  };
}

// ─────────────────────────────────────────────
// Cancel — refund the guest and settle the host's share (works before
// check-in and during the stay)
// ─────────────────────────────────────────────
async function cancelBooking({ bookingId, actorUserId, reason, checkOutDate, expectedRefundAmount, now = new Date() }) {
  return withTransaction(async (t) => {
    const booking = await lockBooking(bookingId, t);
    if (!booking) throw new BookingActionError(404, 'Booking not found', 'NOT_FOUND');

    let cancelledBy;
    if (booking.user_id === actorUserId) cancelledBy = 'guest';
    else if (booking.host_id && booking.host_id === actorUserId) cancelledBy = 'host';
    else throw new BookingActionError(403, 'You are not allowed to cancel this booking', 'FORBIDDEN');

    const terms = cancellationTerms(booking, cancelledBy, now, { checkOutDate });

    // The guest confirmed a specific amount. If time moved them into another
    // window (or anything else changed it), stop and show the new figures.
    if (expectedRefundAmount !== undefined && expectedRefundAmount !== null && expectedRefundAmount !== '') {
      if (!/^\d+(\.\d{1,2})?$/.test(String(expectedRefundAmount).trim())) {
        throw new BookingActionError(400, 'expectedRefundAmount must be an amount like "27000.00"', 'INVALID_EXPECTED_REFUND');
      }
      if (toKobo(expectedRefundAmount) !== terms.refundKobo) {
        throw new BookingActionError(409, 'The refund for this cancellation has changed since it was shown to you. Please review the new amount and confirm again.',
          'REFUND_CHANGED', { cancellation: presentTerms(terms, booking) });
      }
    }

    // The host may already have been paid (24h after check-in). Compare the
    // host's correct total with what they already have — one absolute
    // comparison, so nothing can be deducted twice.
    const alreadyPaidKobo = booking.payout_status === 'paid' ? toKobo(booking.host_payout) : 0;
    const deltaKobo = terms.hostKobo - alreadyPaidKobo;

    const refs = [];
    let debtKobo = 0, debtId = null, takenBackKobo = 0;
    // Lock wallets in a fixed order (by user id) to avoid deadlocks.
    const steps = [
      { id: booking.user_id, run: async () => {
        const w = await creditWallet({
          userId: booking.user_id,
          amountKobo: terms.refundKobo,
          type: 'refund_payment',
          narration: terms.stage === 'during_stay'
            ? `Refund for unused nights (checked out early on ${terms.actualCheckOut})`
            : `Refund for cancelled shortlet booking (${booking.check_in} to ${booking.check_out})`,
          meta: { booking_id: booking.id, reason: 'cancellation', cancelled_by: cancelledBy, stage: terms.stage, rule: terms.rule },
          refs,
        }, t);
        if (terms.refundKobo > 0 && !w) {
          throw new BookingActionError(400, 'The guest wallet is not available for a refund. Please contact support.', 'WALLET_UNAVAILABLE');
        }
      } },
      { id: booking.host_id || '', run: async () => {
        if (deltaKobo > 0) {
          const w = await creditWallet({
            userId: booking.host_id,
            amountKobo: deltaKobo,
            type: 'shortlet booking',
            role: 'landlord',
            narration: `Shortlet cancellation payout (non-refundable part) from ${booking.check_in}`,
            meta: { booking_id: booking.id, commissionPercent: Number(booking.commission_percent) },
            refs,
          }, t);
          return w ? deltaKobo : 0;
        }
        if (deltaKobo < 0) {
          // Take back what the host's wallet holds now; anything it can't
          // cover becomes a host debt, recovered automatically from their
          // future income. The guest is refunded in full either way.
          const needKobo = -deltaKobo;
          const hostWallet = booking.host_id
            ? await Wallet.findOne({ where: { user_id: booking.host_id }, transaction: t, lock: t.LOCK.UPDATE })
            : null;
          const availableKobo = hostWallet && hostWallet.status === 'ACTIVE' ? Math.max(0, toKobo(hostWallet.balance)) : 0;
          takenBackKobo = Math.min(availableKobo, needKobo);
          if (takenBackKobo > 0) {
            await debitWallet({
              userId: booking.host_id,
              amountKobo: takenBackKobo,
              type: 'shortlet booking',
              role: 'payer',
              narration: `Returned to guest: refunded nights for the stay from ${booking.check_in}`,
              meta: { booking_id: booking.id, reason: 'cancellation_clawback', cancelled_by: cancelledBy },
              refs,
            }, t);
          }
          const oweKobo = needKobo - takenBackKobo;
          if (oweKobo > 0 && booking.host_id) {
            const debt = await createHostDebt({
              hostId: booking.host_id,
              bookingId: booking.id,
              amountKobo: oweKobo,
              reason: `Refund for unused nights (stay from ${booking.check_in} ended early)`,
            }, t);
            debtKobo = oweKobo;
            debtId = debt?.id || null;
          }
          return deltaKobo;
        }
        return 0;
      } },
    ].sort((a, b) => String(a.id).localeCompare(String(b.id)));

    let hostChangeKobo = 0;
    for (const step of steps) {
      const r = await step.run();
      if (typeof r === 'number') hostChangeKobo = r;
    }
    if (deltaKobo > 0 && hostChangeKobo === 0) {
      logger.warn('Host share of cancelled booking not credited: host has no active wallet', { booking_id: booking.id });
    }
    const hostFinalKobo = alreadyPaidKobo + hostChangeKobo;
    const cleanReason = reason ? String(reason).slice(0, 1000) : null;

    booking.status = 'cancelled';
    booking.cancelled_at = now;
    booking.cancelled_by = cancelledBy;
    booking.cancellation_reason = cleanReason;
    booking.refunded_amount = fromKobo(toKobo(booking.refunded_amount) + terms.refundKobo);
    booking.host_payout = fromKobo(hostFinalKobo);
    booking.platform_fee = fromKobo(terms.retainedKobo - hostFinalKobo);
    booking.payout_status = hostFinalKobo > 0 ? 'paid' : 'cancelled';
    booking.paid_out_at = hostFinalKobo > 0 ? (booking.paid_out_at || now) : null;
    if (terms.stage === 'during_stay') {
      booking.actual_check_out = terms.actualCheckOut;
      // The host can still claim the deposit for 48h after the guest leaves.
      if (booking.deposit_status === 'held') {
        booking.deposit_refund_due_at = new Date(Math.max(now.getTime(), lagosDateTime(terms.actualCheckOut, booking.check_out_time).getTime()) + DEPOSIT_CLAIM_WINDOW_MS);
      }
    } else if (booking.deposit_status === 'held') {
      booking.deposit_status = 'refunded';
    }

    // Audit record — written in the same transaction as the money.
    booking.cancellation_details = {
      cancelledBy,
      cancelledByUserId: actorUserId,
      cancelledAt: now,
      reason: cleanReason,
      policy: terms.policy,
      policyVersion: terms.policyVersion,
      stage: terms.stage,
      rule: terms.rule,
      hoursBeforeCheckIn: terms.hoursBeforeCheckIn,
      refundPercent: terms.refundPercent,
      nights: { total: Number(booking.nights), used: terms.usedNights, charged: terms.chargedNights, refunded: terms.refundedNights },
      actualCheckOut: terms.actualCheckOut,
      noticeHours: terms.noticeHours,
      earlyCheckoutRefundable: terms.earlyCheckoutRefundable,
      commissionPercent: Number(booking.commission_percent),
      amounts: {
        originalTotal: booking.total_amount,
        accommodation: fromKobo(toKobo(booking.price_per_night) * Number(booking.nights)),
        cleaningFee: booking.cleaning_fee,
        securityDeposit: booking.security_deposit,
        nightsRefund: fromKobo(terms.nightsRefundKobo),
        cleaningFeeRefund: fromKobo(terms.cleaningRefundKobo),
        securityDepositRefund: fromKobo(terms.depositRefundNowKobo),
        securityDepositHeldForClaims: terms.depositHeldForClaims ? booking.security_deposit : '0.00',
        totalRefund: fromKobo(terms.refundKobo),
        retained: fromKobo(terms.retainedKobo),
        hostShare: fromKobo(hostFinalKobo),
        platformShare: fromKobo(terms.retainedKobo - hostFinalKobo),
        alreadyPaidToHost: fromKobo(alreadyPaidKobo),
        takenBackFromHost: fromKobo(takenBackKobo),
        hostDebtCreated: fromKobo(debtKobo),
      },
      hostDebtId: debtId,
      transactionRefs: refs,
    };
    await booking.save({ transaction: t });

    return { booking, cancelledBy, terms, debtKobo };
  }, { context: 'shortletCancel', bookingId, actorUserId });
}

// ─────────────────────────────────────────────
// Deposit claims
// ─────────────────────────────────────────────
function parseAmountKobo(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  if (!/^\d+(\.\d{1,2})?$/.test(String(raw).trim())) return NaN;
  return toKobo(raw);
}

const MAX_CLAIM_PHOTOS = 5;

// Every rule for filing a deposit claim, in one place. Used by the controller
// BEFORE uploading photos (so nothing is uploaded for a claim that can't be
// filed) and again inside the transaction. Returns { claimKobo, text }.
// `photoCount` is checked here; the uploaded URLs are checked in fileDepositClaim.
function validateDepositClaim(booking, { hostUserId, amount, reason, photoCount, now = new Date() }) {
  if (!booking) throw new BookingActionError(404, 'Booking not found', 'NOT_FOUND');
  if (booking.host_id !== hostUserId) throw new BookingActionError(403, 'Only the host can claim this deposit', 'FORBIDDEN');

  if (booking.deposit_status === 'none') throw new BookingActionError(400, 'This booking has no security deposit', 'NO_DEPOSIT');
  if (booking.deposit_status === 'claimed') throw new BookingActionError(400, 'A claim has already been filed for this deposit', 'CLAIM_EXISTS');
  if (booking.deposit_status !== 'held') throw new BookingActionError(400, 'The deposit has already been returned or settled', 'CLAIM_WINDOW_CLOSED');
  if (now < checkInAt(booking)) throw new BookingActionError(400, 'You can only file a claim once the stay has started', 'STAY_NOT_STARTED');
  if (booking.deposit_refund_due_at && now > new Date(booking.deposit_refund_due_at)) {
    throw new BookingActionError(400, 'The 48-hour claim window after check-out has closed', 'CLAIM_WINDOW_CLOSED');
  }

  const depositKobo = toKobo(booking.security_deposit);
  const claimKobo = parseAmountKobo(amount);
  if (claimKobo === null || Number.isNaN(claimKobo) || claimKobo <= 0 || claimKobo > depositKobo) {
    throw new BookingActionError(400, `amount must be more than 0 and at most the deposit (₦${Number(booking.security_deposit).toLocaleString()})`, 'INVALID_AMOUNT');
  }
  const text = typeof reason === 'string' ? reason.trim() : '';
  if (text.length < 10 || text.length > 2000) {
    throw new BookingActionError(400, 'reason must describe the damage or issue (10–2000 characters)', 'INVALID_REASON');
  }
  if (!Number.isInteger(photoCount) || photoCount < 1 || photoCount > MAX_CLAIM_PHOTOS) {
    throw new BookingActionError(400, `Attach 1 to ${MAX_CLAIM_PHOTOS} photos of the damage as "photos"`, 'INVALID_PHOTOS');
  }
  return { claimKobo, text };
}

// Host files a claim on the deposit (damage, missing items, extra cleaning).
// `photos` are the already-uploaded image URLs (evidence shown to guest + admin).
async function fileDepositClaim({ bookingId, hostUserId, amount, reason, photos, now = new Date() }) {
  const urls = Array.isArray(photos) ? photos.filter((u) => typeof u === 'string' && /^https?:\/\//.test(u)) : [];
  return withTransaction(async (t) => {
    const booking = await lockBooking(bookingId, t);
    const { claimKobo, text } = validateDepositClaim(booking, {
      hostUserId, amount, reason, photoCount: urls.length === (photos || []).length ? urls.length : -1, now,
    });

    booking.deposit_status = 'claimed';
    booking.deposit_claim_amount = fromKobo(claimKobo);
    booking.deposit_claim_reason = text;
    booking.deposit_claim_photos = urls;
    booking.deposit_claimed_at = now;
    await booking.save({ transaction: t });
    return { booking };
  }, { context: 'shortletDepositClaim', bookingId, hostUserId });
}

// Super admin decides a claim. approve → `amount` (default: the full claim,
// never more) goes to the host, the rest of the deposit back to the guest.
// reject → the whole deposit goes back to the guest.
async function resolveDepositClaim({ bookingId, decision, amount, note, now = new Date() }) {
  if (!['approve', 'reject'].includes(decision)) {
    throw new BookingActionError(400, "decision must be 'approve' or 'reject'", 'INVALID_DECISION');
  }
  return withTransaction(async (t) => {
    const booking = await lockBooking(bookingId, t);
    if (!booking) throw new BookingActionError(404, 'Booking not found', 'NOT_FOUND');
    if (booking.deposit_status !== 'claimed') throw new BookingActionError(400, 'There is no open deposit claim on this booking', 'NO_OPEN_CLAIM');

    const depositKobo = toKobo(booking.security_deposit);
    const claimKobo = toKobo(booking.deposit_claim_amount);
    let awardKobo = 0;
    if (decision === 'approve') {
      const requested = parseAmountKobo(amount);
      awardKobo = requested === null ? claimKobo : requested;
      if (Number.isNaN(awardKobo) || awardKobo <= 0 || awardKobo > claimKobo) {
        throw new BookingActionError(400, `amount must be more than 0 and at most the claimed ₦${Number(booking.deposit_claim_amount).toLocaleString()}`, 'INVALID_AMOUNT');
      }
    }
    const guestKobo = depositKobo - awardKobo;

    const steps = [
      { id: booking.user_id, run: async () => {
        if (guestKobo <= 0) return;
        const w = await creditWallet({
          userId: booking.user_id,
          amountKobo: guestKobo,
          type: 'refund_payment',
          narration: awardKobo > 0
            ? `Security deposit refund (after a host claim of ₦${Number(fromKobo(awardKobo)).toLocaleString()})`
            : 'Security deposit refund (host claim rejected)',
          meta: { booking_id: booking.id, reason: 'security_deposit', claim_decision: decision },
        }, t);
        if (!w) throw new BookingActionError(400, 'The guest wallet is not available. Resolve this manually.', 'WALLET_UNAVAILABLE');
      } },
      { id: booking.host_id || '', run: async () => {
        if (awardKobo <= 0) return;
        const w = await creditWallet({
          userId: booking.host_id,
          amountKobo: awardKobo,
          type: 'shortlet booking',
          role: 'landlord',
          narration: `Security deposit claim approved for the stay from ${booking.check_in}`,
          meta: { booking_id: booking.id, reason: 'deposit_claim' },
        }, t);
        if (!w) throw new BookingActionError(400, 'The host wallet is not available. Resolve this manually.', 'WALLET_UNAVAILABLE');
      } },
    ].sort((a, b) => String(a.id).localeCompare(String(b.id)));
    for (const step of steps) await step.run();

    booking.deposit_claim_decision = decision === 'reject' ? 'rejected' : awardKobo === claimKobo ? 'approved' : 'partially_approved';
    booking.deposit_claim_note = note ? String(note).slice(0, 2000) : null;
    booking.deposit_claim_resolved_at = now;
    booking.deposit_paid_to_host = fromKobo(awardKobo);
    booking.refunded_amount = fromKobo(toKobo(booking.refunded_amount) + guestKobo);
    booking.deposit_status = awardKobo > 0 ? 'settled' : 'refunded';
    await booking.save({ transaction: t });
    return { booking, awardKobo, guestKobo };
  }, { context: 'shortletDepositResolve', bookingId, decision });
}

// ─────────────────────────────────────────────
// Scheduled job — pay due hosts, complete finished stays, release deposits
// ─────────────────────────────────────────────
async function runShortletSettlement(now = new Date()) {
  const summary = { paid: 0, completed: 0, depositsReleased: 0, debtsRecoveredKobo: 0, skipped: 0, failed: 0 };

  const run = async (ids, fn, key, label) => {
    for (const { id } of ids) {
      try {
        const r = await fn(id, now);
        r[key] ? summary[label]++ : summary.skipped++;
      } catch (error) {
        summary.failed++;
        logger.error(`Shortlet settlement step failed (${label})`, { booking_id: id, error: error.message });
      }
    }
  };

  await run(await ShortletBookings.findAll({
    attributes: ['id'],
    where: { status: { [Op.in]: ['confirmed', 'completed'] }, payout_status: 'pending', payout_due_at: { [Op.lte]: now } },
    limit: 200,
  }), payoutBooking, 'paid', 'paid');

  // check_out <= today narrows the scan; completeBooking re-checks the exact time.
  await run(await ShortletBookings.findAll({
    attributes: ['id'],
    where: { status: 'confirmed', check_out: { [Op.lte]: todayInLagos(now) } },
    limit: 200,
  }), completeBooking, 'completed', 'completed');

  await run(await ShortletBookings.findAll({
    attributes: ['id'],
    where: { deposit_status: 'held', status: { [Op.ne]: 'confirmed' }, deposit_refund_due_at: { [Op.lte]: now } },
    limit: 200,
  }), releaseDeposit, 'released', 'depositsReleased');

  // Sweep host debts: any money that landed in a debtor's wallet since the
  // last run (top-ups, rent/lock income, transfers in, …) pays them off.
  for (const hostId of await hostsWithOpenDebts()) {
    try {
      summary.debtsRecoveredKobo += await withTransaction(async (t) => {
        const w = await Wallet.findOne({ where: { user_id: hostId }, transaction: t, lock: t.LOCK.UPDATE });
        return recoverHostDebt(hostId, w, t);
      }, { context: 'hostDebtSweep', hostId });
    } catch (error) {
      summary.failed++;
      logger.error('Host debt recovery failed', { host_id: hostId, error: error.message });
    }
  }

  if (summary.paid || summary.completed || summary.depositsReleased || summary.debtsRecoveredKobo || summary.failed) {
    logger.info('Shortlet settlement run', summary);
  }
  return summary;
}

module.exports = {
  PAYOUT_DELAY_MS,
  DEPOSIT_CLAIM_WINDOW_MS,
  POLICIES,
  POLICY_NAMES,
  BookingActionError,
  todayInLagos,
  lagosDateTime,
  addDays,
  checkInAt,
  checkOutAt,
  describePolicy,
  getShortletCommissionPercent,
  splitKobo,
  cancellationTerms,
  presentTerms,
  checkOutDateRange,
  isStandardBooking,
  payoutBooking,
  completeBooking,
  releaseDeposit,
  cancelBooking,
  MAX_CLAIM_PHOTOS,
  validateDepositClaim,
  fileDepositClaim,
  resolveDepositClaim,
  runShortletSettlement,
};
