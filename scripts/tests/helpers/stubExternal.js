'use strict';
// Preloaded with `node -r` when tests boot the real app (index.js), or
// required in-process. Replaces every OUTSIDE service with a local fake so
// tests never send real email, upload real files or touch Flutterwave /
// OpenAI / Google / OpenStreetMap, and BLOCKS any other outbound network
// call so a missed integration fails loudly instead of hitting a real API.
//
// Fakes that a test needs to observe or steer keep their state in files
// (the app runs in a child process):
//   TEST_MAIL_LOG   — every email sent, one JSON object per line
//   TEST_FLW_STATE  — Flutterwave fake state:
//                     { charges: { [tx_ref]: { id, amount, status } },
//                       transfers: { [id]: { id, reference, amount, status } },
//                       rejectTransfers: false }
//                     Tests set a charge's status to "successful"/"failed" to
//                     simulate the customer paying (or not).
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const ROOT = path.resolve(__dirname, '../../..');
const req = (m) => require(path.join(ROOT, 'node_modules', m));

// ── 1. Block real outbound network (only localhost allowed) ──
const LOCAL = new Set(['127.0.0.1', 'localhost', '::1', undefined, '']);
global.__blockedNetwork = [];
for (const mod of [http, https]) {
  for (const fn of ['request', 'get']) {
    const original = mod[fn];
    mod[fn] = function guarded(...args) {
      const opts = typeof args[0] === 'string' || args[0] instanceof URL ? new URL(args[0]) : (args[0] || {});
      const host = opts.hostname || opts.host;
      if (!LOCAL.has(String(host || '').split(':')[0] || undefined)) {
        global.__blockedNetwork.push(String(host));
        throw new Error(`[test] outbound network blocked: ${host}`);
      }
      return original.apply(this, args);
    };
  }
}

// ── 2. Email ──
const mailerPath = require.resolve(path.join(ROOT, 'utils/mailer.js'));
require.cache[mailerPath] = {
  id: mailerPath, filename: mailerPath, loaded: true,
  exports: {
    sendEmail: async (to, subject, text, html) => {
      if (process.env.TEST_MAIL_LOG) {
        fs.appendFileSync(process.env.TEST_MAIL_LOG, JSON.stringify({ to, subject, text, at: new Date().toISOString() }) + '\n');
      }
      return { messageId: 'stubbed' };
    },
  },
};

// ── 3. Cloudinary (uploads + deletions recorded) ──
const cloudinary = req('cloudinary').v2;
global.__cloudinary = { uploaded: [], destroyed: [] };
cloudinary.uploader.upload_stream = (options, callback) => ({
  end: () => {
    const public_id = `${options?.folder || 'x'}/${crypto.randomUUID()}`;
    global.__cloudinary.uploaded.push(public_id);
    callback(null, { public_id, secure_url: `https://cdn.test/${public_id}` });
  },
});
cloudinary.uploader.destroy = async (public_id) => {
  global.__cloudinary.destroyed.push(public_id);
  return { result: 'ok' };
};

// ── 4. Google sign-in: idToken "test-google:<email>:<given>:<family>" ──
const { OAuth2Client } = req('google-auth-library');
OAuth2Client.prototype.verifyIdToken = async function verifyIdToken({ idToken }) {
  const m = /^test-google:([^:]+):([^:]*):([^:]*)$/.exec(String(idToken));
  if (!m) throw new Error('Wrong number of segments in token');
  const [, email, given_name, family_name] = m;
  return { getPayload: () => ({ email, given_name, family_name, email_verified: true, sub: crypto.createHash('md5').update(email).digest('hex') }) };
};

// ── 5. Geocoder (GPS → city) ──
const geoPath = require.resolve(path.join(ROOT, 'node_modules/node-geocoder'));
require.cache[geoPath] = {
  id: geoPath, filename: geoPath, loaded: true,
  exports: () => ({ reverse: async () => [{ city: 'Lekki', state: 'Lagos', country: 'Nigeria' }] }),
};

