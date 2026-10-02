const crypto = require('crypto');
const { Coupon, CouponRedemption, Wallet, WalletTransactions, Users } = require('../models');
const { withTransaction } = require('../utils/rollback');
const { applyKoboDelta, createWalletForUser } = require('../utils/wallet');
const { toKobo, fromKobo } = require('../utils/money');
const logger = require('../utils/logger');
const { notifySuperAdmins, logAndEmailUser } = require('./notification.controller');
const { buildPropertyEmailHtml } = require('../utils/emailTemplates');

// Admins mint codes; users redeem them for a wallet bonus. The bonus is
// credited exactly once, inside the same database transaction that consumes
// the coupon's usage slot — so a concurrent double-redeem can't pay out twice.

const CODE_PATTERN = /^[A-Z0-9_-]{3,32}$/;
const BONUS_TYPES = ['fixed', 'percent'];
const MAX_BONUS_NAIRA = 10000000; // ₦10m ceiling on a single bonus

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function normalizeCode(raw) {
  return String(raw == null ? '' : raw).trim().toUpperCase();
}

// Same rule as the wallet's isValidAmount: a finite positive number with at
// most 2 decimal places (rejects strings, NaN, Infinity, scientific notation).
function isMoney(value) {
  return typeof value === 'number' &&
    Number.isFinite(value) &&
    value > 0 &&
    value <= MAX_BONUS_NAIRA &&
    /^\d+(\.\d{1,2})?$/.test(String(value));
}

function toPositiveInt(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 1) return NaN;
  return n;
}

function parseDate(value, label) {
  if (value === undefined || value === null || value === '') return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new HttpError(400, `${label} must be a valid date.`);
  }
  return date;
}

/**
 * Validates the mutable coupon fields found in req.body. Returns the parsed
 * values; throws HttpError(400) with a message the client can show.
 * `existing` is supplied when updating, so partial bodies inherit stored values.
 */
function parseCouponInput(body = {}, existing = null) {
  const bonus_type = body.bonus_type !== undefined ? String(body.bonus_type).toLowerCase() : (existing ? existing.bonus_type : 'fixed');
  if (!BONUS_TYPES.includes(bonus_type)) {
    throw new HttpError(400, "bonus_type must be 'fixed' or 'percent'.");
  }

  const bonus_value = body.bonus_value !== undefined ? body.bonus_value : (existing ? Number(existing.bonus_value) : undefined);
  if (!isMoney(bonus_value)) {
    throw new HttpError(400, 'bonus_value must be a valid amount greater than 0.');
  }
  if (bonus_type === 'percent' && bonus_value > 100) {
    throw new HttpError(400, 'A percent bonus cannot be greater than 100.');
  }

  let base_amount = body.base_amount !== undefined
    ? body.base_amount
    : (existing && existing.base_amount != null ? Number(existing.base_amount) : null);
  if (bonus_type === 'percent') {
    if (base_amount === null || base_amount === undefined) {
      throw new HttpError(400, 'base_amount is required for a percent bonus.');
    }
    if (!isMoney(base_amount)) {
      throw new HttpError(400, 'base_amount must be a valid amount greater than 0.');
    }
  } else {
    base_amount = null;
  }

  let max_bonus = body.max_bonus !== undefined
    ? body.max_bonus
    : (existing && existing.max_bonus != null ? Number(existing.max_bonus) : null);
  if (max_bonus !== null && max_bonus !== undefined) {
    if (!isMoney(max_bonus)) {
      throw new HttpError(400, 'max_bonus must be a valid amount greater than 0.');
    }
  } else {
    max_bonus = null;
  }

  const max_uses = body.max_uses !== undefined ? toPositiveInt(body.max_uses, null) : (existing ? existing.max_uses : null);
  if (Number.isNaN(max_uses)) throw new HttpError(400, 'max_uses must be a whole number of at least 1.');

  const max_uses_per_user = body.max_uses_per_user !== undefined
    ? toPositiveInt(body.max_uses_per_user, NaN)
    : (existing ? existing.max_uses_per_user : 1);
  if (Number.isNaN(max_uses_per_user)) throw new HttpError(400, 'max_uses_per_user must be a whole number of at least 1.');

  const starts_at = body.starts_at !== undefined ? parseDate(body.starts_at, 'starts_at') : (existing ? existing.starts_at : null);
  const expires_at = body.expires_at !== undefined ? parseDate(body.expires_at, 'expires_at') : (existing ? existing.expires_at : null);
  if (starts_at && expires_at && new Date(expires_at).getTime() <= new Date(starts_at).getTime()) {
    throw new HttpError(400, 'expires_at must be later than starts_at.');
  }

  const description = body.description !== undefined
    ? (body.description === null ? null : String(body.description).trim().slice(0, 255))
    : (existing ? existing.description : null);

  let is_active;
  if (body.is_active !== undefined) {
    if (typeof body.is_active !== 'boolean') throw new HttpError(400, 'is_active must be true or false.');
    is_active = body.is_active;
  } else {
    is_active = existing ? existing.is_active : true;
  }

  return { bonus_type, bonus_value, base_amount, max_bonus, max_uses, max_uses_per_user, starts_at, expires_at, description, is_active };
}

