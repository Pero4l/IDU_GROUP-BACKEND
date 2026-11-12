#!/usr/bin/env node
'use strict';
// Platform-level tests the other suites don't cover:
//   1. Socket.IO real-time chat — auth, who may join a conversation room,
//      live delivery, typing indicators.
//   2. Rate limits — each documented limit actually returns 429 with the
//      documented message (on a fresh app, so counters start at zero).
//   3. Background jobs — the 3-minute reconcile job that settles stuck
//      top-ups / withdrawals with Flutterwave.
//
// Boots the REAL app (index.js) with every outside service faked; local DB
// only; cleans up after itself.
//
//   npm run test:db:start
//   npm run test:platform

const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');
const ROOT = path.resolve(__dirname, '../..');

const TEST_URL = process.env.TEST_DATABASE_URL || 'postgres://test@127.0.0.1:55432/rentulo_test';
if (!['127.0.0.1', 'localhost', '::1'].includes(new URL(TEST_URL).hostname) && process.env.ALLOW_REMOTE_TEST_DB !== 'true') {
  console.error('Refusing to run against a non-local database. This test writes and deletes data.');
  process.exit(1);
}
const runId = crypto.randomUUID().slice(0, 8);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `rentulo-platform-${runId}-`));
const FLW_STATE = path.join(tmp, 'flw.json');
fs.writeFileSync(FLW_STATE, JSON.stringify({ charges: {}, transfers: {}, rejectTransfers: false }));
Object.assign(process.env, {
  DATABASE_URL: TEST_URL, DB_SSL_CA_PATH: '', NODE_ENV: 'test',
  JWT_SECRET: `test-${crypto.randomUUID()}`,
  ALLOWED_ORIGINS: 'https://rentulo.ng,http://localhost:3000',
  RECONCILE_CRON_ENABLED: 'false', SHORTLET_SETTLEMENT_CRON_ENABLED: 'false',
  EMAIL_USER: '', EMAIL_PASS: '', BREVO_API_KEY: '',
  TEST_FLW_STATE: FLW_STATE, FLW_SECRET_KEY: 'FLWSECK_TEST-fake', FLW_SECRET_HASH: 'test-webhook-hash',
  FLW_SIMULATE_TRANSFERS: '', OPENAI_API_KEY: 'sk-test',
});

// Fakes in THIS process too (the reconcile job runs here).
require('./helpers/stubExternal');
const { io: ioClient } = require('socket.io-client');
const jwt = require('jsonwebtoken');
const { Op } = require('sequelize');
const db = require(path.join(ROOT, 'models'));

