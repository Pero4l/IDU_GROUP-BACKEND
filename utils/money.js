'use strict';

// Money arithmetic in whole kobo (the smallest unit of the naira: ₦1 = 100k).
// Sequelize returns DECIMAL(18,2) values as strings; doing math with JS
// Number() on decimals is subject to float drift (0.1 + 0.2 !== 0.3). Every
// wallet balance operation must go through these helpers so balances are
// exact to the kobo.

/** Parses a DECIMAL/string/number amount into an integer number of kobo. */
function toKobo(value) {
  const s = String(value == null ? 0 : value).trim();
  if (!s) return 0;
  const neg = s.startsWith('-');
  const clean = neg ? s.slice(1) : s;
  const parts = clean.split('.');
  const whole = parseInt(parts[0] || '0', 10);
  // Pad the fraction to exactly 2 digits so '0.1' → 10k, '0.10' → 10k.
  const fracStr = ((parts[1] || '') + '00').slice(0, 2);
  const third = parts[1] ? parts[1][2] : undefined;
  let frac = parseInt(fracStr, 10) || 0;
  if (third !== undefined && Number(third) >= 5) frac += 1;
  const kobo = whole * 100 + frac;
  return neg ? -kobo : kobo;
}

/** Formats integer kobo back to a DECIMAL(18,2) naira string. */
function fromKobo(kobo) {
  const neg = kobo < 0;
  const abs = Math.abs(Math.trunc(kobo));
  const whole = Math.floor(abs / 100);
  const frac = String(abs % 100).padStart(2, '0');
  return `${neg ? '-' : ''}${whole}.${frac}`;
}

/**
 * Sum of several NAIRA amounts (DECIMAL string, number, etc.), returned as
 * integer kobo. Every argument is parsed with toKobo, so an argument that is
 * already kobo would be scaled by 100 a second time — use addKobo for those.
 */
function sumKobo(...values) {
  return values.reduce((total, v) => total + toKobo(v), 0);
}

/**
 * Sum of values that are ALREADY integer kobo. Nothing is parsed or scaled.
 * Mixing the two unit domains is the one mistake these helpers can't absorb
 * silently, so a non-integer (i.e. a naira decimal that belongs in sumKobo)
 * throws here instead of quietly becoming 100x the intended amount.
 */
function addKobo(...koboValues) {
  return koboValues.reduce((total, k) => {
    if (!Number.isSafeInteger(k)) {
      throw new TypeError(`addKobo expects integer kobo, received ${JSON.stringify(k)}`);
    }
    return total + k;
  }, 0);
}

module.exports = { toKobo, fromKobo, sumKobo, addKobo };
