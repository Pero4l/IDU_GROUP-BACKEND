#!/usr/bin/env node
'use strict';
// Unit tests for the shortlet money rules and the transaction-PIN check.
// No database needed (models are stubbed).
//
//   npm test

const assert = require('node:assert/strict');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');
const db = require(path.join(ROOT, 'models'));
const bcrypt = require('bcrypt');
const {
  splitKobo, lagosDateTime, checkInAt, checkOutAt, cancellationTerms, getShortletCommissionPercent, BookingActionError,
  describePolicy,
} = require(path.join(ROOT, 'utils/shortletSettlement'));
const { verifyTransactionPin } = require(path.join(ROOT, 'utils/pin'));

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// ── Commission split ──
test('splitKobo: 20% commission on ₦32,000 → host ₦25,600, platform ₦6,400', () => {
  assert.deepEqual(splitKobo(3200000, 20), { hostKobo: 2560000, platformKobo: 640000 });
});
test('splitKobo: 100% → platform keeps everything', () => {
  assert.deepEqual(splitKobo(1000000, 100), { hostKobo: 0, platformKobo: 1000000 });
});
test('splitKobo: parts always sum to the base (odd kobo)', () => {
  for (const pct of [0, 7.5, 15.5, 33.33, 50, 99]) {
    const { hostKobo, platformKobo } = splitKobo(1000001, pct);
    assert.equal(hostKobo + platformKobo, 1000001, `pct ${pct}`);
  }
});

// ── Commission source (admin per-landlord value only) ──
test('commission: uses the admin-set landlord value', async () => {
  db.Users.findByPk = async () => ({ id: 'h', commission_percent: '12.50' });
  assert.equal(await getShortletCommissionPercent('h'), 12.5);
});
test('commission: unset → platform keeps 100%', async () => {
  db.Users.findByPk = async () => ({ id: 'h', commission_percent: null });
  assert.equal(await getShortletCommissionPercent('h'), 100);
});
test('commission: ignores .env', async () => {
  process.env.PLATFORM_SHORTLET_COMMISSION_PERCENT = '5';
  db.Users.findByPk = async () => ({ id: 'h', commission_percent: null });
  assert.equal(await getShortletCommissionPercent('h'), 100);
  delete process.env.PLATFORM_SHORTLET_COMMISSION_PERCENT;
});

// ── Time handling (listing times are Lagos local, UTC+1) ──
test('lagosDateTime: 14:00 WAT is 13:00 UTC', () => {
  assert.equal(lagosDateTime('2026-12-01', '14:00:00').toISOString(), '2026-12-01T13:00:00.000Z');
  assert.equal(lagosDateTime('2026-12-01', '14:00').toISOString(), '2026-12-01T13:00:00.000Z');
});

// ── Cancellation policies ──
// 3 nights × ₦10,000 + ₦2,000 cleaning + ₦5,000 deposit = ₦37,000
const booking = (overrides = {}) => ({
  status: 'confirmed', check_in: '2026-12-10', check_in_time: '14:00:00', check_out: '2026-12-13', check_out_time: '11:00:00',
  nights: 3, price_per_night: '10000.00', cleaning_fee: '2000.00', security_deposit: '5000.00', deposit_status: 'held',
  total_amount: '37000.00', commission_percent: '20.00', cancellation_policy: 'flexible',
  createdAt: new Date('2026-10-01T00:00:00Z'), ...overrides,
});
const before = (b, hours) => new Date(checkInAt(b).getTime() - hours * 3600e3);
const after = (b, hours) => new Date(checkInAt(b).getTime() + hours * 3600e3);
const refund = (b, by, when) => cancellationTerms(b, by, when).refundAmount;

