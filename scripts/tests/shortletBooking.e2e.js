#!/usr/bin/env node
'use strict';
// End-to-end test of shortlet booking: real routes, middleware, PIN, wallet,
// row locks and the settlement job against a real Postgres. Only email is
// stubbed. Dates are relative to today, so the test never goes stale.
//
//   npm run test:db:start                  # throwaway local DB + migrations
//   npm run test:e2e
//   npm run test:db:stop
//
// SAFETY: it only runs against TEST_DATABASE_URL on localhost (it creates and
// deletes users, wallets and bookings). It cleans up its own rows when done;
// set KEEP_TEST_DATA=true to keep them for inspection.

const path = require('path');
const crypto = require('crypto');
const ROOT = path.resolve(__dirname, '../..');

// ── Point the app at the TEST database before anything loads config ──
const TEST_URL = process.env.TEST_DATABASE_URL || 'postgres://test@127.0.0.1:55432/rentulo_test';
const testHost = new URL(TEST_URL).hostname;
if (!['127.0.0.1', 'localhost', '::1'].includes(testHost) && process.env.ALLOW_REMOTE_TEST_DB !== 'true') {
  console.error(`Refusing to run against non-local database host "${testHost}". This test writes and deletes data.`);
  process.exit(1);
}
// dotenv never overrides variables that are already set, so these win over .env.
process.env.DATABASE_URL = TEST_URL;
process.env.DB_SSL_CA_PATH = '';
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = `test-${crypto.randomUUID()}`;

// Stub email + Cloudinary so nothing real is sent or uploaded.
require('./helpers/stubExternal');

const express = require('express');
const jwt = require('jsonwebtoken');
const { Op } = require('sequelize');
const db = require(path.join(ROOT, 'models'));
const settlement = require(path.join(ROOT, 'utils/shortletSettlement'));

const { Users, Wallet, Shortlets, ShortletBookings, WalletTransactions, Pins, Notifications } = db;

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log(`  ✔ ${name}`); }
  else { fail++; console.log(`  ✘ ${name}`, extra !== undefined ? JSON.stringify(extra) : ''); }
}

const app = express();
app.use(express.json());
app.use('/shortlet', require(path.join(ROOT, 'routes/shortlet.routes')));
app.use('/progress', require(path.join(ROOT, 'routes/progress.routes')));
app.use('/pin', require(path.join(ROOT, 'routes/pin.routes')));
app.use('/admin', require(path.join(ROOT, 'routes/superAdmin.routes')));