let pass = 0, fail = 0;
const check = (name, cond, extra) => {
  if (cond) { pass++; console.log(`  ✔ ${name}`); }
  else { fail++; console.log(`  ✘ ${name}`, extra !== undefined ? JSON.stringify(extra).slice(0, 400) : ''); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let base, app;
function startApp() {
  return new Promise((resolve, reject) => {
    const port = 30000 + Math.floor(Math.random() * 20000);
    app = spawn(process.execPath, ['-r', path.join(__dirname, 'helpers/stubExternal.js'), 'index.js'], {
      cwd: ROOT, env: { ...process.env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    const timer = setTimeout(() => reject(new Error(`app did not start:\n${out}`)), 30000);
    const onData = (c) => { out += c; if (!base && out.includes('Database connected successfully')) { clearTimeout(timer); base = `http://127.0.0.1:${port}`; resolve(); } };
    app.stdout.on('data', onData); app.stderr.on('data', onData);
    app.on('exit', (code) => { clearTimeout(timer); if (!base) reject(new Error(`app exited (${code}):\n${out}`)); });
  });
}
const tokenFor = (u) => jwt.sign({ userId: u.id, role: u.role, email: u.email }, process.env.JWT_SECRET, { expiresIn: '1h' });
async function api(method, url, { as, body, headers = {} } = {}) {
  const h = { ...headers };
  if (as) h.authorization = `Bearer ${tokenFor(as)}`;
  if (body !== undefined) h['content-type'] = 'application/json';
  const r = await fetch(base + url, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

const createdEmails = [];
async function mkUser(name, extra = {}) {
  const email = `${name.toLowerCase().replace(/\s/g, '')}.${runId}@test.local`;
  createdEmails.push(email);
  const u = await db.Users.create({
    full_name: name, email, password: 'x', role: 'tenant', is_verified: true, gender: 'male',
    phone_no: `080${Math.floor(Math.random() * 1e8)}`, state: 'Lagos', address: 'Addr', ...extra,
  });
  await db.Wallet.create({ user_id: u.id, accountName: name, accountNumber: `TEST-${runId}-${createdEmails.length}`, balance: 0, status: 'ACTIVE' });
  return u;
}

// Socket helpers
function connect(token) {
  return new Promise((resolve) => {
    const s = ioClient(base, { auth: token ? { token } : {}, transports: ['websocket'], reconnection: false, timeout: 5000 });
    s.events = [];
    s.onAny((event, payload) => s.events.push({ event, payload }));
    s.on('connect', () => resolve({ socket: s, error: null }));
    s.on('connect_error', (err) => resolve({ socket: s, error: err.message }));
  });
}
const join = (s, id) => new Promise((resolve) => s.emit('join_conversation', id, resolve));

async function main() {
  const tenant = await mkUser('Socket Tenant');
  const landlord = await mkUser('Socket Landlord', { role: 'landlord' });
  const outsider = await mkUser('Nosy Neighbour');
  const admin = await mkUser('Socket Admin', { role: 'admin', is_superadmin: true });

  // ═══ 1. Socket.IO ═══
  console.log('\n1. Socket.IO real-time chat');
  let c = await connect(null);
  check('no token → connect_error "Authentication required"', c.error === 'Authentication required', c.error);
  c.socket.close();
  c = await connect('garbage');
  check('bad token → connect_error "Invalid or expired token"', c.error === 'Invalid or expired token', c.error);
  c.socket.close();

  let r = await api('POST', '/chat/conversation', { as: tenant, body: { other_user_id: landlord.id } });
  const conv = r.body.conversation;
  const t = (await connect(tokenFor(tenant))).socket;
  const l = (await connect(tokenFor(landlord))).socket;
  const o = (await connect(tokenFor(outsider))).socket;
  const a = (await connect(tokenFor(admin))).socket;
  check('participants connect with their JWT', t.connected && l.connected && o.connected);

  check('tenant joins their conversation (ack success)', (await join(t, conv.id)).success === true);
  check('landlord joins their conversation', (await join(l, conv.id)).success === true);
  const denied = await join(o, conv.id);
  await sleep(100);
  check('outsider is refused (ack + join_error event)', denied.success === false && denied.message === 'Not authorized to join this conversation'
    && o.events.some((e) => e.event === 'join_error'), { denied, events: o.events });
  check('unknown conversation → "Conversation not found"', (await join(t, crypto.randomUUID())).message === 'Conversation not found');
  check('garbage id → "Conversation not found"', (await join(t, 'not-a-uuid')).message === 'Conversation not found');
  check('admin can join any conversation (moderation)', (await join(a, conv.id)).success === true);
  check('old clients that send no ack callback still work', await new Promise((resolve) => {
    o.emit('join_conversation', conv.id); setTimeout(() => resolve(o.events.filter((e) => e.event === 'join_error').length === 2), 200);
  }));

  r = await api('POST', '/chat/message', { as: landlord, body: { conversation_id: conv.id, content: 'Live hello' } });
  await sleep(300);
  const got = (s) => s.events.find((e) => e.event === 'new_message' && e.payload?.data?.content === 'Live hello');
  check('message pushed live to the tenant (new_message)', r.status === 201 && got(t)?.payload?.success === true && got(t).payload.data.id === r.body.message.id, t.events);
  check('…and to the admin moderating', !!got(a));
  check('…but NOT to the outsider', !got(o), o.events);

  t.emit('typing', { conversation_id: conv.id, sender_id: outsider.id }); // spoofed sender
  await sleep(200);
  const typing = l.events.find((e) => e.event === 'user_typing');
  check('typing reaches the other participant with the REAL sender (spoofing ignored)', typing?.payload?.sender_id === tenant.id && typing.payload.conversation_id === conv.id, l.events);
  l.events.length = 0;
  o.emit('typing', { conversation_id: conv.id, sender_id: o.id });
  await sleep(200);
  check("an outsider who isn't in the room can't send typing events", !l.events.some((e) => e.event === 'user_typing'), l.events);
  for (const s of [t, l, o, a]) s.close();

  // ═══ 2. Rate limits ═══
  console.log('\n2. Rate limits (fresh app, counters at zero)');
  const hammer = async (n, fn) => { let last; for (let i = 0; i < n; i++) last = await fn(i); return last; };
  let last = await hammer(11, (i) => api('POST', '/auth/login', { body: { user: `nobody${i}.${runId}@test.local`, password: 'Wrong1234' } }));
  check('login: 11th attempt in 15 min → 429', last.status === 429 && last.body.message === 'Too many requests. Please try again later.', last);
  last = await hammer(6, (i) => api('POST', '/auth/register', { body: { full_name: 'Rate Limited', gender: 'male', role: 'tenant', email: `rl${i}.${runId}@test.local`, password: 'weak' } }));
  check('register / forgot-password: 6th in an hour → 429', last.status === 429 && last.body.message === 'Too many requests. Please try again later.', last);
  last = await hammer(11, () => api('POST', '/auth/verify-registration', { body: { email: `x.${runId}@test.local`, otpCode: '000000' } }));
  check('OTP checks: 11th in 15 min → 429 (OTP brute force blocked)', last.status === 429, last);
  last = await hammer(11, (i) => api('POST', '/waitlist', { body: { email: `wl${i}.${runId}@test.local` } }));
  createdEmails.push(...Array.from({ length: 11 }, (_, i) => `wl${i}.${runId}@test.local`));
  check('waitlist: 11th in an hour → 429', last.status === 429, last);
  r = await api('POST', '/subscriptions/subscribe', { as: tenant });
  check('…and the waitlist limit does not eat into subscribe (separate counters)', r.status === 201, r);
  last = await hammer(11, () => api('POST', '/wallet/withdraw', { as: tenant, body: { amount: 10, pin: '0000' } }));
  check('withdraw: 11th in 15 min → 429', last.status === 429 && last.body.message === 'Too many withdrawal attempts, please try again later.', last);
  r = await api('POST', '/wallet/withdraw', { as: landlord, body: { amount: 10, pin: '0000' } });
  check('…per user: another user is not affected', r.status !== 429, r);
  last = await hammer(11, () => api('POST', '/wallet/coupons/redeem', { as: tenant, body: { code: 'NOPE' } }));
  check('coupons: 11th in 15 min → 429', last.status === 429 && last.body.message === 'Too many coupon attempts, please try again later.', last);
  last = await hammer(31, () => api('POST', '/ai-support/chat', { as: landlord, body: {} }));
  check('AI chat: 31st in a minute → 429', last.status === 429 && last.body.message === 'You are sending messages too quickly. Please wait a moment.', last);
  last = await hammer(21, () => api('POST', '/support/tickets', { as: outsider, body: {} }));
  check('support: 21st in an hour → 429', last.status === 429 && last.body.message === 'You have reached the maximum number of support requests for now. Please try again later.', last);
  last = await hammer(201, () => api('GET', '/counts'));
  check('global: 201st request in 15 min from one IP → 429', last.status === 429 && last.body.message === 'Too many requests from this IP, please try again later.', last);
  r = await api('GET', '/notification', { as: admin });
  check('global limit is per user when logged in (admin unaffected)', r.status === 200, r.status);

  // ═══ 3. Background jobs ═══
  console.log('\n3. Background jobs');
  const { reconcilePendingTransactions } = require(path.join(ROOT, 'scripts/reconcilePendingTransactions'));
  const tw = await db.Wallet.findOne({ where: { user_id: tenant.id } });
  const mkTx = (fields) => db.WalletTransactions.create({ wallet_id: tw.id, user_id: tenant.id, status: 'pending', meta: { flwEnv: 'test' }, ...fields });
  const paid = await mkTx({ tx_ref: `RENTULO-TOPUP-paid-${runId}`, type: 'topup', amount: 7000 });
  const abandoned = await mkTx({ tx_ref: `RENTULO-TOPUP-abandoned-${runId}`, type: 'topup', amount: 3000 });
  const stillPaying = await mkTx({ tx_ref: `RENTULO-TOPUP-processing-${runId}`, type: 'topup', amount: 2000 });
  await db.Wallet.update({ balance: 9000 }, { where: { id: tw.id } }); // 9000 held for the two withdrawals below
  const wdOk = await mkTx({ tx_ref: `RENTULO-WD-ok-${runId}`, type: 'withdrawal', amount: 4000, flw_ref: '9001' });
  const wdBad = await mkTx({ tx_ref: `RENTULO-WD-bad-${runId}`, type: 'withdrawal', amount: 5000, flw_ref: '9002' });
  const s = JSON.parse(fs.readFileSync(FLW_STATE, 'utf8'));
  s.charges[paid.tx_ref] = { id: 111, tx_ref: paid.tx_ref, amount: 7000, status: 'successful' };
  s.charges[stillPaying.tx_ref] = { id: 112, tx_ref: stillPaying.tx_ref, amount: 2000, status: 'processing' };
  s.transfers['9001'] = { id: 9001, reference: wdOk.tx_ref, amount: 4000, status: 'SUCCESSFUL' };
  s.transfers['9002'] = { id: 9002, reference: wdBad.tx_ref, amount: 5000, status: 'FAILED' };
  fs.writeFileSync(FLW_STATE, JSON.stringify(s));
  await reconcilePendingTransactions();
  const st = async (tx) => (await db.WalletTransactions.findByPk(tx.id)).status;
  check('paid top-up the webhook missed → credited', (await st(paid)) === 'success');
  check('checkout never completed → failed (nothing credited)', (await st(abandoned)) === 'failed');
  check('charge still processing → left pending (never failed early)', (await st(stillPaying)) === 'pending');
  check('successful withdrawal → success', (await st(wdOk)) === 'success');
  check('failed withdrawal → failed and the ₦5,000 hold refunded', (await st(wdBad)) === 'failed');
  check('wallet: 9,000 + 7,000 top-up + 5,000 refund = ₦21,000', (await db.Wallet.findByPk(tw.id)).balance === '21000.00', (await db.Wallet.findByPk(tw.id)).balance);
  await reconcilePendingTransactions();
  check('running it again changes nothing (idempotent)', (await db.Wallet.findByPk(tw.id)).balance === '21000.00');
}

async function cleanup() {
  if (process.env.KEEP_TEST_DATA === 'true') return;
  const users = (await db.Users.findAll({ where: { email: { [Op.in]: createdEmails } }, attributes: ['id'] })).map((u) => u.id);
  const ids = { [Op.in]: users };
  const convs = (await db.Conversations.findAll({ where: { [Op.or]: [{ tenant_id: ids }, { landlord_id: ids }] } })).map((x) => x.id);
  await db.Messages.destroy({ where: { conversation_id: { [Op.in]: convs } } });
  await db.Conversations.destroy({ where: { id: { [Op.in]: convs } } });
  for (const m of ['WalletTransactions', 'Wallet', 'Notifications', 'AiSupport', 'Subscriptions', 'Pins']) {
    await db[m].destroy({ where: { user_id: ids } }).catch((e) => console.warn(`cleanup ${m}: ${e.message}`));
  }
  await db.PendingRegistrations.destroy({ where: { email: { [Op.like]: `%.${runId}@test.local` } } });
  await db.Waitlist.destroy({ where: { email: { [Op.in]: createdEmails } } });
  await db.Users.destroy({ where: { id: ids } });
}

(async () => {
  try { await db.sequelize.authenticate(); } catch (e) {
    console.error(`Cannot reach the test database (${TEST_URL}). Start it with: npm run test:db:start\n${e.message}`);
    process.exit(1);
  }
  try {
    await startApp();
    await main();
  } catch (e) { fail++; console.error(e); } finally {
    await cleanup().catch((e) => console.error('Cleanup failed:', e.message));
    if (app) app.kill();
    await db.sequelize.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