/** Why this coupon can't be used right now, or null if it can. */
function checkAvailability(coupon, now = new Date()) {
  if (!coupon.is_active) return { status: 403, message: 'This coupon code is no longer active.' };
  if (coupon.starts_at && now < new Date(coupon.starts_at)) {
    return { status: 403, message: 'This coupon code is not active yet.' };
  }
  if (coupon.expires_at && now > new Date(coupon.expires_at)) {
    return { status: 403, message: 'This coupon code has expired.' };
  }
  if (coupon.max_uses != null && coupon.used_count >= coupon.max_uses) {
    return { status: 403, message: 'This coupon code has been fully redeemed.' };
  }
  return null;
}

/** Bonus in kobo for this coupon, honouring the percent base and cap. */
function computeBonusKobo(coupon) {
  if (coupon.bonus_type === 'percent') {
    const baseKobo = toKobo(coupon.base_amount || 0);
    let kobo = Math.round((baseKobo * Number(coupon.bonus_value)) / 100);
    if (coupon.max_bonus != null) kobo = Math.min(kobo, toKobo(coupon.max_bonus));
    return kobo;
  }
  return toKobo(coupon.bonus_value);
}

function couponJson(coupon) {
  const json = coupon.toJSON();
  const redemptions = json.redemptions || [];
  const remaining = coupon.max_uses == null ? null : Math.max(0, coupon.max_uses - coupon.used_count);
  return {
    ...json,
    redemption_count: redemptions.length,
    remaining_uses: remaining,
  };
}

// ─────────────────────────────────────────────
// Admin: POST /admin/coupons
// ─────────────────────────────────────────────
async function createCoupon(req, res) {
  try {
    const code = normalizeCode(req.body?.code);
    if (!CODE_PATTERN.test(code)) {
      return res.status(400).json({
        success: false,
        message: "code must be 3-32 characters using only letters, numbers, '-' or '_' (no spaces).",
      });
    }

    const fields = parseCouponInput(req.body || {});
    const coupon = await Coupon.create({
      code,
      ...fields,
      created_by: req.adminUser?.id || req.user?.userId || null,
    });

    return res.status(201).json({ success: true, message: 'Coupon created successfully.', coupon: couponJson(coupon) });
  } catch (error) {
    if (error.status) {
      return res.status(error.status).json({ success: false, message: error.message });
    }
    if (error.name === 'SequelizeUniqueConstraintError') {
      return res.status(409).json({ success: false, message: 'That coupon code already exists.' });
    }
    logger.error('Error creating coupon', { error: error.message, adminId: req.user?.userId });
    return res.status(500).json({ success: false, message: 'Server error while creating coupon.' });
  }
}

// ─────────────────────────────────────────────
// Admin: GET /admin/coupons
// ─────────────────────────────────────────────
async function listCoupons(req, res) {
  try {
    const where = {};
    if (req.query.active === 'true') where.is_active = true;
    if (req.query.active === 'false') where.is_active = false;
    if (req.query.code) where.code = normalizeCode(req.query.code);

    const coupons = await Coupon.findAll({
      where,
      order: [['createdAt', 'DESC']],
      include: [{
        model: CouponRedemption,
        as: 'redemptions',
        attributes: ['id', 'user_id', 'amount', 'tx_ref', 'createdAt'],
        include: [{ model: Users, attributes: ['id', 'full_name', 'email'] }],
      }],
    });

    return res.status(200).json({ success: true, data: coupons.map(couponJson) });
  } catch (error) {
    logger.error('Error listing coupons', { error: error.message, adminId: req.user?.userId });
    return res.status(500).json({ success: false, message: 'Server error while listing coupons.' });
  }
}