test('cancel: guest ≥24h before check-in → full refund', () => {
  const b = booking();
  const t = cancellationTerms(b, 'guest', before(b, 24));
  assert.equal(t.fullRefund, true);
  assert.equal(t.refundAmount, '37000.00');
  assert.equal(t.hostKobo, 0);
});
test('cancel: guest <24h before → first night kept, split host/platform', () => {
  const b = booking();
  const t = cancellationTerms(b, 'guest', before(b, 23));
  assert.equal(t.refundAmount, '27000.00');
  assert.equal(t.nonRefundableAmount, '10000.00');
  assert.equal(t.hostKobo, 800000);
  assert.equal(t.platformKobo, 200000);
});
test('cancel: host any time before check-in → guest gets full refund', () => {
  const b = booking();
  assert.equal(cancellationTerms(b, 'host', before(b, 1)).refundAmount, '37000.00');
});
test('moderate: ≥5 days → full; <5 days → first night kept + 50% of the rest', () => {
  const b = booking({ cancellation_policy: 'moderate' });
  assert.equal(refund(b, 'guest', before(b, 5 * 24)), '37000.00');
  assert.equal(refund(b, 'guest', before(b, 48)), '17000.00'); // 50% × 20,000 + 2,000 + 5,000
});
test('firm: ≥30 days full, 7–30 days 50% of nights, <7 days none (cleaning + deposit still back)', () => {
  const b = booking({ cancellation_policy: 'firm' });
  assert.equal(refund(b, 'guest', before(b, 30 * 24)), '37000.00');
  assert.equal(refund(b, 'guest', before(b, 10 * 24)), '22000.00');
  assert.equal(refund(b, 'guest', before(b, 6 * 24)), '7000.00');
});
test('strict: full only within 48h of booking AND ≥14 days out', () => {
  const b = booking({ cancellation_policy: 'strict', createdAt: before(booking(), 20 * 24) });
  assert.equal(refund(b, 'guest', before(b, 19 * 24)), '37000.00'); // booked 1 day ago, 19 days out
  assert.equal(refund(b, 'guest', before(b, 16 * 24)), '22000.00'); // >48h since booking → 50%
  assert.equal(refund(b, 'guest', before(b, 3 * 24)), '7000.00');
});
test('strict: booked <14 days out → no free-cancellation deadline', () => {
  const bookedAt = new Date('2026-12-01T12:00:00Z');
  assert.equal(describePolicy('strict', { checkIn: '2026-12-10', checkInTime: '14:00:00', bookedAt }).freeCancellationUntil, null);
});
test('host cancels before check-in → full refund under every policy', () => {
  for (const p of ['flexible', 'moderate', 'firm', 'strict']) {
    const b = booking({ cancellation_policy: p });
    assert.equal(refund(b, 'host', before(b, 1)), '37000.00', p);
  }
});
test('mid-stay (flexible): night in progress + next 24h used, unused nights refunded, no cleaning, deposit held', () => {
  const b = booking();
  const t = cancellationTerms(b, 'guest', after(b, 6)); // 6h after check-in → nights 1-2 used
  assert.equal(t.stage, 'during_stay');
  assert.equal(t.usedNights, 2);
  assert.equal(t.refundAmount, '10000.00');
  assert.equal(t.actualCheckOut, '2026-12-12');
  assert.equal(t.depositHeldForClaims, true);
  assert.equal(t.hostKobo, 1760000); // 80% of (2 nights + cleaning)
});
test('mid-stay: moderate refunds 50% of unused nights; firm/strict refund nothing', () => {
  assert.equal(refund(booking({ cancellation_policy: 'moderate' }), 'guest', after(booking(), 6)), '5000.00');
  assert.equal(refund(booking({ cancellation_policy: 'firm' }), 'guest', after(booking(), 6)), '0.00');
  assert.equal(refund(booking({ cancellation_policy: 'strict' }), 'guest', after(booking(), 6)), '0.00');
});
test('mid-stay: host ending the stay refunds every night not yet started (no 24h buffer)', () => {
  const b = booking({ cancellation_policy: 'strict' });
  const t = cancellationTerms(b, 'host', after(b, 6));
  assert.equal(t.usedNights, 1);
  assert.equal(t.refundAmount, '20000.00');
});
test('after check-out → refused (STAY_ENDED)', () => {
  const b = booking();
  assert.throws(() => cancellationTerms(b, 'guest', new Date(checkOutAt(b).getTime() + 1)), (e) => e instanceof BookingActionError && e.code === 'STAY_ENDED');
});
test('cancel: already cancelled → refused', () => {
  const b = booking({ status: 'cancelled' });
  assert.throws(() => cancellationTerms(b, 'guest', before(b, 48)), (e) => e.code === 'NOT_CANCELLABLE');
});

// ── Transaction PIN ──
test('pin: not set → 403 PIN_NOT_SET (even with a PIN sent)', async () => {
  db.Pins.findOne = async () => null;
  assert.equal((await verifyTransactionPin('u', '1234', 'booking')).code, 'PIN_NOT_SET');
});
test('pin: missing / malformed → 400 PIN_REQUIRED', async () => {
  db.Pins.findOne = async () => ({ pin: await bcrypt.hash('1234', 4) });
  for (const bad of [undefined, 1234, '123', '12345', 'abcd']) {
    assert.equal((await verifyTransactionPin('u', bad)).code, 'PIN_REQUIRED', String(bad));
  }
});
test('pin: wrong → 403 PIN_INCORRECT, right → null', async () => {
  db.Pins.findOne = async () => ({ pin: await bcrypt.hash('1234', 4) });
  assert.equal((await verifyTransactionPin('u', '0000')).code, 'PIN_INCORRECT');
  assert.equal(await verifyTransactionPin('u', '1234'), null);
});

(async () => {
  let failed = 0;
  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log(`  ✔ ${name}`);
    } catch (e) {
      failed++;
      console.log(`  ✘ ${name}\n    ${e.message}`);
    }
  }
  console.log(`\n${tests.length - failed} passed, ${failed} failed`);
  await db.sequelize.close().catch(() => {});
  process.exit(failed ? 1 : 0);
})();
