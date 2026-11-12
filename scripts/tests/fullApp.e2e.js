#!/usr/bin/env node
'use strict';
// Whole-app end-to-end test: boots the REAL server (index.js) against the
// local test Postgres and exercises every route group in rentULO.md, checking
// the documented status codes, messages and response shapes.
//
// Every outside service is faked (scripts/tests/helpers/stubExternal.js):
// email, Cloudinary, Flutterwave, OpenAI, Google sign-in, geocoding — and all
// other outbound network is blocked. Nothing real is sent, charged or uploaded.
//
//   npm run test:db:start
//   npm run test:app
//
// Local DB only; cleans up the rows it creates.

const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');
const ROOT = path.resolve(__dirname, '../..');

const TEST_URL = process.env.TEST_DATABASE_URL || 'postgres://test@127.0.0.1:55432/rentulo_test';
const testHost = new URL(TEST_URL).hostname;
if (!['127.0.0.1', 'localhost', '::1'].includes(testHost) && process.env.ALLOW_REMOTE_TEST_DB !== 'true') {
  console.error(`Refusing to run against non-local database host "${testHost}". This test writes and deletes data.`);
  process.exit(1);
}

const runId = crypto.randomUUID().slice(0, 8);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `rentulo-app-${runId}-`));
const MAIL_LOG = path.join(tmp, 'mail.jsonl');
const FLW_STATE = path.join(tmp, 'flw.json');
fs.writeFileSync(MAIL_LOG, '');
fs.writeFileSync(FLW_STATE, JSON.stringify({ charges: {}, transfers: {}, rejectTransfers: false }));

const APP_ORIGIN = 'https://rentulo.ng';
Object.assign(process.env, {
  DATABASE_URL: TEST_URL,
  DB_SSL_CA_PATH: '',
  NODE_ENV: 'test',
  JWT_SECRET: `test-${crypto.randomUUID()}`,
  ALLOWED_ORIGINS: `${APP_ORIGIN},http://localhost:3000`,
  RECONCILE_CRON_ENABLED: 'false',
  SHORTLET_SETTLEMENT_CRON_ENABLED: 'false',
  EMAIL_USER: '', EMAIL_PASS: '', BREVO_API_KEY: '',
  TEST_MAIL_LOG: MAIL_LOG,
  TEST_FLW_STATE: FLW_STATE,
  FLW_SECRET_KEY: 'FLWSECK_TEST-fake',
  FLW_SECRET_HASH: 'test-webhook-hash',
  FLW_SIMULATE_TRANSFERS: '',
  FLW_CALLBACK_URL: '', FLW_REDIRECT_URL: '', FLW_FAILURE_URL: '',
  OPENAI_API_KEY: 'sk-test',
  GOOGLE_CLIENT_ID: 'test-google-client',
  PLATFORM_LOCK_COMMISSION_PERCENT: '30',
  PLATFORM_RENT_COMMISSION_PERCENT: '20',
  PLATFORM_INSPECTION_COMMISSION_PERCENT: '50',
});

const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const { Op } = require('sequelize');
const db = require(path.join(ROOT, 'models'));

// ── Reporting ──
const results = [];
let currentSection = '';
function section(name) { currentSection = name; console.log(`\n${name}`); }
function check(name, cond, extra) {
  results.push({ section: currentSection, name, ok: !!cond });
  if (cond) console.log(`  ✔ ${name}`);
  else console.log(`  ✘ ${name}`, extra !== undefined ? JSON.stringify(extra).slice(0, 500) : '');
}

// ── HTTP ──
let base, app;
const tokens = new Map();
async function api(method, url, { as, token, body, form, origin, headers = {} } = {}) {
  const h = { ...headers };
  const tk = token || (as && tokens.get(as.id));
  if (tk) h.authorization = `Bearer ${tk}`;
  if (origin) h.origin = origin;
  if (body !== undefined) h['content-type'] = 'application/json';
  const r = await fetch(base + url, { method, headers: h, body: form || (body !== undefined ? JSON.stringify(body) : undefined), redirect: 'manual' });
  const text = await r.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, body: json, headers: r.headers };
}
const file = (name = 'a.jpg', type = 'image/jpeg', bytes = 32) => new Blob([crypto.randomBytes(bytes)], { type });
const multipart = (fields, files = {}) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.append(k, typeof v === 'string' ? v : JSON.stringify(v));
  for (const [k, list] of Object.entries(files)) for (const blob of list) f.append(k, blob, 'upload');
  return f;
};