// ─────────────────────────────────────────────
// Admin: GET /admin/coupons/:id
// ─────────────────────────────────────────────
async function getCoupon(req, res) {
  try {
    const coupon = await Coupon.findOne({
      where: { id: req.params.id },
      include: [{
        model: CouponRedemption,
        as: 'redemptions',
        attributes: ['id', 'user_id', 'amount', 'tx_ref', 'createdAt'],
        include: [{ model: Users, attributes: ['id', 'full_name', 'email'] }],
      }],
    });
    if (!coupon) return res.status(404).json({ success: false, message: 'Coupon not found.' });

    return res.status(200).json({ success: true, data: couponJson(coupon) });
  } catch (error) {
    logger.error('Error fetching coupon', { error: error.message, couponId: req.params.id });
    return res.status(500).json({ success: false, message: 'Server error while fetching coupon.' });
  }
}

// ─────────────────────────────────────────────
// Admin: PATCH /admin/coupons/:id
// ─────────────────────────────────────────────
async function updateCoupon(req, res) {
  try {
    const coupon = await Coupon.findOne({ where: { id: req.params.id } });
    if (!coupon) return res.status(404).json({ success: false, message: 'Coupon not found.' });

    const fields = parseCouponInput(req.body || {}, coupon);
    await coupon.update(fields);

    return res.status(200).json({ success: true, message: 'Coupon updated successfully.', coupon: couponJson(coupon) });
  } catch (error) {
    if (error.status) {
      return res.status(error.status).json({ success: false, message: error.message });
    }
    logger.error('Error updating coupon', { error: error.message, couponId: req.params.id });
    return res.status(500).json({ success: false, message: 'Server error while updating coupon.' });
  }
}

// ─────────────────────────────────────────────
// Admin: DELETE /admin/coupons/:id
// ─────────────────────────────────────────────
async function deleteCoupon(req, res) {
  try {
    const coupon = await Coupon.findOne({ where: { id: req.params.id } });
    if (!coupon) return res.status(404).json({ success: false, message: 'Coupon not found.' });

    const used = await CouponRedemption.count({ where: { coupon_id: coupon.id } });
    if (used > 0) {
      return res.status(409).json({
        success: false,
        message: 'This coupon has already been redeemed. Set is_active to false instead so history stays intact.',
      });
    }

    await coupon.destroy();
    return res.status(200).json({ success: true, message: 'Coupon deleted successfully.' });
  } catch (error) {
    logger.error('Error deleting coupon', { error: error.message, couponId: req.params.id });
    return res.status(500).json({ success: false, message: 'Server error while deleting coupon.' });
  }
}

