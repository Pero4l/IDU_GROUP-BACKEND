'use strict';

// RentULO standard cancellation policy — settings, validation and the
// guest-facing description.
//
// The rules live in `shortlet_cancellation_policies` (one row per version;
// super admins add versions, nothing is edited in place). Each new booking
// copies the active version's rules into its own snapshot, so later changes
// never affect existing bookings.
//
// Rules shape:
//   {
//     preCheckIn:   { tiers: [ { minHoursBefore, nightsRefundPercent }, ... ] },
//     gracePeriod:  { enabled, withinHoursOfBooking, minHoursBeforeCheckIn },
//     earlyCheckout:{ noticeHours }
//   }
// Tiers are matched from the largest minHoursBefore down; the first tier whose
// threshold the cancellation meets applies. A tier at 0 is required, so every
// moment before check-in is covered exactly once (no gaps, no overlaps).

const HOUR_MS = 60 * 60 * 1000;

const DEFAULT_RULES = Object.freeze({
  preCheckIn: {
    tiers: [
      { minHoursBefore: 168, nightsRefundPercent: 100 },
      { minHoursBefore: 72, nightsRefundPercent: 50 },
      { minHoursBefore: 0, nightsRefundPercent: 0 },
    ],
  },
  gracePeriod: { enabled: true, withinHoursOfBooking: 24, minHoursBeforeCheckIn: 72 },
  earlyCheckout: { noticeHours: 24 },
});

class PolicyValidationError extends Error {
  constructor(errors) {
    super(errors.join(' '));
    this.errors = errors;
  }
}

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/** Validates and normalises a rules object. Throws PolicyValidationError. */
function validateRules(input) {
  const errors = [];
  const r = input && typeof input === 'object' ? input : {};

  // Tiers
  const rawTiers = r.preCheckIn?.tiers;
  let tiers = [];
  if (!Array.isArray(rawTiers) || rawTiers.length < 1 || rawTiers.length > 10) {
    errors.push('preCheckIn.tiers must be a list of 1 to 10 windows.');
  } else {
    rawTiers.forEach((t, i) => {
      if (!t || !isNum(t.minHoursBefore) || t.minHoursBefore < 0 || t.minHoursBefore > 8760) {
        errors.push(`preCheckIn.tiers[${i}].minHoursBefore must be a number of hours from 0 to 8760.`);
      }
      if (!t || !isNum(t.nightsRefundPercent) || t.nightsRefundPercent < 0 || t.nightsRefundPercent > 100) {
        errors.push(`preCheckIn.tiers[${i}].nightsRefundPercent must be a number from 0 to 100.`);
      }
    });
    tiers = rawTiers
      .filter((t) => t && isNum(t.minHoursBefore) && isNum(t.nightsRefundPercent))
      .map((t) => ({ minHoursBefore: t.minHoursBefore, nightsRefundPercent: t.nightsRefundPercent }))
      .sort((a, b) => b.minHoursBefore - a.minHoursBefore);
    const seen = new Set();
    for (const t of tiers) {
      if (seen.has(t.minHoursBefore)) errors.push(`Two windows start at ${t.minHoursBefore} hours — each window needs a different start.`);
      seen.add(t.minHoursBefore);
    }
    if (tiers.length && tiers[tiers.length - 1].minHoursBefore !== 0) {
      errors.push('The last window must start at 0 hours so every moment before check-in is covered.');
    }
  }

  // Grace period
  const g = r.gracePeriod;
  if (!g || typeof g.enabled !== 'boolean') errors.push('gracePeriod.enabled must be true or false.');
  if (!g || !isNum(g.withinHoursOfBooking) || g.withinHoursOfBooking < 0 || g.withinHoursOfBooking > 720) {
    errors.push('gracePeriod.withinHoursOfBooking must be a number of hours from 0 to 720.');
  }
  if (!g || !isNum(g.minHoursBeforeCheckIn) || g.minHoursBeforeCheckIn < 0 || g.minHoursBeforeCheckIn > 8760) {
    errors.push('gracePeriod.minHoursBeforeCheckIn must be a number of hours from 0 to 8760.');
  }

  // Early check-out notice
  const e = r.earlyCheckout;
  if (!e || !isNum(e.noticeHours) || e.noticeHours < 0 || e.noticeHours > 720) {
    errors.push('earlyCheckout.noticeHours must be a number of hours from 0 to 720.');
  }

  if (errors.length) throw new PolicyValidationError(errors);
  return {
    preCheckIn: { tiers },
    gracePeriod: { enabled: g.enabled, withinHoursOfBooking: g.withinHoursOfBooking, minHoursBeforeCheckIn: g.minHoursBeforeCheckIn },
    earlyCheckout: { noticeHours: e.noticeHours },
  };
}

// ── Storage ──
function models() { return require('../models'); }

/** The policy new bookings get: { version, rules }. */
async function getActivePolicy(transaction) {
  const row = await models().ShortletCancellationPolicies.findOne({ order: [['version', 'DESC']], transaction });
  if (!row) return { version: 0, rules: JSON.parse(JSON.stringify(DEFAULT_RULES)) };
  return { version: row.version, rules: row.rules };
}