// ── 6. axios: Flutterwave, OpenAI, ipify ──
const axios = req('axios');
function flwState() {
  const file = process.env.TEST_FLW_STATE;
  if (!file) return { charges: {}, transfers: {}, rejectTransfers: false };
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return { charges: {}, transfers: {}, rejectTransfers: false }; }
}
function saveFlw(state) {
  if (process.env.TEST_FLW_STATE) fs.writeFileSync(process.env.TEST_FLW_STATE, JSON.stringify(state, null, 2));
}
function reply(config, status, data) {
  const res = { data, status, statusText: String(status), headers: {}, config, request: {} };
  if (status >= 400) {
    const err = new Error(data?.message || `Request failed with status code ${status}`);
    err.isAxiosError = true;
    err.response = res;
    err.config = config;
    return Promise.reject(err);
  }
  return Promise.resolve(res);
}
axios.defaults.adapter = async function fakeAdapter(config) {
  // axios joins baseURL + url as strings (keeps the /v3 prefix), unlike new URL(url, base)
  const full = config.baseURL && !/^https?:\/\//.test(config.url)
    ? `${config.baseURL.replace(/\/+$/, '')}/${String(config.url).replace(/^\/+/, '')}`
    : config.url;
  const url = new URL(full);
  const body = typeof config.data === 'string' ? JSON.parse(config.data || '{}') : (config.data || {});
  const method = (config.method || 'get').toLowerCase();
  const p = url.pathname;

  if (url.hostname === 'api.flutterwave.com') {
    const s = flwState();
    const charge = (c) => ({ status: 'success', message: 'Transaction fetched successfully', data: { id: c.id, tx_ref: c.tx_ref, amount: c.amount, currency: 'NGN', status: c.status } });
    if (method === 'post' && p === '/v3/payments') {
      const id = Math.floor(Math.random() * 1e9);
      s.charges[body.tx_ref] = { id, tx_ref: body.tx_ref, amount: body.amount, status: 'pending' };
      saveFlw(s);
      return reply(config, 200, { status: 'success', message: 'Hosted Link', data: { link: `https://checkout.flutterwave.test/pay/${id}` } });
    }
    if (method === 'get' && p === '/v3/transactions/verify_by_reference') {
      const c = s.charges[config.params?.tx_ref];
      if (!c || c.status === 'pending') return reply(config, 400, { status: 'error', message: 'No transaction was found for this id' });
      return reply(config, 200, charge(c));
    }
    let m = /^\/v3\/transactions\/(\d+)\/verify$/.exec(p);
    if (method === 'get' && m) {
      const c = Object.values(s.charges).find((x) => String(x.id) === m[1]);
      if (!c || c.status === 'pending') return reply(config, 400, { status: 'error', message: 'No transaction was found for this id' });
      return reply(config, 200, charge(c));
    }
    if (method === 'get' && p === '/v3/banks/NG') {
      return reply(config, 200, { status: 'success', data: [{ id: 1, code: '044', name: 'Access Bank' }, { id: 2, code: '058', name: 'Guaranty Trust Bank' }] });
    }
    if (method === 'post' && p === '/v3/transfers') {
      if (s.rejectTransfers) return reply(config, 400, { status: 'error', message: 'Insufficient balance in your Flutterwave wallet' });
      const id = Math.floor(Math.random() * 1e9);
      s.transfers[id] = { id, reference: body.reference, amount: body.amount, currency: 'NGN', status: 'NEW' };
      saveFlw(s);
      return reply(config, 200, { status: 'success', message: 'Transfer Queued Successfully', data: s.transfers[id] });
    }
    m = /^\/v3\/transfers\/(\d+)$/.exec(p);
    if (method === 'get' && m) {
      const t = s.transfers[m[1]];
      if (!t) return reply(config, 404, { status: 'error', message: 'Transfer not found' });
      return reply(config, 200, { status: 'success', data: t });
    }
    return reply(config, 404, { status: 'error', message: `[test fake] unhandled Flutterwave call ${method.toUpperCase()} ${p}` });
  }

  if (url.hostname === 'api.openai.com' && p === '/v1/chat/completions') {
    const last = body.messages?.[body.messages.length - 1]?.content || '';
    return reply(config, 200, { choices: [{ message: { role: 'assistant', content: `Test reply to: ${last}` } }] });
  }
  if (url.hostname === 'api.ipify.org') return reply(config, 200, { ip: '203.0.113.7' });

  global.__blockedNetwork.push(url.hostname);
  throw new Error(`[test] outbound network blocked: ${url.hostname}`);
};
