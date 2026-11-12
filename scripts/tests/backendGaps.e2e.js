#!/usr/bin/env node
'use strict';
// End-to-end tests for the six "Known Backend Gaps" fixes, run against the
// REAL app (index.js booted as a child process) and a local test Postgres.
// Email and Cloudinary are stubbed (scripts/tests/helpers/stubExternal.js).
//
//   npm run test:db:start
//   npm run test:gaps
//
// Same safety rules as shortletBooking.e2e.js: local DB only, cleans up after itself.

const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const ROOT = path.resolve(__dirname, '../..');

const TEST_URL = process.env.TEST_DATABASE_URL || 'postgres://test@127.0.0.1:55432/rentulo_test';
const testHost = new URL(TEST_URL).hostname;
if (!['127.0.0.1', 'localhost', '::1'].includes(testHost) && process.env.ALLOW_REMOTE_TEST_DB !== 'true') {
  console.error(`Refusing to run against non-local database host "${testHost}". This test writes and deletes data.`);
  process.exit(1);
}
const APP_ORIGIN = 'https://rentulo.ng';
const testEnv = {
  DATABASE_URL: TEST_URL,
  DB_SSL_CA_PATH: '',
  NODE_ENV: 'test',
  JWT_SECRET: `test-${crypto.randomUUID()}`,
  ALLOWED_ORIGINS: `${APP_ORIGIN},http://localhost:3000`,
  RECONCILE_CRON_ENABLED: 'false',
  SHORTLET_SETTLEMENT_CRON_ENABLED: 'false',
  EMAIL_USER: '',
  EMAIL_PASS: '',
};
Object.assign(process.env, testEnv);

const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const { Op } = require('sequelize');
const db = require(path.join(ROOT, 'models'));
const { Users, Profile, Wallet, Rentals, Progress, Inspections, Waitlist, WalletTransactions, Notifications } = db;

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log(`  ✔ ${name}`); }
  else { fail++; console.log(`  ✘ ${name}`, extra !== undefined ? JSON.stringify(extra).slice(0, 600) : ''); }
}

const runId = crypto.randomUUID().slice(0, 8);
const created = { users: [], waitlist: [] };
let base, app;