/** Saves a new version (validated). Returns the new row. */
async function savePolicy({ rules, changedBy, note }) {
  const normalised = validateRules(rules);
  const { withTransaction } = require('./rollback');
  const { ShortletCancellationPolicies, sequelize } = models();
  return withTransaction(async (t) => {
    // Serialise concurrent saves so version numbers never collide.
    await sequelize.query('LOCK TABLE "shortlet_cancellation_policies" IN SHARE ROW EXCLUSIVE MODE', { transaction: t });
    const latest = await ShortletCancellationPolicies.max('version', { transaction: t });
    return ShortletCancellationPolicies.create({
      version: (latest || 0) + 1,
      rules: normalised,
      changed_by: changedBy || null,
      note: note ? String(note).slice(0, 1000) : null,
    }, { transaction: t });
  }, { context: 'saveCancellationPolicy', changedBy });
}

// ── Engine helpers ──
/** Nights refund % before check-in for a guest. Returns { percent, rule, tier }. */
function preCheckInPercent(rules, { hoursBefore, hoursSinceBooking }) {
  const g = rules.gracePeriod;
  if (g?.enabled && hoursSinceBooking <= g.withinHoursOfBooking && hoursBefore >= g.minHoursBeforeCheckIn) {
    return { percent: 100, rule: 'grace_period', tier: null };
  }
  const tiers = [...rules.preCheckIn.tiers].sort((a, b) => b.minHoursBefore - a.minHoursBefore);
  const tier = tiers.find((t) => hoursBefore >= t.minHoursBefore) || tiers[tiers.length - 1];
  return { percent: tier.nightsRefundPercent, rule: 'cancellation_window', tier };
}

// ── Guest-facing description ──
function hoursText(h) {
  if (h === 0) return 'check-in';
  if (h % 24 === 0) return `${h / 24} day${h === 24 ? '' : 's'} (${h} hours)`;
  return `${h} hours`;
}

/**
 * Describes the policy for one stay: the windows with their actual dates,
 * the grace period deadline (if it can apply), early check-out terms, and the
 * latest moment cancelling is free.
 */
function describeStandardPolicy(rules, { checkInAt, bookedAt = new Date(), earlyCheckoutRefundable, now = new Date() }) {
  const tiers = [...rules.preCheckIn.tiers].sort((a, b) => b.minHoursBefore - a.minHoursBefore);
  const windows = tiers.map((t, i) => ({
    nightsRefundPercent: t.nightsRefundPercent,
    minHoursBeforeCheckIn: t.minHoursBefore,
    from: i === 0 ? null : new Date(checkInAt.getTime() - tiers[i - 1].minHoursBefore * HOUR_MS),
    until: new Date(checkInAt.getTime() - t.minHoursBefore * HOUR_MS),
  }));

  const g = rules.gracePeriod;
  let graceUntil = null;
  if (g?.enabled) {
    const end = new Date(Math.min(bookedAt.getTime() + g.withinHoursOfBooking * HOUR_MS, checkInAt.getTime() - g.minHoursBeforeCheckIn * HOUR_MS));
    if (end > bookedAt) graceUntil = end;
  }
  const fullTierUntil = windows.filter((w) => w.nightsRefundPercent === 100).map((w) => w.until).sort((a, b) => b - a)[0] || null;
  const freeUntilCandidates = [graceUntil, fullTierUntil].filter((d) => d && d > now);
  const freeCancellationUntil = freeUntilCandidates.length ? new Date(Math.max(...freeUntilCandidates.map((d) => d.getTime()))) : null;

  const lines = tiers.map((t, i) => {
    const pct = t.nightsRefundPercent === 100 ? 'Full refund of nights' : t.nightsRefundPercent === 0 ? 'No refund of nights' : `${t.nightsRefundPercent}% refund of nights`;
    if (i === 0) return `${pct} if you cancel at least ${hoursText(t.minHoursBefore)} before check-in.`;
    if (t.minHoursBefore === 0) return `${pct} less than ${hoursText(tiers[i - 1].minHoursBefore)} before check-in.`;
    return `${pct} from ${hoursText(t.minHoursBefore)} to ${hoursText(tiers[i - 1].minHoursBefore)} before check-in.`;
  });
  if (g?.enabled) {
    lines.unshift(`Free cancellation within ${g.withinHoursOfBooking} hours of booking, as long as check-in is at least ${hoursText(g.minHoursBeforeCheckIn)} away.`);
  }
  lines.push('The cleaning fee is refunded if you cancel before check-in, and the security deposit is always returned unless the host makes an approved damage claim.');
  const notice = rules.earlyCheckout.noticeHours;
  const earlyCheckout = {
    unusedNightsRefundable: !!earlyCheckoutRefundable,
    noticeHours: notice,
    summary: earlyCheckoutRefundable
      ? `If you check out early, unused nights are refunded in full for every night you give at least ${notice} hours' notice for (counted to that night's check-out time). Nights already used are not refunded.`
      : 'This stay is non-refundable after check-in: unused nights are not refunded if you check out early.',
  };
  lines.push(earlyCheckout.summary);

  return {
    policy: 'standard',
    label: 'RentULO Standard',
    windows,
    gracePeriod: g?.enabled ? { withinHoursOfBooking: g.withinHoursOfBooking, minHoursBeforeCheckIn: g.minHoursBeforeCheckIn, until: graceUntil } : null,
    earlyCheckout,
    freeCancellationUntil,
    summary: lines.join(' '),
  };
}

module.exports = {
  DEFAULT_RULES,
  PolicyValidationError,
  validateRules,
  getActivePolicy,
  savePolicy,
  preCheckInPercent,
  describeStandardPolicy,
};