let base;
const tokenFor = (u) => jwt.sign({ userId: u.id, role: u.role }, process.env.JWT_SECRET);
// Deposit claims are multipart: amount, reason, photos[]
function claimForm({ amount, reason, photos = 1, type = 'image/jpeg' }) {
  const f = new FormData();
  if (amount !== undefined) f.append('amount', String(amount));
  if (reason !== undefined) f.append('reason', reason);
  for (let i = 0; i < photos; i++) f.append('photos', new Blob([Buffer.from(`photo-${i}`)], { type }), `p${i}.jpg`);
  return f;
}
async function claim(user, bookingId, fields) {
  const r = await fetch(`${base}/shortlet/bookings/${bookingId}/deposit-claim`, {
    method: 'POST', headers: { authorization: `Bearer ${tokenFor(user)}` }, body: claimForm(fields),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}
async function call(user, method, url, body) {
  const r = await fetch(base + url, {
    method,
    headers: { 'content-type': 'application/json', ...(user && { authorization: `Bearer ${tokenFor(user)}` }) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}
const bal = async (u) => Number((await Wallet.findOne({ where: { user_id: u.id } })).balance);
const setBal = (u, v) => Wallet.update({ balance: v }, { where: { user_id: u.id } });

// Dates relative to today in Lagos
const DAY = 24 * 3600e3;
const ymd = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Lagos' }).format(d);
const d = (offsetDays) => ymd(new Date(Date.now() + offsetDays * DAY));
const at = (offsetDays, time) => settlement.lagosDateTime(d(offsetDays), time);

const runId = crypto.randomUUID().slice(0, 8);
const created = { users: [], shortlets: [] };
async function mkUser(name, extra = {}) {
  const u = await Users.create({
    full_name: name, email: `${name.toLowerCase().replace(/\s/g, '')}.${runId}@test.local`, password: 'x',
    role: 'tenant', gender: 'male', is_verified: true, phone_no: '080', state: 'Lagos', address: 'Addr', ...extra,
  });
  created.users.push(u.id);
  await Wallet.create({ user_id: u.id, accountName: name, accountNumber: `TEST-${runId}-${created.users.length}`, balance: 0, status: 'ACTIVE' });
  return u;
}

async function cleanup() {
  if (process.env.KEEP_TEST_DATA === 'true') return console.log(`\n(kept test data, run ${runId})`);
  const users = { [Op.in]: created.users };
  await ShortletBookings.destroy({ where: { [Op.or]: [{ user_id: users }, { host_id: users }] } });
  await Shortlets.destroy({ where: { id: { [Op.in]: created.shortlets } } });
  await WalletTransactions.destroy({ where: { user_id: users } });
  await Wallet.destroy({ where: { user_id: users } });
  await Pins.destroy({ where: { user_id: users } });
  await Notifications.destroy({ where: { user_id: users } });
  await Users.destroy({ where: { id: users } });
}

async function shortletAnalytics(admin) {
  const r = await call(admin, 'GET', '/admin/analytics');
  return r.status === 200 ? r.body.data.financials.shortletBookings : null;
}

async function main() {
  const host = await mkUser('Host Hannah', { role: 'landlord', commission_percent: 20 });
  const guest = await mkUser('Guest Gina');
  const guest2 = await mkUser('Guest Gabe');
  const guest3 = await mkUser('Guest Gus');
  const admin = await mkUser('Admin Ada', { is_superadmin: true, role: 'admin' });
  const sl = await Shortlets.create({
    title: `Lekki Loft ${runId}`, description: 'Nice', address: '1 Road', city: 'Lagos', area: 'Lekki', UserId: host.id,
    pricePerNight: 10000, cleaningFee: 2000, securityDeposit: 5000, minimumStay: 1, maximumStay: 30,
    availableFrom: d(0), availableTo: d(240), guestCapacity: 4, images: ['https://img.test/1.jpg'],
    checkInTime: '14:00:00', checkOutTime: '11:00:00',
  });
  created.shortlets.push(sl.id);
  const analyticsBefore = await shortletAnalytics(admin);
  const book = (u, checkIn, checkOut, extra = {}) =>
    call(u, 'POST', '/shortlet/book', { shortlet_id: sl.id, checkIn, checkOut, guests: 2, pin: '1234', ...extra });

  console.log('\n1. Original bug: no PIN, no money');
  let r = await book(guest, d(20), d(23));
  check('booking without a PIN set is refused (403 PIN_NOT_SET)', r.status === 403 && r.body.code === 'PIN_NOT_SET', r);
  r = await call(guest, 'POST', '/progress/book', { rental_id: sl.id });
  check('old /progress/book back door refuses shortlets', r.status === 400 && r.body.code === 'USE_SHORTLET_BOOKING', r);
  check('no booking row was created', (await ShortletBookings.count({ where: { shortlet_id: sl.id } })) === 0);

  r = await call(guest, 'POST', '/pin/create', { pin: '1234' });
  check('guest creates a PIN', r.status === 201, r);
  r = await book(guest, d(20), d(23), { pin: '9999' });
  check('wrong PIN refused', r.status === 403 && r.body.code === 'PIN_INCORRECT', r);
  r = await book(guest, d(20), d(23), { pin: undefined });
  check('missing PIN refused', r.status === 400 && r.body.code === 'PIN_REQUIRED', r);
  r = await book(guest, d(20), d(23));
  check('empty wallet refused (INSUFFICIENT_BALANCE)', r.status === 400 && r.body.code === 'INSUFFICIENT_BALANCE', r);
  check('still no booking, no ledger rows', (await ShortletBookings.count({ where: { shortlet_id: sl.id } })) === 0
    && (await WalletTransactions.count({ where: { user_id: guest.id } })) === 0);

  console.log('\n2. Validation');
  await setBal(guest, 200000);
  check('past dates refused', (await book(guest, d(-3), d(-1))).status === 400);
  check('check-out before check-in refused', (await book(guest, d(23), d(20))).status === 400);
  check('impossible date refused', (await book(guest, '2027-02-31', '2027-03-02')).status === 400);
  check('outside availability refused', (await book(guest, d(239), d(242))).status === 400);
  check('more nights than maximumStay refused', (await book(guest, d(40), d(80))).status === 400);
  check('too many guests refused', (await book(guest, d(20), d(23), { guests: 9 })).status === 400);
  check('host cannot book own listing', (await call(host, 'POST', '/shortlet/book', { shortlet_id: sl.id, checkIn: d(20), checkOut: d(21), pin: '1234' })).status === 400);

  console.log('\n3. Quote → book → held payment');
  r = await call(guest, 'GET', `/shortlet/quote/${sl.id}?checkIn=${d(20)}&checkOut=${d(23)}&guests=2`);
  check('quote: 3 nights, ₦30,000 + ₦2,000 cleaning + ₦5,000 deposit = ₦37,000', r.status === 200 && r.body.data.nights === 3 && r.body.data.total === '37000.00', r.body);
  check('quote charged nothing', (await bal(guest)) === 200000);
  r = await book(guest, d(20), d(23));
  check('booking succeeds (201)', r.status === 201, r);
  const b1 = r.body.data;
  check('guest charged ₦37,000', (await bal(guest)) === 163000);
  check('host NOT paid yet (payment held)', (await bal(host)) === 0);
  check('guest response hides host payout / platform fee', b1.host_payout === undefined && b1.platform_fee === undefined);
  const b1row = await ShortletBookings.findByPk(b1.id);
  check('admin commission 20% frozen on booking: host ₦25,600 / platform ₦6,400 (deposit excluded)',
    Number(b1row.commission_percent) === 20 && b1row.host_payout === '25600.00' && b1row.platform_fee === '6400.00', b1row.toJSON());
  check('payout due 24h after check-in', new Date(b1row.payout_due_at).getTime() === at(21, '14:00:00').getTime(), b1row.payout_due_at);

  console.log('\n4. Calendar & double booking');
  r = await call(guest2, 'GET', `/shortlet/availability/${sl.id}`);
  check('availability lists booked range', r.body.data.bookedRanges.some((x) => x.checkIn === d(20) && x.checkOut === d(23)), r.body);
  await setBal(guest2, 200000); await setBal(guest3, 200000);
  await call(guest2, 'POST', '/pin/create', { pin: '1234' }); await call(guest3, 'POST', '/pin/create', { pin: '1234' });
  r = await book(guest2, d(22), d(24));
  check('overlapping dates refused (409 DATES_UNAVAILABLE)', r.status === 409 && r.body.code === 'DATES_UNAVAILABLE', r);
  r = await book(guest2, d(23), d(25));
  check('same-day turnover allowed (check in on previous check-out day)', r.status === 201, r);
  const b2 = r.body.data; // 2 nights = ₦27,000

  const [ra, rb] = await Promise.all([book(guest2, d(60), d(62)), book(guest3, d(61), d(63))]);
  const codes = [ra.status, rb.status].sort();
  check('two guests racing for the same nights: exactly one wins', codes[0] === 201 && codes[1] === 409, codes);
  const loser = ra.status === 409 ? guest2 : guest3;
  check('the loser was not charged', (await bal(loser)) === (loser === guest2 ? 173000 : 200000), { bal: await bal(loser) });

  console.log('\n5. My bookings / host bookings / detail');
  r = await call(guest, 'GET', '/progress/book');
  check('GET /progress/book includes shortletBookings', r.status === 200 && r.body.shortletBookings.length === 1 && r.body.shortletBookings[0].shortlet.id === sl.id, r.body);
  r = await call(guest, 'GET', '/shortlet/bookings');
  check('GET /shortlet/bookings lists the trip', r.body.data.length === 1);
  r = await call(host, 'GET', '/shortlet/host/bookings');
  check('host sees reservations with payout + guest, no platform fee', r.body.data.length >= 3 && r.body.data.every((x) => x.host_payout && x.guest && x.platform_fee === undefined), r.body);
  r = await call(guest, 'GET', `/shortlet/bookings/${b1.id}`);
  check('detail shows cancellation terms (full refund now)', r.body.data.cancellation.canCancel && r.body.data.cancellation.refundAmount === '37000.00', r.body.data.cancellation);
  r = await call(guest3, 'GET', `/shortlet/bookings/${b1.id}`);
  check("strangers can't view someone else's booking", r.status === 404);

  console.log('\n6. Host protections');
  r = await call(host, 'PUT', `/shortlet/update/${sl.id}`, { availableTo: d(21) });
  check('host cannot shrink availability over a confirmed stay', r.status === 409, r);
  r = await call(host, 'PUT', `/shortlet/update/${sl.id}`, { availableTo: d(200) });
  check('host can still change availability that does not affect bookings', r.status === 200, r);
  r = await call(host, 'DELETE', `/shortlet/delete/${sl.id}`);
  check('host cannot delete listing with upcoming stays', r.status === 409, r);

  console.log('\n7. Cancellations');
  r = await call(guest3, 'POST', `/shortlet/bookings/${b1.id}/cancel`, {});
  check("stranger can't cancel", r.status === 403, r);
  r = await call(guest, 'POST', `/shortlet/bookings/${b1.id}/cancel`, { reason: 'Plans changed' });
  check('guest cancels ≥24h before → full ₦37,000 refund', r.status === 200 && r.body.refundAmount === '37000.00', r);
  check('guest balance restored to ₦200,000', (await bal(guest)) === 200000);
  r = await call(guest, 'GET', `/shortlet/availability/${sl.id}`);
  check('dates freed up', !r.body.data.bookedRanges.some((x) => x.checkIn === d(20)));
  r = await call(guest, 'POST', `/shortlet/bookings/${b1.id}/cancel`, {});
  check("can't cancel twice", r.status === 400, r);

  // Late cancel: next check-in that is less than 24h away (today if before 14:00 WAT, else tomorrow)
  const lagosHour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Lagos', hour: '2-digit', hour12: false }).format(new Date()));
  const lateIn = lagosHour < 13 ? 0 : 1;
  r = await book(guest, d(lateIn), d(lateIn + 2));
  check(`book ${d(lateIn)} → ${d(lateIn + 2)} (2 nights, ₦27,000)`, r.status === 201, r);
  const late = r.body.data;
  const hostBefore = await bal(host);
  r = await call(guest, 'POST', `/shortlet/bookings/${late.id}/cancel`, {});
  check('late cancel (<24h) keeps first night: refund ₦17,000', r.status === 200 && r.body.refundAmount === '17000.00', r);
  check('host gets 80% of first night (₦8,000) immediately', (await bal(host)) - hostBefore === 8000, { delta: (await bal(host)) - hostBefore });

  r = await call(host, 'POST', `/shortlet/bookings/${b2.id}/cancel`, { reason: 'Maintenance' });
  check('host cancels → guest always gets a full refund', r.status === 200 && r.body.refundAmount === '27000.00', r);

  console.log('\n8. Settlement job (host paid 24h after check-in, deposit back 48h after check-out)');
  r = await book(guest, d(30), d(33));
  const s1 = r.body.data;
  const hostPre = await bal(host), guestPre = await bal(guest);
  let sum = await settlement.runShortletSettlement(at(30, '20:00:00'));
  check('before payout is due: nothing paid', (await bal(host)) === hostPre, sum);
  sum = await settlement.runShortletSettlement(at(31, '15:00:00'));
  check('24h after check-in: host paid ₦25,600', (await bal(host)) - hostPre === 25600, sum);
  await settlement.runShortletSettlement(at(31, '16:00:00'));
  check('running again does not pay twice', (await bal(host)) - hostPre === 25600);
  await settlement.runShortletSettlement(at(33, '11:00:00'));
  let s1row = await ShortletBookings.findByPk(s1.id);
  check('at check-out: completed, deposit still HELD for the 48h claim window', s1row.status === 'completed' && s1row.deposit_status === 'held' && (await bal(guest)) === guestPre);
  check('claim window ends 48h after check-out', new Date(s1row.deposit_refund_due_at).getTime() === at(35, '11:00:00').getTime(), s1row.deposit_refund_due_at);
  await settlement.runShortletSettlement(at(35, '10:59:00'));
  check('just before the window closes: still held', (await bal(guest)) === guestPre);
  await settlement.runShortletSettlement(at(35, '11:00:00'));
  check('no claim → ₦5,000 deposit refunded automatically', (await bal(guest)) - guestPre === 5000);
  s1row = await ShortletBookings.findByPk(s1.id);
  check('deposit marked refunded', s1row.deposit_status === 'refunded' && s1row.payout_status === 'paid');
  await settlement.runShortletSettlement(at(36, '11:00:00'));
  check('deposit not refunded twice', (await bal(guest)) - guestPre === 5000);

  console.log('\n8a. Security deposit claims');
  await setBal(guest, 300000);
  // cl1: shift into the past so the REAL endpoints can be used inside the claim window
  r = await book(guest, d(40), d(42));
  const cl1 = r.body.data;
  const up0 = global.__cloudinary.uploaded.length;
  r = await claim(host, cl1.id, { amount: 3000, reason: 'Broken glass table in the living room' });
  check('claim before the stay starts → 400 STAY_NOT_STARTED', r.status === 400 && r.body.code === 'STAY_NOT_STARTED', r.body);
  check('…and nothing was uploaded for a refused claim', global.__cloudinary.uploaded.length === up0);
  await ShortletBookings.update({
    check_in: d(-3), check_out: d(-1), payout_due_at: at(-2, '14:00:00'), deposit_refund_due_at: new Date(at(-1, '11:00:00').getTime() + 48 * 3600e3),
  }, { where: { id: cl1.id } });
  const hostCl = await bal(host);
  let guestCl = await bal(guest);
  await settlement.runShortletSettlement();
  check('past stay: host paid ₦17,600 and stay completed', (await bal(host)) - hostCl === 17600 && (await ShortletBookings.findByPk(cl1.id)).status === 'completed');
  r = await call(host, 'GET', `/shortlet/bookings/${cl1.id}`);
  check('host detail: canClaim true, shows window end', r.body.data.depositClaim.canClaim === true && !!r.body.data.depositClaim.claimWindowEndsAt, r.body.data.depositClaim);
  r = await call(guest, 'GET', `/shortlet/bookings/${cl1.id}`);
  check('guest detail: canClaim false (only hosts can claim), no claim yet', r.body.data.depositClaim.canClaim === false && r.body.data.depositClaim.claim === null && r.body.data.depositClaim.depositStatus === 'held', r.body.data.depositClaim);
  r = await claim(guest, cl1.id, { amount: 1000, reason: 'Guest trying to claim' });
  check('guest cannot claim (403)', r.status === 403, r.body);
  r = await claim(host, cl1.id, { amount: 6000, reason: 'Broken glass table in the living room' });
  check('claim above the deposit → 400 INVALID_AMOUNT', r.status === 400 && r.body.code === 'INVALID_AMOUNT', r.body);
  r = await claim(host, cl1.id, { amount: 3000, reason: 'broken' });
  check('vague reason → 400 INVALID_REASON', r.status === 400 && r.body.code === 'INVALID_REASON', r.body);
  r = await claim(host, cl1.id, { amount: 3000, reason: 'Broken glass table in the living room', photos: 0 });
  check('no photos → 400 INVALID_PHOTOS', r.status === 400 && r.body.code === 'INVALID_PHOTOS', r.body);
  r = await claim(host, cl1.id, { amount: 3000, reason: 'Broken glass table in the living room', photos: 6 });
  check('6 photos → 400 INVALID_PHOTOS', r.status === 400 && r.body.code === 'INVALID_PHOTOS', r.body);
  r = await claim(host, cl1.id, { amount: 3000, reason: 'Broken glass table in the living room', type: 'application/pdf' });
  check('non-image file → 400 INVALID_PHOTOS', r.status === 400 && r.body.code === 'INVALID_PHOTOS' && /images are allowed/.test(r.body.message), r.body);
  {
    const big = new FormData();
    big.append('amount', '3000'); big.append('reason', 'Broken glass table in the living room');
    big.append('photos', new Blob([Buffer.alloc(5 * 1024 * 1024 + 1)], { type: 'image/jpeg' }), 'big.jpg');
    const rr = await fetch(`${base}/shortlet/bookings/${cl1.id}/deposit-claim`, { method: 'POST', headers: { authorization: `Bearer ${tokenFor(host)}` }, body: big });
    const bb = await rr.json();
    check('photo over 5MB → 400 INVALID_PHOTOS', rr.status === 400 && /5MB/.test(bb.message), bb);
  }
  check('still nothing uploaded after all those refusals', global.__cloudinary.uploaded.length === up0);
  r = await claim(host, cl1.id, { amount: 3000, reason: 'Broken glass table in the living room', photos: 3 });
  check('host files ₦3,000 claim with 3 photos', r.status === 200 && r.body.data.deposit_status === 'claimed' && r.body.data.deposit_claim_photos.length === 3
    && r.body.data.deposit_claim_photos.every((u) => u.startsWith('https://cdn.test/deposit-claims/')), r.body);
  r = await claim(host, cl1.id, { amount: 1000, reason: 'Another thing got broken here' });
  check('second claim → 400 CLAIM_EXISTS', r.status === 400 && r.body.code === 'CLAIM_EXISTS', r.body);
  {
    // Two claims racing on one booking: both pass the pre-check and upload,
    // only one can be saved — the loser's photos must be deleted again.
    const rr = await book(guest, d(150), d(152));
    const race = rr.body.data;
    await ShortletBookings.update({
      check_in: d(-4), check_out: d(-2), payout_due_at: at(-3, '14:00:00'), deposit_refund_due_at: new Date(at(-2, '11:00:00').getTime() + 48 * 3600e3),
    }, { where: { id: race.id } });
    await settlement.runShortletSettlement();
    const destroyed0 = global.__cloudinary.destroyed.length;
    const [x, y] = await Promise.all([
      claim(host, race.id, { amount: 1000, reason: 'Cracked bathroom mirror', photos: 2 }),
      claim(host, race.id, { amount: 1000, reason: 'Cracked bathroom mirror', photos: 2 }),
    ]);
    const codes = [x.status, y.status].sort();
    check('racing claims: one filed, one refused', codes[0] === 200 && codes[1] === 400, [x.body, y.body]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    check("…and the refused claim's 2 photos were deleted from Cloudinary", global.__cloudinary.destroyed.length - destroyed0 === 2, global.__cloudinary.destroyed.length - destroyed0);
    check('the filed claim keeps exactly its own 2 photos', (await ShortletBookings.findByPk(race.id)).deposit_claim_photos.length === 2);
  }
  guestCl = await bal(guest); // the race booking above charged the guest
  r = await call(guest, 'GET', `/shortlet/bookings/${cl1.id}`);
  check('guest can see the claim amount, reason and photos', r.body.data.deposit_claim_amount === '3000.00' && /glass table/.test(r.body.data.deposit_claim_reason) && r.body.data.deposit_claim_photos.length === 3, r.body.data);
  await settlement.runShortletSettlement(new Date(Date.now() + 10 * 24 * 3600e3));
  check('an open claim stops the automatic refund', (await ShortletBookings.findByPk(cl1.id)).deposit_status === 'claimed' && (await bal(guest)) === guestCl);
  r = await call(guest, 'GET', '/admin/shortlet-bookings/deposit-claims');
  check('non-admin cannot list claims', r.status === 403, r.status);
  r = await call(admin, 'GET', '/admin/shortlet-bookings/deposit-claims');
  check('admin lists open claims (with guest, host and photos)', r.status === 200 && r.body.data.some((c) => c.id === cl1.id && c.guest && c.host && c.deposit_claim_photos.length === 3), r.body);
  // ── Who can see what, while the claim is open ──
  r = await call(guest, 'PUT', `/admin/shortlet-bookings/${cl1.id}/deposit-claim`, { decision: 'reject' });
  check('guest cannot resolve the claim (403)', r.status === 403, r.status);
  r = await call(host, 'PUT', `/admin/shortlet-bookings/${cl1.id}/deposit-claim`, { decision: 'approve' });
  check('host cannot resolve their own claim (403)', r.status === 403, r.status);
  check('…and the claim is still open', (await ShortletBookings.findByPk(cl1.id)).deposit_status === 'claimed');
  r = await call(guest, 'GET', `/admin/shortlet-bookings/${cl1.id}`);
  check('guest cannot open the admin booking view (403)', r.status === 403, r.status);
  const views = {};
  views.guest = (await call(guest, 'GET', `/shortlet/bookings/${cl1.id}`)).body.data;
  views.host = (await call(host, 'GET', `/shortlet/bookings/${cl1.id}`)).body.data;
  r = await call(admin, 'GET', `/admin/shortlet-bookings/${cl1.id}`);
  check('admin can open any booking (with guest, host, shortlet)', r.status === 200 && r.body.data.guest && r.body.data.host && r.body.data.shortlet, r.body);
  views.admin = r.body.data;
  const claimOf = (v) => JSON.stringify(v.depositClaim.claim);
  check('guest, host and admin see the SAME open claim (amount, reason, 3 photos, pending_review)',
    claimOf(views.guest) === claimOf(views.host) && claimOf(views.host) === claimOf(views.admin)
    && views.admin.depositClaim.claim.amount === '3000.00' && views.admin.depositClaim.claim.photos.length === 3
    && views.admin.depositClaim.claim.status === 'pending_review', { guest: views.guest.depositClaim, admin: views.admin.depositClaim });
  check('only the admin gets canResolve', views.admin.depositClaim.canResolve === true && views.guest.depositClaim.canResolve === false && views.host.depositClaim.canResolve === false);
  check('nobody can file a second claim (canClaim false for all)', [views.guest, views.host, views.admin].every((v) => v.depositClaim.canClaim === false));
  check('admin sees the platform fee; guest and host do not', views.admin.platform_fee !== undefined && views.guest.platform_fee === undefined && views.host.platform_fee === undefined);
  check('guest does not see the host payout; host and admin do', views.guest.host_payout === undefined && views.host.host_payout && views.admin.host_payout);
  r = await call(admin, 'GET', '/admin/shortlet-bookings?deposit_status=claimed');
  check('admin booking list filters by deposit_status', r.status === 200 && r.body.data.some((b) => b.id === cl1.id) && r.body.data.every((b) => b.deposit_status === 'claimed'), r.body.count);
  r = await call(admin, 'GET', `/admin/shortlet-bookings?host_id=${host.id}&limit=500`);
  check('admin booking list filters by host (limit capped at 100)', r.status === 200 && r.body.data.length <= 100 && r.body.data.every((b) => b.host_id === host.id), r.body.count);
  r = await call(admin, 'GET', '/admin/shortlet-bookings?host_id=nope');
  check('bad filter id → 400', r.status === 400, r.body);
  r = await call(guest, 'GET', '/shortlet/bookings');
  check("guest's trip list also carries the claim summary", r.body.data.find((b) => b.id === cl1.id)?.depositClaim?.claim?.photos.length === 3);
  r = await call(host, 'GET', '/shortlet/host/bookings');
  check("host's reservation list also carries the claim summary", r.body.data.find((b) => b.id === cl1.id)?.depositClaim?.claim?.amount === '3000.00');

  r = await call(admin, 'PUT', `/admin/shortlet-bookings/${cl1.id}/deposit-claim`, { decision: 'approve', amount: 4000 });
  check('admin cannot award more than claimed', r.status === 400 && r.body.code === 'INVALID_AMOUNT', r.body);
  const hostRes = await bal(host);
  r = await call(admin, 'PUT', `/admin/shortlet-bookings/${cl1.id}/deposit-claim`, { decision: 'approve', amount: 2000, note: 'Partial: table was already chipped' });
  check('partial approval: ₦2,000 to host, ₦3,000 back to guest', r.status === 200 && r.body.paidToHost === '2000.00' && r.body.refundedToGuest === '3000.00'
    && (await bal(host)) - hostRes === 2000 && (await bal(guest)) - guestCl === 3000, r.body);
  const cl1row = await ShortletBookings.findByPk(cl1.id);
  check('booking: settled, partially_approved, deposit_paid_to_host 2000', cl1row.deposit_status === 'settled' && cl1row.deposit_claim_decision === 'partially_approved' && cl1row.deposit_paid_to_host === '2000.00');
  // ── Who can see what, after the decision ──
  const after3 = {
    guest: (await call(guest, 'GET', `/shortlet/bookings/${cl1.id}`)).body.data.depositClaim,
    host: (await call(host, 'GET', `/shortlet/bookings/${cl1.id}`)).body.data.depositClaim,
    admin: (await call(admin, 'GET', `/admin/shortlet-bookings/${cl1.id}`)).body.data.depositClaim,
  };
  check('all three see the decision: partially_approved, ₦2,000 to host, ₦3,000 to guest, with the admin note',
    ['guest', 'host', 'admin'].every((k) => after3[k].claim.status === 'resolved' && after3[k].claim.decision === 'partially_approved'
      && after3[k].claim.paidToHost === '2000.00' && after3[k].claim.refundedToGuest === '3000.00'
      && after3[k].claim.adminNote === 'Partial: table was already chipped' && after3[k].depositStatus === 'settled'), after3);
  check('after the decision nobody can resolve again (canResolve false)', ['guest', 'host', 'admin'].every((k) => after3[k].canResolve === false));
  r = await call(admin, 'PUT', `/admin/shortlet-bookings/${cl1.id}/deposit-claim`, { decision: 'approve' });
  check('cannot resolve twice (NO_OPEN_CLAIM)', r.status === 400 && r.body.code === 'NO_OPEN_CLAIM', r.body);

  // cl2: rejected claim (time-travel via the settlement functions)
  r = await book(guest, d(44), d(46));
  const cl2 = r.body.data;
  await settlement.runShortletSettlement(at(46, '11:00:00'));
  await settlement.fileDepositClaim({ bookingId: cl2.id, hostUserId: host.id, amount: 5000, reason: 'Stained mattress and carpet', photos: ['https://cdn.test/a.jpg'], now: at(46, '12:00:00') });
  const guestRej = await bal(guest);
  await settlement.resolveDepositClaim({ bookingId: cl2.id, decision: 'reject', note: 'No photos provided' });
  check('rejected claim → full ₦5,000 back to guest', (await bal(guest)) - guestRej === 5000 && (await ShortletBookings.findByPk(cl2.id)).deposit_claim_decision === 'rejected');

  // cl3: claim after the window closed
  r = await book(guest, d(47), d(48));
  const cl3 = r.body.data;
  await settlement.completeBooking(cl3.id, at(48, '11:00:00'));
  let err = await settlement.fileDepositClaim({ bookingId: cl3.id, hostUserId: host.id, amount: 1000, reason: 'Late claim for a broken lamp', photos: ['https://cdn.test/a.jpg'], now: at(50, '11:01:00') }).catch((e) => e);
  check('claim after the 48h window → CLAIM_WINDOW_CLOSED', err.code === 'CLAIM_WINDOW_CLOSED', err.message);
  let gW = await bal(guest);
  await settlement.runShortletSettlement(at(50, '11:01:00'));
  check('…and its deposit was refunded automatically when the window closed', (await bal(guest)) - gW === 5000 && (await ShortletBookings.findByPk(cl3.id)).deposit_status === 'refunded');

  console.log('\n8b. Ending a stay early (cancel after check-in)');
  await setBal(guest, 300000); await setBal(host, 200000);
  // m1: 5 nights, guest leaves on night 1, host NOT yet paid
  r = await book(guest, d(50), d(55));
  const m1 = r.body.data; // 5 × 10,000 + 2,000 + 5,000 = 57,000
  let g0 = await bal(guest), h0 = await bal(host);
  let res = await settlement.cancelBooking({ bookingId: m1.id, actorUserId: guest.id, now: at(50, '20:00:00') });
  check('6h into the stay: nights 1–2 used (incl. next 24h), 3 nights refunded = ₦30,000', res.terms.stage === 'during_stay' && res.terms.usedNights === 2 && res.terms.refundAmount === '30000.00', res.terms);
  check('cleaning fee not refunded mid-stay; deposit stays held', res.terms.cleaningRefundKobo === 0 && res.booking.deposit_status === 'held');
  check('guest +₦30,000; host gets 80% of the 2 nights + cleaning = ₦17,600', (await bal(guest)) - g0 === 30000 && (await bal(host)) - h0 === 17600);
  check('actual_check_out = night 2 ends', res.booking.actual_check_out === d(52));
  r = await book(guest2, d(51), d(52));
  check('nights still being used stay blocked (409)', r.status === 409, r.body);
  await setBal(guest2, 300000);
  r = await book(guest2, d(52), d(54));
  check('freed nights can be booked again', r.status === 201, r.body);
  r = await call(guest2, 'GET', `/shortlet/availability/${sl.id}`);
  check('calendar shows the shortened stay', r.body.data.bookedRanges.some((x) => x.checkIn === d(50) && x.checkOut === d(52)), r.body.data.bookedRanges);
  g0 = await bal(guest);
  await settlement.runShortletSettlement(at(54, '11:00:00'));
  check('deposit returned 48h after the early check-out', (await bal(guest)) - g0 === 5000);

  // m2: host already paid → clawback from the host wallet
  r = await book(guest, d(70), d(75));
  const m2 = r.body.data;
  await settlement.runShortletSettlement(at(71, '15:00:00'));
  g0 = await bal(guest); h0 = await bal(host);
  res = await settlement.cancelBooking({ bookingId: m2.id, actorUserId: guest.id, now: at(72, '10:00:00') });
  check('after payout: 3 nights used, 2 refunded (₦20,000)', res.terms.usedNights === 3 && res.terms.refundAmount === '20000.00', res.terms);
  check('host pays back ₦16,000 (had ₦41,600, now entitled to ₦25,600)', h0 - (await bal(host)) === 16000 && res.booking.host_payout === '25600.00', { delta: h0 - (await bal(host)) });
  check('guest +₦20,000', (await bal(guest)) - g0 === 20000);

  // m3: host can't cover the clawback → refused, nothing changes
  r = await book(guest, d(80), d(85));
  const m3 = r.body.data;
  await settlement.runShortletSettlement(at(81, '15:00:00'));
  await setBal(host, 0);
  g0 = await bal(guest);
  err = await settlement.cancelBooking({ bookingId: m3.id, actorUserId: guest.id, now: at(82, '10:00:00') }).catch((e) => e);
  check('host wallet too low → 409 REFUND_NEEDS_SUPPORT', err.code === 'REFUND_NEEDS_SUPPORT', err.message);
  check('…and nothing moved: booking still confirmed, guest unchanged', (await ShortletBookings.findByPk(m3.id)).status === 'confirmed' && (await bal(guest)) === g0);
  await setBal(host, 200000);
  h0 = await bal(host); g0 = await bal(guest);
  res = await settlement.cancelBooking({ bookingId: m3.id, actorUserId: host.id, now: at(81, '20:00:00') });
  check('host ends stay early: guest gets 100% of nights not yet started (3 × ₦10,000)', res.terms.usedNights === 2 && (await bal(guest)) - g0 === 30000, res.terms);
  check('host keeps 80% of 2 nights + cleaning (₦17,600): pays back ₦24,000', h0 - (await bal(host)) === 24000);

  // real endpoint during a stay (shift a booking so it's in progress right now)
  r = await book(guest, d(140), d(144));
  const live = r.body.data;
  await ShortletBookings.update({ check_in: d(-1), check_out: d(3), payout_due_at: at(0, '14:00:00'), deposit_refund_due_at: new Date(at(3, '11:00:00').getTime() + 48 * 3600e3) }, { where: { id: live.id } });
  r = await call(guest, 'GET', `/shortlet/bookings/${live.id}`);
  check('detail during the stay: canCancel, stage during_stay, shows leave date', r.body.data.cancellation.canCancel && r.body.data.cancellation.stage === 'during_stay' && !!r.body.data.cancellation.actualCheckOut, r.body.data.cancellation);
  const preview = r.body.data.cancellation.refundAmount;
  r = await call(guest, 'POST', `/shortlet/bookings/${live.id}/cancel`, { reason: 'Family emergency' });
  check('POST cancel during the stay works and matches the preview', r.status === 200 && r.body.refundAmount === preview && !!r.body.data.actual_check_out, r.body);

  console.log('\n8c. Cancellation policies');
  r = await call(host, 'PUT', `/shortlet/update/${sl.id}`, { cancellationPolicy: 'super-strict' });
  check('invalid policy rejected', r.status === 400 && /cancellationPolicy must be one of/.test(r.body.message), r.body);
  r = await call(host, 'PUT', `/shortlet/update/${sl.id}`, { cancellationPolicy: 'strict' });
  check('host sets Strict', r.status === 200 && r.body.data.cancellationPolicy === 'strict', r.body.data?.cancellationPolicy);
  r = await call(guest, 'GET', `/shortlet/quote/${sl.id}?checkIn=${d(120)}&checkOut=${d(122)}`);
  check('quote shows the Strict policy', r.body.data.cancellationPolicy.policy === 'strict' && r.body.data.cancellationPolicy.label === 'Strict', r.body.data.cancellationPolicy);
  r = await book(guest, d(120), d(122));
  const p1 = r.body.data;
  check('booking snapshots the policy', p1.cancellation_policy === 'strict');
  await call(host, 'PUT', `/shortlet/update/${sl.id}`, { cancellationPolicy: 'moderate' });
  r = await call(guest, 'GET', `/shortlet/bookings/${p1.id}`);
  check('changing the listing later does not change the booking', r.body.data.cancellation_policy === 'strict' && r.body.data.cancellation.policy === 'strict');
  r = await call(guest, 'GET', `/shortlet/bookings/${p1.id}`);
  check('Strict, just booked, >14 days out → full refund now', r.body.data.cancellation.refundAmount === '27000.00', r.body.data.cancellation);
  g0 = await bal(guest);
  res = await settlement.cancelBooking({ bookingId: p1.id, actorUserId: guest.id, now: at(115, '14:00:00') });
  check('Strict, 5 days before: no refund of nights, cleaning + deposit back (₦7,000)', res.terms.refundAmount === '7000.00' && (await bal(guest)) - g0 === 7000, res.terms);
  r = await book(guest, d(130), d(133));
  const p2 = r.body.data;
  check('new booking gets Moderate', p2.cancellation_policy === 'moderate');
  res = await settlement.cancelBooking({ bookingId: p2.id, actorUserId: guest.id, now: at(128, '14:00:00') });
  check('Moderate, 2 days before: first night kept, 50% of the rest + cleaning + deposit (₦17,000)', res.terms.refundAmount === '17000.00', res.terms);
  await call(host, 'PUT', `/shortlet/update/${sl.id}`, { cancellationPolicy: 'flexible' });

  console.log('\n9. Commission source (admin per-landlord value only)');
  await Users.update({ commission_percent: 50 }, { where: { id: host.id } });
  check('changing admin commission later does not change existing bookings', (await ShortletBookings.findByPk(s1.id)).host_payout === '25600.00');
  r = await book(guest, d(90), d(91));
  check('new booking uses the new admin commission (50%): host ₦6,000 of ₦12,000', (await ShortletBookings.findByPk(r.body.data.id)).host_payout === '6000.00');
  await Users.update({ commission_percent: null }, { where: { id: host.id } });
  r = await book(guest, d(100), d(101));
  check('no admin commission set → platform keeps 100%', (await ShortletBookings.findByPk(r.body.data.id)).host_payout === '0.00');

  console.log('\n10. Ledger & analytics');
  const guests = [guest.id, guest2.id, guest3.id];
  const charged = (await WalletTransactions.findAll({ where: { type: 'shortlet booking', role: 'payer', user_id: { [Op.in]: guests } } }))
    .reduce((a, t) => a + Number(t.amount), 0);
  const totals = (await ShortletBookings.findAll({ where: { shortlet_id: sl.id } })).reduce((a, b) => a + Number(b.total_amount), 0);
  check('wallet debits equal the sum of booking totals', charged === totals, { charged, totals });
  const after = await shortletAnalytics(admin);
  const mine = await ShortletBookings.findAll({ where: { shortlet_id: sl.id }, attributes: ['status'] });
  const n = (st) => mine.filter((b) => b.status === st).length;
  check('admin analytics counts match this run\'s bookings', after && analyticsBefore
    && after.completed - analyticsBefore.completed === n('completed') && after.cancelled - analyticsBefore.cancelled === n('cancelled')
    && after.confirmed - analyticsBefore.confirmed === n('confirmed'), { analyticsBefore, after, completed: n('completed'), cancelled: n('cancelled') });
}

(async () => {
  try {
    await db.sequelize.authenticate();
  } catch (e) {
    console.error(`Cannot reach the test database (${TEST_URL}). Start it with: npm run test:db:start\n${e.message}`);
    process.exit(1);
  }
  const server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
  try {
    await main();
  } catch (e) {
    fail++;
    console.error(e);
  } finally {
    await cleanup().catch((e) => console.error('Cleanup failed:', e.message));
    server.close();
    await db.sequelize.close();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