function startApp() {
  return new Promise((resolve, reject) => {
    const port = 30000 + Math.floor(Math.random() * 20000);
    app = spawn(process.execPath, ['-r', path.join(__dirname, 'helpers/stubExternal.js'), 'index.js'], {
      cwd: ROOT, env: { ...process.env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    const timer = setTimeout(() => reject(new Error(`app did not start:\n${out}`)), 30000);
    const onData = (chunk) => {
      out += chunk;
      if (out.includes('Database connected successfully')) {
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

const tokenFor = (u) => jwt.sign({ userId: u.id, role: u.role, email: u.email }, process.env.JWT_SECRET, { expiresIn: '1h' });
async function call(method, url, { user, cookie, origin, body, form } = {}) {
  const headers = {};
  if (user) headers.authorization = `Bearer ${tokenFor(user)}`;
  if (cookie) headers.cookie = cookie;
  if (origin) headers.origin = origin;
  if (body) headers['content-type'] = 'application/json';
  const r = await fetch(base + url, { method, headers, body: form || (body ? JSON.stringify(body) : undefined), redirect: 'manual' });
  return { status: r.status, headers: r.headers, body: await r.json().catch(() => ({})) };
}

async function mkUser(name, extra = {}) {
  const u = await Users.create({
    full_name: name, email: `${name.toLowerCase().replace(/\s/g, '')}.${runId}@test.local`,
    password: await bcrypt.hash('Passw0rd!', 4), role: 'tenant', is_verified: true,
    gender: 'female', phone_no: `080${Math.floor(Math.random() * 1e8)}`, state: 'Lagos', address: 'Addr', ...extra,
  });
  created.users.push(u.id);
  await Profile.create({ user_id: u.id });
  await Wallet.create({ user_id: u.id, accountName: name, accountNumber: `TEST-${runId}-${created.users.length}`, balance: 50000, status: 'ACTIVE' });
  return u;
}

async function cleanup() {
  if (process.env.KEEP_TEST_DATA === 'true') return console.log(`\n(kept test data, run ${runId})`);
  const users = { [Op.in]: created.users };
  await Inspections.destroy({ where: { user_id: users } });
  await Progress.destroy({ where: { user_id: users } });
  await Rentals.destroy({ where: { UserId: users } });
  await WalletTransactions.destroy({ where: { user_id: users } });
  await Wallet.destroy({ where: { user_id: users } });
  await Notifications.destroy({ where: { user_id: users } });
  await Profile.destroy({ where: { user_id: users } });
  await Users.destroy({ where: { id: users } });
  await Waitlist.destroy({ where: { email: { [Op.in]: created.waitlist } } });
}

async function main() {
  const landlord = await mkUser('Landlord Lola', { role: 'landlord' });
  const tenant = await mkUser('Tenant Tobi');

  console.log('\n1. Gender can be set after signup (Google sign-in users)');
  let googleUser;
  try {
    googleUser = await Users.create({
      full_name: 'Google User', email: `google.${runId}@test.local`, password: 'x', gender: null,
      phone_no: null, address: null, state: null, country: 'Nigeria', is_verified: false,
    });
    created.users.push(googleUser.id);
    await Profile.create({ user_id: googleUser.id });
    check('a user with no gender can be created (column is nullable)', googleUser.gender === null);
  } catch (e) {
    check('a user with no gender can be created (column is nullable)', false, e.message);
    return;
  }
  let r = await call('GET', '/rental/all', { user: googleUser });
  check('before: blocked by profile completion', r.status === 403 && r.body.needsProfileCompletion === true, r.body);
  r = await call('PUT', '/profile/update', { user: googleUser, body: { gender: 'robot' } });
  check('invalid gender rejected (400)', r.status === 400 && /gender must be one of/.test(r.body.message), r.body);
  r = await call('PUT', '/profile/update', { user: googleUser, body: { gender: 'female', phone_no: '08011112222', state: 'Lagos', address: '2 Road' } });
  check('gender + details saved; profileComplete: true', r.status === 200 && r.body.user.gender === 'female' && r.body.user.profileComplete === true, r.body);
  r = await call('GET', '/rental/all', { user: googleUser });
  check('after: rental routes no longer blocked', r.status !== 403, r.body);

  console.log('\n2. Inspection fee can be set and is returned');
  const form = (fields) => {
    const f = new FormData();
    for (const [k, v] of Object.entries(fields)) f.append(k, v);
    f.append('images', new Blob([Buffer.from('fake-image')], { type: 'image/png' }), 'a.png');
    return f;
  };
  const baseFields = { title: `Flat ${runId}`, description: 'Nice flat', propertyType: 'apartment', location: 'Lekki, Lagos', price: '1000000', priceType: 'yearly', status: 'available' };
  r = await call('POST', '/rental/post', { user: landlord, form: form({ ...baseFields, inspectionFee: '-5' }) });
  check('negative inspectionFee rejected (400)', r.status === 400 && /inspectionFee/.test(r.body.message), r.body);
  r = await call('POST', '/rental/post', { user: landlord, form: form({ ...baseFields, inspectionFee: 'abc' }) });
  check('non-numeric inspectionFee rejected (400)', r.status === 400, r.body);
  r = await call('POST', '/rental/post', { user: landlord, form: form({ ...baseFields, inspectionFee: '2500' }) });
  check('rental created with inspectionFee 2500', r.status === 201, r.body);
  const rental = await Rentals.findOne({ where: { UserId: landlord.id, title: baseFields.title } });
  check('fee stored on the rental', rental && rental.inspectionFee === '2500.00', rental?.inspectionFee);
  r = await call('GET', `/rental/get1/${rental.slug}`, { user: tenant });
  check('GET /rental/get1 returns inspectionFee', r.body.data?.inspectionFee === '2500.00', r.body.data?.inspectionFee);
  r = await call('GET', '/rental/all', { user: tenant });
  check('GET /rental/all returns inspectionFee', r.body.data?.some((x) => x.id === rental.id && x.inspectionFee === '2500.00'));
  r = await call('PUT', `/rental/update/${rental.id}`, { user: landlord, body: { inspectionFee: 3000 } });
  check('fee can be changed on update', r.status === 200 && r.body.data.inspectionFee === '3000.00', r.body.data?.inspectionFee);
  r = await call('PUT', `/rental/update/${rental.id}`, { user: landlord, body: { inspectionFee: -1 } });
  check('invalid fee rejected on update (400)', r.status === 400, r.body);
  const tenantBefore = Number((await Wallet.findOne({ where: { user_id: tenant.id } })).balance);
  r = await call('POST', '/inspection/create', { user: tenant, body: { rental_id: rental.id, date: '2030-01-15', time: '10:00' } });
  const tenantAfter = Number((await Wallet.findOne({ where: { user_id: tenant.id } })).balance);
  check('booking an inspection now charges the ₦3,000 fee', r.status === 201 && tenantBefore - tenantAfter === 3000, { status: r.status, delta: tenantBefore - tenantAfter });

  console.log('\n3. Profile lists are filled in');
  await Progress.create({ user_id: tenant.id, rental_id: rental.id, liked: false, locked: true, booked: true, locked_at: new Date() });
  r = await call('GET', `/profile/get1/${tenant.id}`, { user: tenant });
  const tp = r.body.data || r.body;
  check('tenant lockedHouses contains the rental', JSON.stringify(tp).includes(rental.id) && (tp.lockedHouses || []).some((h) => h.id === rental.id), Object.keys(tp));
  check('tenant rentalHistory contains the rental (with landlord)', (tp.rentalHistory || []).some((h) => h.id === rental.id && h.User));
  r = await call('GET', `/profile/get1/${landlord.id}`, { user: landlord });
  const lp = r.body.data || r.body;
  check('landlord lockedByTenants shows rental + tenant name', (lp.lockedByTenants || []).some((x) => x.rental?.id === rental.id && x.tenant?.full_name === 'Tenant Tobi'), lp.lockedByTenants);

  console.log('\n4. Waitlist is reachable');
  const wlEmail = `waitlist.${runId}@test.local`;
  created.waitlist.push(wlEmail);
  r = await call('POST', '/waitlist', { body: { email: wlEmail } });
  check('POST /waitlist → 201 (no auth needed)', r.status === 201, r);
  r = await call('POST', '/waitlist', { body: { email: wlEmail } });
  check('duplicate email → 400', r.status === 400, r.body);
  check('rate limited (RateLimit headers present)', !!(r.headers.get('ratelimit') || r.headers.get('ratelimit-limit') || r.headers.get('ratelimit-policy')));

  console.log('\n5. Cookies work cross-site, with CSRF protection');
  r = await call('POST', '/auth/login', { body: { user: tenant.email, password: 'Passw0rd!' } });
  const setCookie = (r.headers.getSetCookie?.() || []).join('\n');
  check('login sets the token cookie (HttpOnly)', r.status === 200 && /token=/.test(setCookie) && /HttpOnly/i.test(setCookie), { status: r.status, setCookie });
  check('dev/test cookie is SameSite=Lax (localhost works without HTTPS)', /SameSite=Lax/i.test(setCookie), setCookie);
  {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    const { authCookieOptions } = require(path.join(ROOT, 'utils/authCookies'));
    const o = authCookieOptions();
    process.env.NODE_ENV = prev;
    check('production cookie is SameSite=None; Secure (works rentulo.ng → onrender.com)', o.sameSite === 'none' && o.secure === true && o.httpOnly === true, o);
  }
  const cookie = `token=${tokenFor(tenant)}`;
  const note = await Notifications.create({ user_id: tenant.id, type: 'system', notification: 'test', is_read: false });
  const readBody = { id: note.id };
  r = await call('GET', '/notification', { cookie });
  check('cookie auth works for reads', r.status === 200, r.body);
  r = await call('PUT', '/notification/read', { cookie, origin: 'https://evil.example', body: readBody });
  check('cookie + foreign Origin on a write → 403 (rejected by CORS)', r.status === 403, r);
  r = await call('PUT', '/notification/read', { cookie, body: readBody });
  check('cookie + no Origin on a write → 403', r.status === 403 && /origin not allowed/i.test(r.body.message), r.body);
  r = await call('PUT', '/notification/read', { cookie, origin: APP_ORIGIN, body: readBody });
  check('cookie + rentulo.ng Origin on a write → allowed', r.status === 200, r.body);
  r = await call('PUT', '/notification/read', { user: tenant, body: readBody });
  check('Bearer token on a write (no Origin) → still allowed', r.status === 200, r.body);
  r = await call('GET', '/auth/me', { cookie });
  check('/auth/me with a valid cookie → logged in', r.body.isLoggedIn === true && r.body.userRole === 'tenant', r.body);
  const expired = jwt.sign({ userId: tenant.id, role: 'tenant', exp: Math.floor(Date.now() / 1000) - 60 }, process.env.JWT_SECRET);
  r = await call('GET', '/auth/me', { cookie: `token=${expired}; userRole=admin` });
  check('/auth/me with an expired cookie → logged out (was: logged in)', r.body.isLoggedIn === false, r.body);
  r = await call('GET', '/auth/me', { user: tenant });
  check('/auth/me also accepts the Bearer token', r.body.isLoggedIn === true, r.body);
  r = await call('POST', '/auth/logout', { origin: APP_ORIGIN });
  const cleared = (r.headers.getSetCookie?.() || []).join('\n');
  check('logout clears the cookie with matching attributes', /token=;/.test(cleared) && /SameSite=Lax/i.test(cleared), cleared);

  console.log('\n6. Rental update/delete accept the slug');
  r = await call('PUT', `/rental/update/${rental.slug}`, { user: landlord, body: { title: `Flat ${runId} renamed` } });
  check('PUT /rental/update/<slug> works', r.status === 200 && r.body.data.title === `Flat ${runId} renamed`, r.body);
  r = await call('PUT', '/rental/update/no-such-slug', { user: landlord, body: { title: 'x' } });
  check('unknown slug → 404 (was 500)', r.status === 404, r.body);
  r = await call('DELETE', '/rental/delete/no-such-slug', { user: landlord });
  check('delete unknown slug → 404', r.status === 404, r.body);
  const fresh = await Rentals.findByPk(rental.id);
  await Inspections.destroy({ where: { rental_id: rental.id } });
  await Progress.destroy({ where: { rental_id: rental.id } });
  r = await call('DELETE', `/rental/delete/${fresh.slug}`, { user: landlord });
  check('DELETE /rental/delete/<slug> works', r.status === 200 && !(await Rentals.findByPk(rental.id)), r.body);

  console.log('\n7. Notifications: read / delete validation');
  const n1 = await Notifications.create({ user_id: tenant.id, type: 'system', notification: 'n1', is_read: false });
  r = await call('PUT', '/notification/read', { user: tenant, body: {} });
  check('mark read with no id → 400 (was 500)', r.status === 400 && r.body.message === 'Notification id is required', r.body);
  r = await call('PUT', '/notification/read', { user: tenant, body: { id: 'abc' } });
  check('mark read with a bad id → 400', r.status === 400 && /valid UUID/.test(r.body.message), r.body);
  r = await call('PUT', '/notification/read', { user: tenant, body: { id: crypto.randomUUID() } });
  check('mark read, unknown id → 404', r.status === 404, r.body);
  r = await call('PUT', '/notification/read', { user: landlord, body: { id: n1.id } });
  check("can't mark someone else's notification (404)", r.status === 404, r.body);
  r = await call('PUT', '/notification/read', { user: tenant, body: { id: n1.id } });
  check('mark read works', r.status === 200 && (await Notifications.findByPk(n1.id)).is_read === true, r.body);
  r = await call('DELETE', '/notification/delete', { user: tenant, body: {} });
  check('delete with no id → 400 (was 500)', r.status === 400, r.body);
  r = await call('DELETE', '/notification/delete', { user: landlord, body: { id: n1.id } });
  check("can't delete someone else's notification (404)", r.status === 404 && !!(await Notifications.findByPk(n1.id)), r.body);
  r = await call('DELETE', '/notification/delete', { user: tenant, body: { id: n1.id } });
  check('delete works', r.status === 200 && !(await Notifications.findByPk(n1.id)), r.body);
  r = await call('DELETE', '/notification/delete', { user: tenant, body: { id: n1.id } });
  check('delete again → 404', r.status === 404, r.body);
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
    fail++;
    console.error(e);
  } finally {
    await cleanup().catch((e) => console.error('Cleanup failed:', e.message));
    if (app) app.kill();
    await db.sequelize.close();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