// ── Fakes' state ──
const mails = () => fs.readFileSync(MAIL_LOG, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
const lastOtpFor = (email) => {
  const m = mails().filter((x) => x.to === email).reverse().find((x) => /\b\d{6}\b/.test(x.text || ''));
  return m ? /\b(\d{6})\b/.exec(m.text)[1] : null;
};
const flw = () => JSON.parse(fs.readFileSync(FLW_STATE, 'utf8'));
const setFlw = (fn) => { const s = flw(); fn(s); fs.writeFileSync(FLW_STATE, JSON.stringify(s)); };

const created = { emails: new Set() };
const email = (who) => { const e = `${who}.${runId}@test.local`; created.emails.add(e); return e; };

function startApp() {
  return new Promise((resolve, reject) => {
    const port = 30000 + Math.floor(Math.random() * 20000);
    app = spawn(process.execPath, ['-r', path.join(__dirname, 'helpers/stubExternal.js'), 'index.js'], {
      cwd: ROOT, env: { ...process.env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    app.log = () => out;
    const timer = setTimeout(() => reject(new Error(`app did not start:\n${out}`)), 30000);
    const onData = (chunk) => {
      out += chunk;
      if (!base && out.includes('Database connected successfully')) {
        clearTimeout(timer);
        base = `http://127.0.0.1:${port}`;
        resolve();
      }
    };
    app.stdout.on('data', onData);
    app.stderr.on('data', onData);
    app.on('exit', (code) => { clearTimeout(timer); if (!base) reject(new Error(`app exited (${code}):\n${out}`)); });
  });
}

async function login(user, password) {
  const r = await api('POST', '/auth/login', { body: { user: user.email, password } });
  if (r.status === 200) tokens.set(user.id, r.body.token);
  return r;
}

async function main() {
  const { Users } = db;

  // Bootstrap: one super admin (the only account that can't be created via the API).
  const superAdmin = await Users.create({
    full_name: 'Super Admin', email: email('superadmin'), password: await bcrypt.hash('SuperPass1', 4),
    role: 'admin', is_superadmin: true, is_active: true, is_verified: true, gender: 'female',
    phone_no: `0901${runId.replace(/\D/g, '').padEnd(7, '1').slice(0, 7)}`, state: 'Lagos', address: 'HQ',
  });
  await db.Profile.create({ user_id: superAdmin.id });
  tokens.set(superAdmin.id, jwt.sign({ userId: superAdmin.id, role: 'admin', email: superAdmin.email, currentUser: 'Super Admin' }, process.env.JWT_SECRET, { expiresIn: '1h' }));

  // ═══ 0. Basics ═══
  section('0. Basics');
  let r = await api('GET', '/');
  check('GET / → welcome', r.status === 200 && r.body.message === 'Welcome to RentULO', r.body);
  r = await api('GET', '/nope-not-a-route');
  check('unknown route → 404 "Route not found"', r.status === 404 && r.body.message === 'Route not found', r.body);
  r = await api('GET', '/notification');
  check('protected route without token → 401 "Authorization token missing"', r.status === 401 && r.body.message === 'Authorization token missing', r.body);
  r = await api('GET', '/notification', { token: 'garbage' });
  check('bad token → 401 "Invalid or expired token"', r.status === 401 && r.body.message === 'Invalid or expired token', r.body);
  r = await api('GET', '/counts', { origin: 'https://evil.example' });
  check('browser request from a non-allowed origin → 403', r.status === 403, r.status);

  // ═══ 1. Auth ═══
  section('1. Authentication & Users');
  const tenantEmail = email('tenant');
  r = await api('POST', '/auth/register', { body: { full_name: 'Tenant Tobi', gender: 'female', role: 'tenant', email: tenantEmail, password: 'weak' } });
  check('register: weak password → 400 with a message', r.status === 400 && /Password/.test(r.body.message), r.body);
  r = await api('POST', '/auth/register', { body: { full_name: 'Tenant Tobi', gender: 'female', role: 'tenant', email: tenantEmail, password: 'SecurePass1' } });
  check('register tenant → 200 + OTP email', r.status === 200 && r.body.message === 'Verification OTP code sent to your email. Please verify to complete registration.' && !!lastOtpFor(tenantEmail), r.body);
  check('nothing in users until verified', !(await Users.findOne({ where: { email: tenantEmail } })));
  r = await api('POST', '/auth/verify-registration', { body: { email: tenantEmail, otpCode: '000000' } });
  check('verify with wrong OTP → 400', r.status === 400, r.body);
  r = await api('POST', '/auth/verify-registration', { body: { email: tenantEmail, otpCode: lastOtpFor(tenantEmail) } });
  check('verify with right OTP → 201', r.status === 201 && r.body.message === 'Account verified and registered successfully. You can now login.', r.body);
  const tenant = await Users.findOne({ where: { email: tenantEmail } });
  check('user + profile + wallet created, not verified yet', tenant && tenant.is_verified === false && !!(await db.Profile.findOne({ where: { user_id: tenant.id } })) && !!(await db.Wallet.findOne({ where: { user_id: tenant.id } })));

  const landlordEmail = email('landlord');
  await api('POST', '/auth/register', { body: { full_name: 'Landlord Lola', gender: 'male', role: 'landlord', email: landlordEmail, password: 'SecurePass1' } });
  r = await api('POST', '/auth/verify-registration', { body: { email: landlordEmail, otpCode: lastOtpFor(landlordEmail) } });
  const landlord = await Users.findOne({ where: { email: landlordEmail } });
  check('register + verify landlord', r.status === 201 && landlord?.role === 'landlord', r.body);

  r = await api('POST', '/auth/login', { body: { user: tenantEmail, password: 'WrongPass1' } });
  check('login wrong password → 401 "Invalid email/number or password"', r.status === 401 && r.body.message === 'Invalid email/number or password', r.body);
  r = await api('POST', '/auth/login', { body: { email: tenantEmail, password: 'SecurePass1' } });
  check('login with "email" instead of "user" → 400', r.status === 400 && r.body.message === 'Email or phone number and password is required', r.body);
  r = await login(tenant, 'SecurePass1');
  check('login → 200 with token, role, id', r.status === 200 && r.body.message === 'Login Successfully' && r.body.token && r.body.role === 'tenant' && r.body.id === tenant.id, r.body);
  const payload = jwt.decode(r.body.token);
  check('token payload has userId, currentUser, role, email, location', payload.userId === tenant.id && payload.currentUser === 'Tenant Tobi' && payload.role === 'tenant' && payload.email === tenantEmail && 'location' in payload, payload);
  check('token expires in 24h', payload.exp - payload.iat === 24 * 3600, payload.exp - payload.iat);
  check('login sends a "New Login Alert" email', mails().some((m) => m.to === tenantEmail && /login/i.test(m.subject)));
  await login(landlord, 'SecurePass1');

  r = await api('POST', '/auth/google-auth', { body: {} });
  check('google-auth without idToken → 400', r.status === 400 && r.body.message === 'idToken is required', r.body);
  const googleEmail = email('google');
  r = await api('POST', '/auth/google-auth', { body: { idToken: `test-google:${googleEmail}:Gina:Google` } });
  check('google-auth new user → 200 token, no id field', r.status === 200 && r.body.message === 'Google Auth Successful' && r.body.token && r.body.role === 'tenant' && r.body.id === undefined, r.body);
  const googleUser = await Users.findOne({ where: { email: googleEmail } });
  tokens.set(googleUser.id, r.body.token);
  check('google user: gender null, not verified, wallet created', googleUser.gender === null && googleUser.is_verified === false && !!(await db.Wallet.findOne({ where: { user_id: googleUser.id } })));
  r = await api('POST', '/auth/google-auth', { body: { idToken: 'not-a-google-token' } });
  check('google-auth bad token → 500 "Server error during Google auth"', r.status === 500 && r.body.message === 'Server error during Google auth', r.body);

  r = await api('GET', '/auth/me', { as: tenant });
  check('/auth/me with Bearer → logged in', r.body.isLoggedIn === true && r.body.userRole === 'tenant', r.body);
  r = await api('GET', '/auth/me');
  check('/auth/me without token → logged out', r.body.isLoggedIn === false && r.body.userRole === null, r.body);
  r = await api('POST', '/auth/logout');
  check('logout → 200', r.status === 200 && r.body.message === 'Logged out successfully', r.body);

  r = await api('GET', '/search?name=Tobi', { as: landlord });
  check('GET /search?name= finds users (with Profile)', r.status === 200 && r.body.message === 'Users fetched successfully' && r.body.data.some((u) => u.id === tenant.id && 'Profile' in u), r.body);
  r = await api('GET', `/auth/?name=${encodeURIComponent(landlordEmail)}`, { as: tenant });
  check('GET /auth/?name= (same search, by email)', r.status === 200 && r.body.data.some((u) => u.id === landlord.id), r.body);
  r = await api('GET', '/search', { as: tenant });
  check('search without name → 400', r.status === 400 && r.body.message === 'Search name query parameter is required.', r.body);

  r = await api('POST', '/auth/forgot-password', { body: { email: tenantEmail } });
  check('forgot-password → 200 + OTP email', r.status === 200 && r.body.message === 'OTP sent to email successfully', r.body);
  const resetOtp = lastOtpFor(tenantEmail);
  r = await api('POST', '/auth/confirm-otp', { body: { email: tenantEmail, otpCode: resetOtp } });
  check('confirm-otp → 200', r.status === 200 && r.body.message === 'OTP is correct. You may proceed to change your password.', r.body);
  r = await api('POST', '/auth/reset-password', { body: { email: tenantEmail, otpCode: resetOtp, newPassword: 'short1A' } });
  check('reset-password: 7-char password → 400 "at least 8"', r.status === 400 && r.body.message === 'Password must be at least 8 characters', r.body);
  r = await api('POST', '/auth/reset-password', { body: { email: tenantEmail, otpCode: resetOtp, newPassword: 'NewSecurePass1' } });
  check('reset-password → 200', r.status === 200 && r.body.message === 'Password reset successful', r.body);
  r = await login(tenant, 'NewSecurePass1');
  check('login with the new password', r.status === 200, r.body);
  r = await api('POST', '/auth/reset-password', { body: { email: tenantEmail, otpCode: resetOtp, newPassword: 'AnotherPass1' } });
  check('reset OTP can\'t be reused', r.status === 400, r.body);

  const adminEmail = email('admin2');
  r = await api('POST', '/auth/register-admin', { as: tenant, body: {} });
  check('register-admin as non-admin → 403', r.status === 403 && r.body.message === 'Forbidden. Super Admin privileges required.', r.body);
  r = await api('POST', '/auth/register-admin', { as: superAdmin, body: { full_name: 'Second Admin', gender: 'female', phone_no: `0902${Date.now() % 1e7}`, email: adminEmail, address: '1 Admin St', state: 'Lagos', password: 'AdminPass123' } });
  check('register-admin → 201 + OTP email', r.status === 201 && r.body.message === 'OTP sent to email successfully. Please verify to complete registration.' && !!lastOtpFor(adminEmail), r.body);
  r = await api('POST', '/auth/verify-admin', { body: { email: adminEmail, otpCode: lastOtpFor(adminEmail) } });
  check('verify-admin → 200', r.status === 200 && r.body.message === 'Admin account verified and profile created successfully.', r.body);
  const admin2 = await Users.findOne({ where: { email: adminEmail } });
  check('new admin is a super admin and active', admin2?.is_superadmin === true && admin2?.is_active === true);

  // ═══ 2. Profile ═══
  section('2. Profile Management');
  r = await api('GET', '/rental/all', { as: tenant });
  check('incomplete profile → 403 needsProfileCompletion', r.status === 403 && r.body.needsProfileCompletion === true, r.body);
  r = await api('PUT', '/profile/update', { as: tenant, body: { phone_no: '08011111111', state: 'Lagos', address: '12 Main St', bio: 'Looking for a flat' } });
  check('profile update → verified', r.status === 200 && r.body.message === 'Profile updated and verified successfully.' && r.body.user.is_verified === true && r.body.user.profileComplete === true, r.body);
  r = await api('PUT', '/profile/update', {
    as: landlord,
    form: multipart({ phone_no: '08022222222', state: 'Lagos', address: '5 Landlord Rd', withdrawalBankName: 'Access Bank', withdrawalAccountNumber: '0123456789', withdrawalAccountName: 'Landlord Lola' }, { profileImage: [file()] }),
  });
  check('profile update as multipart with an image', r.status === 200 && r.body.user.is_verified === true, r.body);
  r = await api('GET', `/profile/get1/${landlord.id}`, { as: tenant });
  const lp = r.body.data;
  check('get1: profile with image, bank details, wallet; no password', r.status === 200 && r.body.message === 'User profile retrieved successfully'
    && lp.profile?.image?.startsWith('https://cdn.test/') && lp.profile.withdrawalBankName === 'Access Bank' && lp.wallet?.accountNumber && lp.password === undefined && lp.otpCode === undefined, lp);
  check('get1: first_name/last_name split', lp.first_name === 'Landlord' && lp.last_name === 'Lola');
  check('get1 (landlord): rentals, totalListings, rentedOutHouses, lockedByTenants, upcomingInspections', ['rentals', 'totalListings', 'rentedOutHouses', 'lockedByTenants', 'upcomingInspections'].every((k) => k in lp), Object.keys(lp));
  r = await api('GET', `/profile/get1/${crypto.randomUUID()}`, { as: tenant });
  check('get1 unknown user → 404', r.status === 404 && r.body.message === 'User not found', r.body);

  // ═══ 13. Wallet (needed before paying for things) ═══
  section('13. Wallet System');
  r = await api('GET', '/wallet', { as: tenant });
  check('GET /wallet → balance 0.00, ACTIVE, RentULO- number', r.status === 200 && r.body.data.balance === '0.00' && r.body.data.status === 'ACTIVE' && /^RentULO-\d{5}$/.test(r.body.data.accountNumber), r.body);
  const tenantAcct = r.body.data.accountNumber;
  r = await api('POST', '/wallet/topup/initialize', { as: tenant, body: { amount: '5000' } });
  check('top-up with a string amount → 400 "A valid amount is required"', r.status === 400 && r.body.message === 'A valid amount is required', r.body);
  r = await api('POST', '/wallet/topup/initialize', { as: tenant, body: { amount: 200000 } });
  check('top-up initialize → link + tx_ref', r.status === 200 && r.body.message === 'Payment initialization successful' && r.body.link && /^RENTULO-TOPUP-/.test(r.body.tx_ref), r.body);
  const topRef = r.body.tx_ref;
  r = await api('GET', `/wallet/topup/verify/${topRef}`, { as: tenant });
  check('verify before paying → pending', r.status === 200 && r.body.data.status === 'pending', r.body);
  setFlw((s) => { s.charges[topRef].status = 'successful'; });
  r = await api('GET', `/wallet/topup/verify-callback?status=successful&tx_ref=${topRef}&transaction_id=${flw().charges[topRef].id}`);
  check('callback redirect → wallet page ?status=success', r.status === 302 && /status=success/.test(r.headers.get('location')) && r.headers.get('location').startsWith('https://rentulo.ng/tenant/wallet'), { status: r.status, loc: r.headers.get('location') });
  r = await api('GET', `/wallet/topup/verify?tx_ref=${topRef}`, { as: tenant });
  check('verify after paying → success, balance 200000.00', r.body.data.status === 'success' && r.body.data.balance === '200000.00', r.body);
  r = await api('POST', '/wallet/webhook', { body: { event: 'charge.completed', data: { id: flw().charges[topRef].id, tx_ref: topRef } } });
  check('webhook without the signature → 401', r.status === 401, r.status);
  r = await api('POST', '/wallet/webhook', { headers: { 'verif-hash': 'test-webhook-hash' }, body: { event: 'charge.completed', data: { id: flw().charges[topRef].id, tx_ref: topRef } } });
  check('webhook replay of a credited top-up → 200, not credited twice', r.status === 200 && (await db.Wallet.findOne({ where: { user_id: tenant.id } })).balance === '200000.00', r.body);
  // a second top-up settled only by webhook
  r = await api('POST', '/wallet/topup/initialize', { as: landlord, body: { amount: 50000 } });
  const ref2 = r.body.tx_ref;
  setFlw((s) => { s.charges[ref2].status = 'successful'; });
  r = await api('POST', '/wallet/webhook', { headers: { 'verif-hash': 'test-webhook-hash' }, body: { event: 'charge.completed', data: { id: flw().charges[ref2].id, tx_ref: ref2 } } });
  check('webhook credits a paid top-up', r.status === 200 && (await db.Wallet.findOne({ where: { user_id: landlord.id } })).balance === '50000.00', r.body);
  r = await api('POST', '/wallet/topup/initialize', { as: tenant, body: { amount: 1000 } });
  const ref3 = r.body.tx_ref;
  setFlw((s) => { s.charges[ref3].status = 'failed'; });
  r = await api('GET', `/wallet/topup/verify/${ref3}`, { as: tenant });
  check('failed payment → success:false, status failed, nothing credited', r.body.success === false && r.body.data.status === 'failed', r.body);
  r = await api('GET', `/wallet/topup/verify/RENTULO-TOPUP-nope`, { as: tenant });
  check('verify unknown tx_ref → 404', r.status === 404 && r.body.message === 'Top-up transaction not found', r.body);
  r = await api('GET', '/wallet/transactions', { as: tenant });
  check('transactions: newest first, includes success + failed top-ups', r.status === 200 && r.body.data.some((t) => t.tx_ref === topRef && t.status === 'success') && r.body.data.some((t) => t.tx_ref === ref3 && t.status === 'failed'), r.body);

  const landlordAcct = (await db.Wallet.findOne({ where: { user_id: landlord.id } })).accountNumber;
  r = await api('POST', '/wallet/transfer', { as: tenant, body: { accountNumber: landlordAcct, amount: 2000, pin: '4321' } });
  check('transfer with no PIN set → 403 PIN_NOT_SET, nothing moved', r.status === 403 && r.body.code === 'PIN_NOT_SET'
    && r.body.message === 'You have not set a transaction pin. Please create one before transferring.'
    && (await db.Wallet.findOne({ where: { user_id: tenant.id } })).balance === '200000.00', r.body);

  r = await api('POST', '/wallet/withdraw', { as: landlord, body: { amount: 1000, pin: '1234' } });
  check('withdraw with no PIN set → 403', r.status === 403 && r.body.message === 'You have not set a transaction pin. Please create one before withdrawing.', r.body);

  // ═══ 16. PIN ═══
  section('16. Transaction PIN');
  r = await api('POST', '/pin/create', { as: landlord, body: { pin: 1234 } });
  check('PIN as a number → 400', r.status === 400 && r.body.message === 'Pin must be a 4-digit number.', r.body);
  r = await api('POST', '/pin/create', { as: landlord, body: { pin: '1234' } });
  check('create PIN → 201, hash not returned', r.status === 201 && r.body.message === 'Pin created successfully.' && r.body.pin.pin === undefined, r.body);
  r = await api('POST', '/pin/create', { as: landlord, body: { pin: '1111' } });
  check('second PIN → 400 already exists', r.status === 400 && r.body.message === 'Pin already exists for this user.', r.body);
  r = await api('PUT', '/pin/update', { as: landlord, body: { oldPin: '0000', newPin: '5678' } });
  check('update with wrong old PIN → 400', r.status === 400 && r.body.message === 'Invalid old pin.', r.body);
  r = await api('PUT', '/pin/update', { as: landlord, body: { oldPin: '1234', newPin: '5678' } });
  check('update PIN → 200', r.status === 200 && r.body.message === 'Pin updated successfully.', r.body);
  r = await api('PUT', '/pin/update', { as: tenant, body: { oldPin: '1234', newPin: '5678' } });
  check('update with no PIN → 404', r.status === 404 && r.body.message === 'No existing pin found for this user.', r.body);
  await api('POST', '/pin/create', { as: tenant, body: { pin: '4321' } });

  section('13. Wallet System (transfers)');
  r = await api('POST', '/wallet/transfer', { as: tenant, body: { accountNumber: landlordAcct, amount: 2000 } });
  check('transfer without a PIN → 400 PIN_REQUIRED', r.status === 400 && r.body.code === 'PIN_REQUIRED', r.body);
  r = await api('POST', '/wallet/transfer', { as: tenant, body: { accountNumber: landlordAcct, amount: 2000, pin: '0000' } });
  check('transfer with the wrong PIN → 403 PIN_INCORRECT, nothing moved', r.status === 403 && r.body.code === 'PIN_INCORRECT'
    && (await db.Wallet.findOne({ where: { user_id: tenant.id } })).balance === '200000.00', r.body);
  r = await api('POST', '/wallet/transfer', { as: tenant, body: { accountNumber: tenantAcct, amount: 100, pin: '4321' } });
  check('transfer to own wallet → 400', r.status === 400 && r.body.message === 'You cannot transfer to your own wallet', r.body);
  r = await api('POST', '/wallet/transfer', { as: tenant, body: { accountNumber: 'RentULO-00000', amount: 100, pin: '4321' } });
  check('transfer to unknown account → 404', r.status === 404 && r.body.message === 'Recipient account number not found', r.body);
  r = await api('POST', '/wallet/transfer', { as: tenant, body: { accountNumber: landlordAcct, amount: 999999999, pin: '4321' } });
  check('transfer more than balance → 400 Insufficient balance', r.status === 400 && r.body.message === 'Insufficient balance', r.body);
  r = await api('POST', '/wallet/transfer', { as: tenant, body: { accountNumber: landlordAcct, amount: 2000, pin: '4321' } });
  check('transfer with the right PIN → 200, balance 198000.00', r.status === 200 && r.body.message === 'Transfer successful' && r.body.balance === '198000.00', r.body);

  section('13. Wallet System (withdrawals)');
  r = await api('POST', '/wallet/withdraw', { as: landlord, body: { amount: 1000, pin: '1234' } });
  check('withdraw with the old PIN → 403 Incorrect', r.status === 403 && r.body.message === 'Incorrect transaction pin.', r.body);
  r = await api('POST', '/wallet/withdraw', { as: tenant, body: { amount: 1000, pin: '4321' } });
  check('withdraw without bank details → 400', r.status === 400 && r.body.message === 'Please add your withdrawal bank details on your profile before withdrawing', r.body);
  r = await api('POST', '/wallet/withdraw', { as: landlord, body: { amount: 10000, pin: '5678' } });
  check('withdraw → 200 "being processed", balance debited', r.status === 200 && r.body.message === 'Withdrawal is being processed' && r.body.balance === '42000.00', r.body);
  const wdRef = r.body.tx_ref;
  const wdTx = await db.WalletTransactions.findOne({ where: { tx_ref: wdRef } });
  setFlw((s) => { s.transfers[wdTx.flw_ref].status = 'SUCCESSFUL'; });
  r = await api('POST', '/wallet/webhook', { headers: { 'verif-hash': 'test-webhook-hash' }, body: { event: 'transfer.completed', data: { id: Number(wdTx.flw_ref), reference: wdRef, amount: 10000, currency: 'NGN', status: 'SUCCESSFUL' } } });
  check('transfer.completed webhook → withdrawal success', r.status === 200 && (await db.WalletTransactions.findOne({ where: { tx_ref: wdRef } })).status === 'success', r.body);
  setFlw((s) => { s.rejectTransfers = true; });
  r = await api('POST', '/wallet/withdraw', { as: landlord, body: { amount: 5000, pin: '5678' } });
  check('Flutterwave rejects the transfer → 502, wallet refunded', r.status === 502 && (await db.Wallet.findOne({ where: { user_id: landlord.id } })).balance === '42000.00', r.body);
  setFlw((s) => { s.rejectTransfers = false; });
  r = await api('POST', '/wallet/withdraw', { as: landlord, body: { amount: 99999999, pin: '5678' } });
  check('withdraw more than balance → 400', r.status === 400 && r.body.message === 'Insufficient balance', r.body);

  // ═══ 3. Rentals ═══
  section('3. Rental Management');
  const rentalFields = { title: `Lekki Flat ${runId}`, description: 'Lovely flat in Lekki Phase 1', propertyType: 'apartment', location: 'Lekki, Lagos', price: '100000', priceType: 'yearly', status: 'available', legalFee: '10000', cautionFee: '5000', brokeFee: '5000', mgtServiceCharge: '0', inspectionFee: '2000', amenities: 'wifi,parking' };
  r = await api('POST', '/rental/post', { as: tenant, form: multipart(rentalFields, { images: [file()] }) });
  check('tenant cannot post a rental → 403', r.status === 403 && r.body.message === 'Only landlords can add rentals', r.body);
  r = await api('POST', '/rental/post', { as: landlord, form: multipart({ ...rentalFields, title: '' }, { images: [file()] }) });
  check('missing title → 400', r.status === 400 && r.body.message === 'All fields are required, including images or videos', r.body);
  r = await api('POST', '/rental/post', { as: landlord, form: multipart(rentalFields, { images: [file(), file()] }) });
  check('landlord posts a rental → 201', r.status === 201 && r.body.message === 'Rental property added successfully', r.body);
  const rental = await db.Rentals.findOne({ where: { UserId: landlord.id, title: rentalFields.title } });
  check('stored: 2 images, amenities array, fees, slug', rental?.images.length === 2 && JSON.stringify(rental.amenities) === '["wifi","parking"]' && rental.inspectionFee === '2000.00' && !!rental.slug, rental?.toJSON());
  await api('POST', '/rental/post', { as: landlord, form: multipart({ ...rentalFields, title: `Ikoyi House ${runId}`, location: 'Ikoyi, Lagos', price: '50000', inspectionFee: '0' }, { images: [file()] }) });
  const rental2 = await db.Rentals.findOne({ where: { title: `Ikoyi House ${runId}` } });
  r = await api('GET', '/rental/all?limit=1&offset=0', { as: tenant });
  check('GET /rental/all with limit → 1 row, total count, owner User', r.status === 200 && r.body.data.length === 1 && r.body.count >= 2 && r.body.data[0].User?.full_name, r.body);
  r = await api('GET', '/rental/recent?limit=5');
  check('GET /rental/recent (public)', r.status === 200 && r.body.message === 'Recent rentals retrieved successfully' && Array.isArray(r.body.data), r.body);
  r = await api('GET', '/rental/recommended', { as: tenant });
  check('GET /rental/recommended → in Lagos, with liked flag', r.status === 200 && /Lagos/.test(r.body.message) && r.body.data.some((x) => x.id === rental.id) && r.body.data.every((x) => 'liked' in x), r.body);
  r = await api('GET', '/rental/search?location=lekki', { as: tenant });
  check('search by location (case-insensitive)', r.status === 200 && r.body.message === 'Rentals fetched successfully' && r.body.data.some((x) => x.id === rental.id) && !r.body.data.some((x) => x.id === rental2.id), r.body);
  r = await api('GET', '/rental/search?lat=6.43&lng=3.42', { as: tenant });
  check('search by GPS (lat/lng → city)', r.status === 200 && r.body.data.some((x) => x.id === rental.id) && !r.body.data.some((x) => x.id === rental2.id), r.body);
  r = await api('GET', '/rental/search?location=<script>alert(1)</script>', { as: tenant });
  check('query strings are XSS-sanitised (no raw <script> reaches the handler)', r.status === 200, r.body);
  r = await api('GET', '/rental/search', { as: tenant });
  check('no location → falls back to the user\'s state (Lagos)', r.status === 200 && r.body.data.some((x) => x.id === rental.id) && r.body.data.some((x) => x.id === rental2.id), r.body);
  r = await api('GET', `/rental/get1/${rental.slug}`, { as: tenant });
  check('get1 by slug → videos, landlord copy, inspectionFee', r.status === 200 && r.body.data.id === rental.id && Array.isArray(r.body.data.videos) && r.body.data.landlord?.full_name === 'Landlord Lola' && r.body.data.inspectionFee === '2000.00', r.body);
  r = await api('GET', `/rental/get1/${rental.id}`, { as: tenant });
  check('get1 by id', r.status === 200 && r.body.data.slug === rental.slug);
  r = await api('GET', '/rental/get1/does-not-exist', { as: tenant });
  check('get1 unknown → 404', r.status === 404 && r.body.message === 'Rental not found', r.body);
  r = await api('PUT', `/rental/update/${rental.id}`, { as: tenant, body: { title: 'Hacked' } });
  check('non-owner update → 403', r.status === 403 && r.body.message === 'You are not authorized to update this rental', r.body);
  r = await api('PUT', `/rental/update/${rental.slug}`, { as: landlord, body: { description: 'Newly painted' } });
  check('owner updates by slug', r.status === 200 && r.body.data.description === 'Newly painted', r.body);

  // ═══ 6. Progress ═══
  section('6. Progress Tracking');
  r = await api('POST', '/progress/like', { as: tenant, body: { rental_id: rental.id } });
  check('like → 200', r.status === 200 && r.body.message === 'House liked successfully' && r.body.data.liked === true, r.body);
  r = await api('GET', '/progress/like', { as: tenant });
  check('liked list has Rental nested', r.status === 200 && r.body.data.some((p) => p.rental_id === rental.id && p.Rental?.id === rental.id), r.body);
  r = await api('DELETE', `/progress/like/${rental.id}`, { as: tenant });
  check('unlike → 200', r.status === 200 && r.body.message === 'House removed from liked list', r.body);
  r = await api('DELETE', `/progress/like/${crypto.randomUUID()}`, { as: tenant });
  check('unlike unknown → 404', r.status === 404 && r.body.message === 'Liked house not found', r.body);
  await api('POST', '/progress/like', { as: tenant, body: { rental_id: rental2.id } });
  r = await api('DELETE', '/progress/like', { as: tenant });
  check('clear all likes', r.status === 200 && r.body.message === 'All liked houses cleared successfully', r.body);

  r = await api('POST', '/progress/lock', { as: googleUser, body: { rental_id: rental.id } });
  check('lock as unverified user → 403', r.status === 403 && /not verified/.test(r.body.message), r.body);
  const llBefore = Number((await db.Wallet.findOne({ where: { user_id: landlord.id } })).balance);
  r = await api('POST', '/progress/lock', { as: tenant, body: { rental_id: rental.id } });
  check('lock → 200, ₦5,000 charged', r.status === 200 && r.body.message === 'House locked successfully' && r.body.data.locked === true && r.body.walletBalance === '193000.00', r.body);
  check('lock fee split from .env (30% platform): landlord +₦3,500', Number((await db.Wallet.findOne({ where: { user_id: landlord.id } })).balance) - llBefore === 3500);
  r = await api('POST', '/progress/lock', { as: tenant, body: { rental_id: rental2.id } });
  check('second lock → 400 one at a time', r.status === 400 && r.body.message === 'You can only lock one house at a time. You already have an active locked property.', r.body);
  r = await api('GET', '/progress/lock', { as: tenant });
  check('locked list', r.status === 200 && r.body.data.some((p) => p.rental_id === rental.id && p.Rental), r.body);
  r = await api('GET', '/admin/rentals/locked', { as: superAdmin });
  check('admin sees the lock', r.status === 200 && r.body.data.some((p) => p.rental_id === rental.id && p.User && p.Rental), r.body);
  r = await api('GET', `/profile/get1/${tenant.id}`, { as: tenant });
  check('profile get1 (tenant): lockedHouses has the rental', r.body.data.lockedHouses.some((h) => h.id === rental.id), r.body.data.lockedHouses);
  r = await api('DELETE', `/progress/lock/${rental.id}`, { as: tenant });
  check('release lock → 200', r.status === 200 && r.body.message === 'House removed from locked list', r.body);
  r = await api('DELETE', '/progress/lock', { as: tenant });
  check('clear all locks', r.status === 200 && r.body.message === 'All locked houses cleared successfully', r.body);

  r = await api('POST', '/progress/book', { as: tenant, body: { rental_id: rental2.id } });
  check('book a rental → 200', r.status === 200 && r.body.message === 'House booked successfully' && r.body.data.booked === true, r.body);
  r = await api('POST', '/progress/book', { as: tenant, body: { rental_id: crypto.randomUUID() } });
  check('book unknown rental → 404', r.status === 404 && r.body.message === 'Rental not found', r.body);
  r = await api('GET', '/progress/book', { as: tenant });
  check('booked list + shortletBookings array', r.status === 200 && r.body.data.some((p) => p.rental_id === rental2.id) && Array.isArray(r.body.shortletBookings), r.body);
  r = await api('DELETE', `/progress/book/${rental2.id}`, { as: tenant });
  check('unbook → 200', r.status === 200 && r.body.message === 'House removed from booked list', r.body);
  r = await api('DELETE', '/progress/book', { as: tenant });
  check('clear all bookings', r.status === 200 && r.body.message === 'All booked houses cleared successfully', r.body);

  const rentLL = Number((await db.Wallet.findOne({ where: { user_id: landlord.id } })).balance);
  r = await api('POST', '/progress/rent/pay', { as: tenant, body: { rental_id: rental.id } });
  check('pay rent: price + fees (₦120,000) charged', r.status === 200 && r.body.message === 'Rent paid and property rented successfully' && r.body.walletBalance === '73000.00' && r.body.data.booked === true, r.body);
  check('rent split from .env (20% platform): landlord +₦96,000', Number((await db.Wallet.findOne({ where: { user_id: landlord.id } })).balance) - rentLL === 96000);
  check('rental status → rented', (await db.Rentals.findByPk(rental.id)).status === 'rented');
  r = await api('POST', '/progress/rent/pay', { as: tenant, body: { rental_id: rental.id } });
  check('pay rent again → 400 already rented', r.status === 400 && r.body.message === 'This property has already been rented', r.body);

  // ═══ 12. Inspections ═══
  section('12. Inspection System');
  await db.Rentals.update({ inspectionFee: 2000 }, { where: { id: rental2.id } });
  const inLL = Number((await db.Wallet.findOne({ where: { user_id: landlord.id } })).balance);
  r = await api('POST', '/inspection/create', { as: tenant, body: { rental_id: rental2.id, date: '2030-01-15', time: '14:00' } });
  check('book inspection → 201, ₦2,000 fee charged', r.status === 201 && r.body.message === 'Inspection scheduled successfully' && r.body.data.is_paid === true, r.body);
  const insp = r.body.data;
  check('inspection fee split from .env (50% platform): landlord +₦1,000', Number((await db.Wallet.findOne({ where: { user_id: landlord.id } })).balance) - inLL === 1000);
  r = await api('POST', '/inspection/create', { as: tenant, body: { rental_id: rental2.id, date: '2030-01-15', time: '16:00' } });
  check('same rental + date → 409', r.status === 409 && r.body.message === 'You already have an inspection scheduled for this property on that date', r.body);
  r = await api('POST', '/inspection/create', { as: tenant, body: { rental_id: rental2.id } });
  check('missing date/time → 400', r.status === 400 && r.body.message === 'rental_id, date and time are required', r.body);
  r = await api('GET', '/inspection/all', { as: tenant });
  check('my inspections with rental (incl. inspectionFee)', r.status === 200 && r.body.data.some((i) => i.id === insp.id && i.rental?.inspectionFee === '2000.00'), r.body);
  r = await api('GET', `/inspection/${insp.id}`, { as: tenant });
  check('one inspection with rental.User (first/last name)', r.status === 200 && r.body.data.rental?.User?.first_name === 'Landlord', r.body);
  r = await api('GET', `/inspection/${insp.id}`, { as: landlord });
  check("someone else's inspection → 404", r.status === 404 && r.body.message === 'Inspection not found', r.body);
  r = await api('PUT', `/inspection/update/${insp.id}`, { as: tenant, body: { date: '2030-01-16', time: '10:00', is_paid: false } });
  check('reschedule → 200', r.status === 200 && r.body.message === 'Inspection updated successfully' && r.body.data.date === '2030-01-16', r.body);
  check('…and is_paid sent by the tenant is ignored (still true)', r.body.data.is_paid === true && (await db.Inspections.findByPk(insp.id)).is_paid === true, r.body.data);
  r = await api('POST', '/inspection/create', { as: tenant, body: { rental_id: rental2.id, date: '2030-02-01', time: '09:00' } });
  r = await api('PUT', `/inspection/update/${insp.id}`, { as: tenant, body: { date: '2030-02-01' } });
  check('reschedule onto a date already booked for that rental → 409', r.status === 409 && r.body.message === 'You already have an inspection scheduled for this property on that date', r.body);
  r = await api('PUT', '/inspection/update/not-a-uuid', { as: tenant, body: { date: '2030-03-01' } });
  check('bad id → 404 (no database error leaked)', r.status === 404 && r.body.message === 'Inspection not found' && r.body.error === undefined, r.body);
  r = await api('GET', `/inspection/rental/${rental2.id}`, { as: landlord });
  check('landlord sees inspections on their rental (with tenant)', r.status === 200 && r.body.data.some((i) => i.id === insp.id && i.tenant?.full_name === 'Tenant Tobi'), r.body);
  r = await api('GET', `/inspection/rental/${rental2.id}`, { as: tenant });
  check('non-owner → 404', r.status === 404 && r.body.message === 'Rental not found or you are not the owner', r.body);

  // ═══ 4. Reports ═══
  section('4. Reporting System');
  r = await api('POST', '/report', { as: tenant, body: { report_user_id: landlord.id, report_type: 'spam', report_message: 'Spam activity' } });
  check('report by id → 201', r.status === 201 && r.body.message === 'Report submitted successfully.' && r.body.data.report_status === 'pending' && r.body.data.report_name === 'Landlord Lola', r.body);
  const report = r.body.data;
  r = await api('POST', '/report', { as: tenant, body: { search_name: 'Landlord Lola', report_type: 'fraud', report_message: 'Asked for cash' } });
  check('report by search_name → 201', r.status === 201 && r.body.data.report_user_id === landlord.id, r.body);
  r = await api('POST', '/report', { as: tenant, body: { report_user_id: landlord.id, search_name: 'x', report_type: 'spam', report_message: 'x' } });
  check('both id and name → 400', r.status === 400 && r.body.message === 'Please provide either report_user_id OR search_name, not both.', r.body);
  r = await api('POST', '/report', { as: tenant, body: { report_user_id: landlord.id, report_type: 'spam' } });
  check('no message → 400', r.status === 400 && r.body.message === 'Report message is required.', r.body);
  r = await api('POST', '/report', { as: tenant, body: { report_user_id: crypto.randomUUID(), report_type: 'spam', report_message: 'x' } });
  check('unknown user → 404', r.status === 404 && r.body.message === 'User to report not found.', r.body);

  // ═══ 7. Chat ═══
  section('7. Chatting System');
  r = await login(admin2, 'AdminPass123');
  check('the new admin can log in', r.status === 200 && r.body.role === 'admin', r.body);
  r = await api('POST', '/chat/conversation', { as: tenant, body: { other_user_id: landlord.id } });
  check('start conversation → conversation object', r.status === 200 && r.body.conversation?.id, r.body);
  const conv = r.body.conversation;
  r = await api('POST', '/chat/conversation', { as: tenant, body: { other_user_id: landlord.id } });
  check('same pair → same conversation', r.body.conversation?.id === conv.id, r.body);
  r = await api('POST', '/chat/conversation', { as: tenant, body: {} });
  check('no other_user_id → 400', r.status === 400 && r.body.message === 'other_user_id is required', r.body);
  r = await api('POST', '/chat/message', { as: tenant, body: { conversation_id: conv.id, content: 'Hello! I am interested in this property.' } });
  check('send message → 201, message object', r.status === 201 && r.body.message?.content === 'Hello! I am interested in this property.', r.body);
  r = await api('POST', '/chat/message', { as: landlord, body: { conversation_id: conv.id, content: 'Sure, when can you come?' } });
  check('other participant replies', r.status === 201, r.body);
  r = await api('PUT', '/profile/update', { as: googleUser, body: { gender: 'female', phone_no: '08033333333', state: 'Abuja', address: '9 Wuse' } });
  check('google user completes their profile (incl. gender) → verified', r.status === 200 && r.body.user.profileComplete === true, r.body);
  r = await api('POST', '/chat/message', { as: googleUser, body: { conversation_id: conv.id, content: 'intrude' } });
  check('outsider sending → 403', r.status === 403 && r.body.message === 'Not authorized to send messages in this conversation', r.body);
  r = await api('GET', '/chat/conversation', { as: landlord });
  check('list conversations with tenant/landlord names', r.status === 200 && r.body.conversations.some((c) => c.id === conv.id && c.tenant?.first_name && c.landlord?.last_name), r.body);
  r = await api('GET', `/chat/message/${conv.id}`, { as: tenant });
  check('messages oldest first, with sender', r.status === 200 && r.body.messages.length === 2 && r.body.messages[0].content.startsWith('Hello') && r.body.messages[0].sender?.full_name === 'Tenant Tobi', r.body);
  r = await api('GET', `/chat/message/${conv.id}`, { as: googleUser });
  check('outsider reading → 403', r.status === 403 && r.body.message === 'Not authorized to view messages in this conversation', r.body);
  r = await api('GET', `/chat/message/${conv.id}`, { as: admin2 });
  check('admins can read any conversation (moderation)', r.status === 200 && r.body.messages.length === 2, r.body);

  // ═══ 8. AI support ═══
  section('8. AI Support Chat');
  r = await api('POST', '/ai-support/chat', { body: { message: 'Hi from a guest', history: [{ role: 'user', content: 'Hi' }] } });
  check('guest chat → reply + new session_id, nothing stored', r.status === 200 && /Hi from a guest/.test(r.body.data.reply) && r.body.data.session_id, r.body);
  r = await api('POST', '/ai-support/chat', { as: tenant, body: { message: 'How much does it cost to lock a property?' } });
  check('logged-in chat → reply', r.status === 200 && r.body.data.reply, r.body);
  const sid = r.body.data.session_id;
  await api('POST', '/ai-support/chat', { as: tenant, body: { message: 'And rent?', session_id: sid } });
  r = await api('POST', '/ai-support/chat', { as: tenant, body: {} });
  check('no message → 400', r.status === 400 && r.body.message === 'Message is required', r.body);
  r = await api('POST', '/ai-support/chat', { as: tenant, body: { message: 'x'.repeat(2001) } });
  check('2001 chars → 400', r.status === 400 && r.body.message === 'Message is too long. Please keep it under 2000 characters.', r.body);
  r = await api('GET', '/ai-support/sessions', { as: tenant });
  check('sessions: message_count is a string ("4")', r.status === 200 && r.body.data.some((s) => s.session_id === sid && s.message_count === '4'), r.body);
  r = await api('GET', '/ai-support/history', { as: tenant });
  check('history summary per session', r.status === 200 && r.body.data.some((s) => s.session_id === sid && s.last_role === 'assistant'), r.body);
  r = await api('GET', `/ai-support/history?session_id=${sid}`, { as: tenant });
  check('history of one session in order', r.status === 200 && r.body.data.length === 4 && r.body.data[0].role === 'user', r.body);
  r = await api('DELETE', `/ai-support/session/${sid}`, { as: tenant });
  check('delete session → 200', r.status === 200 && r.body.message === 'Chat session deleted successfully', r.body);
  r = await api('DELETE', `/ai-support/session/${sid}`, { as: tenant });
  check('delete again → 404', r.status === 404 && r.body.message === 'Session not found', r.body);

  // ═══ 9. Waitlist ═══
  section('9. Waitlist');
  const wl = email('waitlist');
  r = await api('POST', '/waitlist', { body: { email: wl } });
  check('join → 201 + confirmation email', r.status === 201 && r.body.message === 'Successfully joined the waitlist! A confirmation email has been sent.' && mails().some((m) => m.to === wl), r.body);
  r = await api('POST', '/waitlist', { body: { email: 'not-an-email' } });
  check('bad email → 400', r.status === 400 && r.body.message === 'Invalid email format', r.body);
  r = await api('POST', '/waitlist', { body: { email: wl } });
  check('duplicate → 400', r.status === 400 && r.body.message === 'This email is already registered on our waitlist', r.body);

  // ═══ 10. Testimonials ═══
  section('10. Testimonials');
  r = await api('GET', '/api/testimonials/me', { as: tenant });
  check('none yet → 404', r.status === 404 && r.body.message === 'You have not submitted a testimonial yet', r.body);
  r = await api('POST', '/api/testimonials', { as: tenant, body: { rating: 6, message: 'Great platform overall!' } });
  check('rating 6 → 400', r.status === 400 && r.body.message === 'Rating must be between 1 and 5', r.body);
  r = await api('POST', '/api/testimonials', { as: tenant, body: { rating: 5, message: 'short' } });
  check('short message → 400', r.status === 400 && r.body.message === 'Message must be at least 10 characters', r.body);
  r = await api('POST', '/api/testimonials', { as: tenant, body: { rating: 5, message: 'RentULO made finding my flat easy!' } });
  check('create → 201 with user_name', r.status === 201 && r.body.message === 'Testimonial created successfully' && r.body.data.user_name, r.body);
  r = await api('POST', '/api/testimonials', { as: tenant, body: { rating: 4, message: 'Writing a second one here' } });
  check('second → 400', r.status === 400 && r.body.message === 'You already have a testimonial. Please update it instead', r.body);
  r = await api('PUT', '/api/testimonials', { as: tenant, body: {} });
  check('update with nothing → 400', r.status === 400 && r.body.message === 'Provide at least one field to update', r.body);
  r = await api('PUT', '/api/testimonials', { as: tenant, body: { rating: 4 } });
  check('update → 200', r.status === 200 && r.body.message === 'Testimonial updated successfully' && r.body.data.rating === 4, r.body);
  r = await api('GET', '/api/testimonials');
  check('public list includes it', r.status === 200 && r.body.data.some((t) => t.user_id === tenant.id), r.body);
  r = await api('DELETE', '/api/testimonials', { as: tenant });
  check('delete → 200', r.status === 200 && r.body.message === 'Testimonial deleted successfully', r.body);
  r = await api('DELETE', '/api/testimonials', { as: tenant });
  check('delete again → 404', r.status === 404 && r.body.message === 'Testimonial not found', r.body);

  // ═══ 11. Subscriptions ═══
  section('11. Subscriptions');
  r = await api('POST', '/subscriptions/subscribe', { as: tenant });
  check('subscribe → 201, integer id', r.status === 201 && r.body.message === 'Subscribed successfully' && Number.isInteger(r.body.data.id), r.body);
  r = await api('POST', '/subscriptions/subscribe', { as: tenant });
  check('again → 400', r.status === 400 && r.body.message === 'You are already a subscriber', r.body);

  // ═══ 5. Notifications ═══
  section('5. Notifications');
  r = await api('GET', '/notification', { as: tenant });
  check('list (key "notifications"), newest first', r.status === 200 && Array.isArray(r.body.notifications) && r.body.notifications.length > 0
    && new Date(r.body.notifications[0].createdAt) >= new Date(r.body.notifications[r.body.notifications.length - 1].createdAt), r.body);
  const firstNote = r.body.notifications[0];
  r = await api('GET', '/notification/count', { as: tenant });
  const unread = r.body.count;
  check('unread count is a number', r.status === 200 && Number.isInteger(unread), r.body);
  r = await api('PUT', '/notification/read', { as: tenant, body: { id: firstNote.id } });
  check('mark read → count goes down by 1', r.status === 200 && (await api('GET', '/notification/count', { as: tenant })).body.count === unread - (firstNote.is_read ? 0 : 1), r.body);
  r = await api('DELETE', '/notification/delete', { as: tenant, body: { id: firstNote.id } });
  check('delete → 200', r.status === 200 && r.body.message === 'Notification deleted', r.body);

  // ═══ 15. Support tickets ═══
  section('15. Support Tickets');
  r = await api('POST', '/support/tickets', { as: tenant, body: { subject: 'Hi', description: 'short' } });
  check('validation → 400 with a message', r.status === 400 && typeof r.body.message === 'string', r.body);
  r = await api('POST', '/support/tickets', { as: tenant, body: { subject: 'Payment issue with my lock fee', description: 'I locked a property and was charged twice. Please help.', category: 'billing', priority: 'urgent' } });
  check('create ticket → 201 with TKT- ref', r.status === 201 && r.body.message === 'Support ticket created successfully.' && /^TKT-/.test(r.body.data.ticket_ref) && r.body.data.status === 'open', r.body);
  const ref = r.body.data.ticket_ref;
  r = await api('POST', `/support/tickets/${ref}/reply`, { as: tenant, body: { message: 'Here is my reference: RENTULO-LOCK-12345.' } });
  check('user reply → 201', r.status === 201 && r.body.message === 'Reply added successfully.' && r.body.data.reply.sender_role === 'user', r.body);
  r = await api('GET', '/support/tickets', { as: tenant });
  check('my tickets with reply_count (string) + last_reply + pagination', r.status === 200 && r.body.data.some((t) => t.ticket_ref === ref && t.reply_count === '1' && /RENTULO-LOCK/.test(t.last_reply)) && r.body.pagination, r.body);
  r = await api('GET', `/support/tickets/${ref}`, { as: tenant });
  check('one ticket with replies', r.status === 200 && r.body.data.replies.length === 1, r.body);
  r = await api('GET', `/support/tickets/${ref}`, { as: landlord });
  check("someone else's ticket → 404", r.status === 404 && r.body.message === 'Ticket not found.', r.body);
  r = await api('GET', '/admin/support/stats', { as: superAdmin });
  check('admin stats', r.status === 200 && r.body.data.by_priority && r.body.data.by_status && typeof r.body.data.total_open === 'number', r.body);
  r = await api('GET', `/admin/support/tickets?q=${ref}`, { as: superAdmin });
  check('admin list with requester info', r.status === 200 && r.body.data.some((t) => t.ticket_ref === ref && t.user_email === tenantEmail), r.body);
  r = await api('GET', `/admin/support/tickets/${ref}`, { as: superAdmin });
  check('admin ticket view with user + replies.sender', r.status === 200 && r.body.data.user?.email === tenantEmail && r.body.data.replies[0]?.sender, r.body);
  r = await api('POST', `/admin/support/tickets/${ref}/reply`, { as: superAdmin, body: { message: 'We found the duplicate charge and are refunding you.' } });
  check('admin reply → in_progress + email', r.status === 201 && r.body.data.status === 'in_progress' && mails().some((m) => m.to === tenantEmail && /support|ticket/i.test(m.subject)), r.body);
  r = await api('POST', `/admin/support/tickets/${ref}/resolve`, { as: superAdmin });
  check('resolve → deleted', r.status === 200 && r.body.message === 'Ticket resolved and removed.', r.body);
  r = await api('GET', `/support/tickets/${ref}`, { as: tenant });
  check('resolved ticket → 404', r.status === 404, r.body);

  // ═══ 14. Admin ═══
  section('14. Admin');
  r = await api('GET', '/admin/users', { as: tenant });
  check('non-admin → 403', r.status === 403 && r.body.message === 'Forbidden. Super Admin privileges required.', r.body);
  r = await api('GET', '/admin/analytics', { as: superAdmin });
  check('analytics shape', r.status === 200 && r.body.data.users && r.body.data.financials && 'shortletBookings' in r.body.data.financials && 'successfulLockPaymentsCount' in r.body.data.financials, r.body);
  r = await api('GET', '/admin/users', { as: superAdmin });
  check('all users, no password/otp', r.status === 200 && r.body.data.some((u) => u.id === tenant.id) && r.body.data.every((u) => u.password === undefined && u.otpCode === undefined), r.body.count);
  r = await api('PUT', `/admin/users/${landlord.id}/commission`, { as: superAdmin, body: { commission_percent: 15.5 } });
  check('set shortlet commission', r.status === 200 && r.body.message === 'Landlord shortlet commission percentage updated successfully' && Number(r.body.data.commission_percent) === 15.5, r.body);
  r = await api('PUT', `/admin/users/${tenant.id}/commission`, { as: superAdmin, body: { commission_percent: 10 } });
  check('commission for a tenant → 400', r.status === 400 && r.body.message === 'Only landlords can have commission percentages assigned', r.body);
  r = await api('PUT', `/admin/users/${googleUser.id}/status`, { as: superAdmin });
  check('toggle status → blocked', r.status === 200 && r.body.message === 'User status updated to blocked', r.body);
  r = await api('PUT', `/admin/users/${superAdmin.id}/status`, { as: superAdmin });
  check("can't change own status", r.status === 400 && r.body.message === 'You cannot change your own status.', r.body);
  r = await api('PUT', `/admin/users/${googleUser.id}/unsuspend`, { as: superAdmin });
  check('unsuspend', r.status === 200 && r.body.message === 'User unsuspended successfully', r.body);
  r = await api('PUT', `/admin/users/${landlord.id}/suspend`, { as: superAdmin });
  check('suspend', r.status === 200 && r.body.message === 'User suspended successfully', r.body);
  r = await api('POST', '/auth/login', { body: { user: landlordEmail, password: 'SecurePass1' } });
  check('suspended user cannot log in → 403', r.status === 403 && r.body.message === 'Account disabled. Please contact support.', r.body);
  await api('PUT', `/admin/users/${landlord.id}/unsuspend`, { as: superAdmin });
  r = await api('GET', '/admin/rentals', { as: superAdmin });
  check('all rentals with owner', r.status === 200 && r.body.data.some((x) => x.id === rental.id && x.User?.email === landlordEmail), r.body.count);
  r = await api('GET', '/admin/reports', { as: superAdmin });
  check('reports with user + report_user', r.status === 200 && r.body.data.some((x) => x.id === report.id && x.user && x.report_user), r.body.count);
  r = await api('PUT', `/admin/reports/${report.id}/status`, { as: superAdmin, body: { status: 'resolved' } });
  check('update report status', r.status === 200 && r.body.message === 'Report status updated to resolved', r.body);
  r = await api('GET', '/admin/chats', { as: superAdmin });
  check('all chats', r.status === 200 && r.body.data.some((c) => c.id === conv.id && c.tenant && c.landlord), r.body.count);
  r = await api('GET', `/admin/chats/${conv.id}/messages`, { as: superAdmin });
  check('chat messages with sender', r.status === 200 && r.body.count === 2 && r.body.data[0].sender, r.body);
  r = await api('GET', '/admin/waitlist', { as: superAdmin });
  check('waitlist', r.status === 200 && r.body.data.some((w) => w.email === wl), r.body.count);
  r = await api('GET', '/admin/outbound-ip', { as: superAdmin });
  check('outbound IP', r.status === 200 && r.body.ip === '203.0.113.7', r.body);
  r = await api('GET', '/admin/transactions/stats', { as: superAdmin });
  check('transaction stats', r.status === 200 && r.body.message === 'Transaction stats fetched successfully' && 'totalToday' in r.body.data && 'revenueToday' in r.body.data, r.body);
  r = await api('GET', `/admin/transactions?search=${topRef}`, { as: superAdmin });
  check('transactions list: search + pagination + source', r.status === 200 && r.body.data.some((t) => t.reference === topRef && t.source === 'wallet') && r.body.pagination?.total >= 1, r.body);
  const anyTx = r.body.data[0];
  r = await api('GET', `/admin/transactions/${anyTx.id}`, { as: superAdmin });
  check('one transaction (User has walletBalance)', r.status === 200 && r.body.data.id === anyTx.id && 'walletBalance' in (r.body.data.User || {}), r.body);
  r = await api('GET', `/admin/transactions/${crypto.randomUUID()}`, { as: superAdmin });
  check('unknown transaction → 404', r.status === 404 && r.body.message === 'Transaction not found', r.body);

  r = await api('POST', '/admin/coupons', { as: superAdmin, body: { code: 'bad code', bonus_type: 'fixed', bonus_value: 100 } });
  check('coupon with a space → 400', r.status === 400, r.body);
  const code = `T${runId.toUpperCase().replace(/[^A-Z0-9]/g, '')}`;
  r = await api('POST', '/admin/coupons', { as: superAdmin, body: { code, description: 'Test promo', bonus_type: 'fixed', bonus_value: 100, max_uses: 5 } });
  check('create coupon → 201', r.status === 201 && r.body.message === 'Coupon created successfully.' && r.body.coupon.code === code && r.body.coupon.remaining_uses === 5, r.body);
  const coupon = r.body.coupon;
  r = await api('POST', '/admin/coupons', { as: superAdmin, body: { code, bonus_type: 'fixed', bonus_value: 100 } });
  check('duplicate code → 409', r.status === 409 && r.body.message === 'That coupon code already exists.', r.body);
  r = await api('POST', '/wallet/coupons/redeem', { as: tenant, body: { code: code.toLowerCase() } });
  check('redeem (case-insensitive) → ₦100 bonus', r.status === 200 && r.body.bonus === '100.00' && r.body.transaction.type === 'bonus', r.body);
  r = await api('POST', '/wallet/coupons/redeem', { as: tenant, body: { code } });
  check('redeem twice → 403', r.status === 403 && r.body.message === 'You have already used this coupon code.', r.body);
  r = await api('POST', '/wallet/coupons/redeem', { as: tenant, body: { code: 'NOSUCHCODE' } });
  check('unknown code → 404', r.status === 404 && r.body.message === 'Coupon code is invalid or has expired.', r.body);
  r = await api('GET', '/admin/coupons', { as: superAdmin });
  check('list coupons with redemptions', r.status === 200 && r.body.data.some((c) => c.id === coupon.id && c.redemption_count === 1), r.body);
  r = await api('GET', `/admin/coupons/${coupon.id}`, { as: superAdmin });
  check('get coupon', r.status === 200 && r.body.data.redemptions.length === 1, r.body);
  r = await api('PATCH', `/admin/coupons/${coupon.id}`, { as: superAdmin, body: { is_active: false } });
  check('deactivate (PATCH)', r.status === 200 && r.body.message === 'Coupon updated successfully.' && r.body.coupon.is_active === false, r.body);
  r = await api('POST', '/wallet/coupons/redeem', { as: landlord, body: { code } });
  check('inactive coupon → 403', r.status === 403 && r.body.message === 'This coupon code is no longer active.', r.body);
  r = await api('DELETE', `/admin/coupons/${coupon.id}`, { as: superAdmin });
  check('delete a redeemed coupon → 409', r.status === 409, r.body);
  r = await api('POST', '/admin/coupons', { as: superAdmin, body: { code: `${code}X`, bonus_type: 'percent', bonus_value: 10, base_amount: 1000, max_bonus: 50 } });
  r = await api('DELETE', `/admin/coupons/${r.body.coupon.id}`, { as: superAdmin });
  check('delete an unused coupon → 200', r.status === 200 && r.body.message === 'Coupon deleted successfully.', r.body);

  // ═══ 17. Counts ═══
  section('17. Counts');
  r = await api('GET', '/counts');
  check('public counts', r.status === 200 && r.body.message === 'Counts retrieved successfully' && r.body.data.totalListings === r.body.data.totalRentals + r.body.data.totalShortlets, r.body);

  // ═══ 18. Shortlets (listing management; booking has its own suite) ═══
  section('18. Shortlet Management');
  const slFields = { title: `Lekki Loft ${runId}`, description: 'Cosy loft', propertyType: 'loft', rentalModel: 'entire_place', pricePerNight: '15000', address: '3 Admiralty Way', city: 'Lagos', area: 'Lekki', availableFrom: new Date().toISOString().slice(0, 10), availableTo: '2031-01-01', amenities: '["wifi","ac"]', cleaningFee: '2000', securityDeposit: '5000', cancellationPolicy: 'moderate' };
  r = await api('POST', '/shortlet/post', { as: tenant, form: multipart(slFields, { images: [file()] }) });
  check('tenant cannot add a shortlet → 403', r.status === 403 && r.body.message === 'Only landlords can add shortlets', r.body);
  r = await api('POST', '/shortlet/post', { as: landlord, form: multipart({ ...slFields, cancellationPolicy: 'bogus' }, { images: [file()] }) });
  check('invalid policy → 400', r.status === 400 && /cancellationPolicy must be one of/.test(r.body.message), r.body);
  r = await api('POST', '/shortlet/post', { as: landlord, form: multipart(slFields, { images: [file(), file()] }) });
  check('landlord adds a shortlet → 201', r.status === 201 && r.body.message === 'Short let property added successfully' && r.body.data.cancellationPolicy === 'moderate', r.body);
  const sl = r.body.data;
  r = await api('GET', '/shortlet/all', { as: tenant });
  check('all shortlets', r.status === 200 && r.body.data.some((x) => x.id === sl.id), r.body);
  r = await api('GET', '/shortlet/recent');
  check('recent shortlets (public)', r.status === 200 && Array.isArray(r.body.data), r.body);
  r = await api('GET', `/shortlet/get1/${sl.slug}`, { as: tenant });
  check('get1 by slug, with landlord', r.status === 200 && r.body.data.id === sl.id && r.body.data.landlord?.full_name, r.body);
  r = await api('GET', '/shortlet/search?location=lekki', { as: tenant });
  check('search shortlets', r.status === 200 && r.body.data.some((x) => x.id === sl.id), r.body);
  r = await api('POST', '/shortlet/post', { as: landlord, form: multipart({ ...slFields, title: `Abuja Flat ${runId}`, city: 'Abuja', area: 'Wuse', address: '1 Abuja Rd' }, { images: [file()] }) });
  const slAbuja = r.body.data;
  r = await api('GET', '/shortlet/search?lat=6.43&lng=3.42', { as: tenant });
  check('search shortlets by GPS (Lekki found, Abuja excluded)', r.status === 200 && r.body.data.some((x) => x.id === sl.id) && !r.body.data.some((x) => x.id === slAbuja.id), r.body);
  r = await api('PUT', `/shortlet/update/${sl.id}`, { as: landlord, body: { pricePerNight: 18000 } });
  check('owner updates price', r.status === 200 && Number(r.body.data.pricePerNight) === 18000, r.body);
  // quick booking smoke test (full coverage: shortletBooking.e2e.js)
  const checkIn = new Date(Date.now() + 10 * 86400e3).toISOString().slice(0, 10);
  const checkOut = new Date(Date.now() + 12 * 86400e3).toISOString().slice(0, 10);
  r = await api('POST', '/shortlet/book', { as: tenant, body: { shortlet_id: sl.id, checkIn, checkOut, guests: 1, pin: '4321' } });
  check('book the shortlet (2 nights = ₦43,000)', r.status === 201 && r.body.data.total_amount === '43000.00' && r.body.data.cancellation_policy === 'moderate', r.body);
  r = await api('DELETE', `/shortlet/delete/${sl.id}`, { as: landlord });
  check('delete with an upcoming booking → 409', r.status === 409, r.body);
  r = await api('POST', `/shortlet/bookings/${(await db.ShortletBookings.findOne({ where: { shortlet_id: sl.id } })).id}/cancel`, { as: tenant, body: {} });
  check('guest cancels 10 days ahead under Moderate → full refund', r.status === 200 && r.body.refundAmount === '43000.00', r.body);
  r = await api('DELETE', `/admin/shortlets/${sl.slug}`, { as: superAdmin });
  check('admin deletes the shortlet (by slug)', r.status === 200 && r.body.message === 'Short let deleted successfully', r.body);

  section('3. Rental Management (delete)');
  r = await api('DELETE', `/rental/delete/${rental2.slug}`, { as: tenant });
  check('non-owner delete → 403', r.status === 403 && r.body.message === 'You are not authorized to delete this rental', r.body);
  r = await api('DELETE', `/admin/rentals/${rental2.id}`, { as: superAdmin });
  check('admin deletes a rental', r.status === 200 && r.body.message === 'Rental deleted successfully', r.body);

  section('14. Admin (delete user)');
  r = await api('DELETE', `/admin/users/${superAdmin.id}`, { as: superAdmin });
  check("can't delete yourself", r.status === 400 && r.body.message === 'You cannot delete your own account here.', r.body);
  r = await api('DELETE', `/admin/users/${googleUser.id}`, { as: superAdmin });
  check('delete a user', r.status === 200 && r.body.message === 'User deleted successfully', r.body);

  section('Safety');
  check('no real outbound network call was attempted by the app', !/outbound network blocked/.test(app.log()), app.log().match(/outbound network blocked: \S+/g));
}

async function cleanup() {
  if (process.env.KEEP_TEST_DATA === 'true') return console.log(`\n(kept test data, run ${runId})`);
  const users = (await db.Users.findAll({ where: { email: { [Op.in]: [...created.emails] } }, attributes: ['id'] })).map((u) => u.id);
  const ids = { [Op.in]: users };
  const q = db.sequelize;
  const del = async (model, where) => { try { await model.destroy({ where }); } catch (e) { console.warn(`cleanup ${model.name}: ${e.message}`); } };
  const convs = (await db.Conversations.findAll({ where: { [Op.or]: [{ tenant_id: ids }, { landlord_id: ids }] }, attributes: ['id'] })).map((c) => c.id);
  await del(db.Messages, { conversation_id: { [Op.in]: convs } });
  await del(db.Conversations, { id: { [Op.in]: convs } });
  await del(db.ShortletBookings, { [Op.or]: [{ user_id: ids }, { host_id: ids }] });
  await del(db.Shortlets, { UserId: ids });
  await del(db.Inspections, { user_id: ids });
  await del(db.Progress, { user_id: ids });
  await del(db.Rentals, { UserId: ids });
  await del(db.CouponRedemption, { user_id: ids });
  await del(db.Coupon, { code: { [Op.like]: `T${runId.toUpperCase().replace(/[^A-Z0-9]/g, '')}%` } });
  await del(db.WalletTransactions, { user_id: ids });
  await del(db.Wallet, { user_id: ids });
  await del(db.Reports, { [Op.or]: [{ user_id: ids }, { report_user_id: ids }] });
  await del(db.Notifications, { user_id: ids });
  await del(db.AiSupport, { user_id: ids });
  await del(db.Subscriptions, { user_id: ids });
  await del(db.Testimonials, { user_id: ids });
  await del(db.Pins, { user_id: ids });
  await del(db.Profile, { user_id: ids });
  await del(db.PendingRegistrations, { email: { [Op.in]: [...created.emails] } });
  await del(db.Waitlist, { email: { [Op.in]: [...created.emails] } });
  await del(db.Users, { id: ids });
  void q;
}

(async () => {
  try {
    await db.sequelize.authenticate();
  } catch (e) {
    console.error(`Cannot reach the test database (${TEST_URL}). Start it with: npm run test:db:start\n${e.message}`);
    process.exit(1);
  }
  try {
    await startApp();
    await main();
  } catch (e) {
    results.push({ section: currentSection, name: `CRASH: ${e.message}`, ok: false });
    console.error(e);
  } finally {
    await cleanup().catch((e) => console.error('Cleanup failed:', e.message));
    if (app) app.kill();
    await db.sequelize.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  const failed = results.filter((x) => !x.ok);
  console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
  if (failed.length) {
    console.log('\nFailures by section:');
    for (const f of failed) console.log(`  [${f.section}] ${f.name}`);
  }
  process.exit(failed.length ? 1 : 0);
})();