// ─────────────────────────────────────────────
// User: POST /wallet/coupons/redeem
// ─────────────────────────────────────────────
async function redeemCoupon(req, res) {
  try {
    const user_id = req.user?.userId || req.user?.id;
    if (!user_id) {
      return res.status(401).json({ success: false, message: 'User authentication required' });
    }

    const code = normalizeCode(req.body?.code);
    if (!CODE_PATTERN.test(code)) {
      return res.status(400).json({ success: false, message: 'Enter a valid coupon code.' });
    }

    const coupon = await Coupon.findOne({ where: { code } });
    if (!coupon) {
      return res.status(404).json({ success: false, message: 'Coupon code is invalid or has expired.' });
    }

    // Fast, friendly failure before opening a transaction — re-checked under
    // the row lock below, because these values can change in between.
    const early = checkAvailability(coupon);
    if (early) return res.status(early.status).json({ success: false, message: early.message });

    const user = await Users.findByPk(user_id);
    if (!user) return res.status(404).json({ success: false, message: 'User account not found' });

    const result = await withTransaction(async (t) => {
      // Lock the coupon row: serialises every redemption of this code, so
      // used_count and the per-user count can't be raced past.
      const fresh = await Coupon.findOne({ where: { id: coupon.id }, transaction: t, lock: t.LOCK.UPDATE });
      if (!fresh) throw new HttpError(404, 'Coupon code is invalid or has expired.');

      const unavailable = checkAvailability(fresh);
      if (unavailable) throw new HttpError(unavailable.status, unavailable.message);

      const alreadyRedeemed = await CouponRedemption.count({
        where: { coupon_id: fresh.id, user_id },
        transaction: t,
      });
      if (alreadyRedeemed >= fresh.max_uses_per_user) {
        throw new HttpError(403, 'You have already used this coupon code.');
      }

      let wallet = await Wallet.findOne({ where: { user_id }, transaction: t, lock: t.LOCK.UPDATE });
      if (!wallet) wallet = await createWalletForUser(user, t);
      if (wallet.status !== 'ACTIVE') throw new HttpError(400, 'Wallet is not active');

      const bonusKobo = computeBonusKobo(fresh);
      if (bonusKobo <= 0) throw new HttpError(400, 'This coupon does not offer a bonus.');

      await applyKoboDelta(wallet, bonusKobo, t);

      const amount = fromKobo(bonusKobo);
      const tx_ref = `RENTULO-BONUS-${crypto.randomUUID()}`;

      const tx = await WalletTransactions.create({
        wallet_id: wallet.id,
        user_id,
        tx_ref,
        type: 'bonus',
        amount,
        status: 'success',
        narration: `Coupon bonus (${fresh.code})`,
        from_account_name: 'RentULO Bonus',
        to_account_number: wallet.accountNumber,
        to_account_name: wallet.accountName,
        meta: {
          coupon_id: fresh.id,
          code: fresh.code,
          bonus_type: fresh.bonus_type,
          bonus_value: fresh.bonus_value,
          base_amount: fresh.base_amount,
        },
      }, { transaction: t });

      fresh.used_count = fresh.used_count + 1;
      await fresh.save({ transaction: t });

      const redemption = await CouponRedemption.create({
        coupon_id: fresh.id,
        user_id,
        amount,
        tx_ref,
      }, { transaction: t });

      return { coupon: fresh, wallet, tx, redemption };
    }, { context: 'redeemCoupon', coupon_id: coupon.id, user_id });

    // Notifications run after commit and never block the response path on
    // failure (both helpers swallow their own errors).
    const bonusFormatted = Number(result.tx.amount).toLocaleString();
    const html = buildPropertyEmailHtml({
      heading: 'Coupon Bonus Credited',
      subheading: 'Wallet Bonus Confirmation',
      bodyText: `Coupon <strong>${result.coupon.code}</strong> was applied to your account and <strong>₦${bonusFormatted}</strong> has been added to your wallet.`,
      recipientName: user.full_name,
      transaction: { amount: result.tx.amount, reference: result.tx.tx_ref, payment_type: 'coupon_bonus', status: 'Success' },
    });
    await logAndEmailUser(user_id, user.email, 'Coupon Bonus Credited', html);
    await notifySuperAdmins(
      `${user.full_name} redeemed coupon ${result.coupon.code} and received ₦${bonusFormatted}.`,
      'system',
      {
        heading: 'Coupon Redeemed',
        transaction: { amount: result.tx.amount, reference: result.tx.tx_ref, payment_type: 'coupon_bonus', status: 'Success' },
        tenant: { full_name: user.full_name, email: user.email },
      }
    );

    return res.status(200).json({
      success: true,
      message: `Coupon applied — ₦${bonusFormatted} bonus credited.`,
      bonus: result.tx.amount,
      balance: result.wallet.balance,
      tx_ref: result.tx.tx_ref,
      transaction: result.tx,
      coupon: { code: result.coupon.code, description: result.coupon.description },
    });
  } catch (error) {
    if (error.status) {
      return res.status(error.status).json({ success: false, message: error.message });
    }
    logger.error('Error redeeming coupon', {
      error: error.message,
      userId: req.user?.userId,
      code: normalizeCode(req.body?.code),
    });
    return res.status(500).json({ success: false, message: 'Server error while redeeming coupon.' });
  }
}

module.exports = {
  createCoupon,
  listCoupons,
  getCoupon,
  updateCoupon,
  deleteCoupon,
  redeemCoupon,
};
