const { ShortletCancellationPolicies, Users } = require('../models');
const { getActivePolicy, savePolicy, PolicyValidationError, DEFAULT_RULES, describeStandardPolicy } = require('../utils/cancellationPolicy');
const { notifySuperAdmins } = require('./notification.controller');
const logger = require('../utils/logger');

const CHANGED_BY = { model: Users, as: 'changedBy', attributes: ['id', 'full_name', 'email'] };

function present(row) {
  const json = row.toJSON();
  return {
    version: json.version,
    rules: json.rules,
    note: json.note,
    changedBy: json.changedBy || null, // null = the built-in default
    changedAt: json.createdAt,
  };
}

// ─────────────────────────────────────────────
// GET /admin/shortlet-settings/cancellation-policy — super admin
// The policy new bookings get, a plain-language preview of it, and the full
// change history (newest first).
// ─────────────────────────────────────────────
async function getCancellationPolicySettings(req, res) {
  try {
    const history = await ShortletCancellationPolicies.findAll({ include: [CHANGED_BY], order: [['version', 'DESC']] });
    const current = history[0] ? present(history[0]) : { version: 0, rules: DEFAULT_RULES, note: 'Built-in default', changedBy: null, changedAt: null };
    // Example wording for a stay 30 days from now (refundable listing).
    const example = describeStandardPolicy(current.rules, {
      checkInAt: new Date(Date.now() + 30 * 24 * 3600e3),
      earlyCheckoutRefundable: true,
    });
    return res.status(200).json({
      success: true,
      message: "Cancellation policy retrieved successfully",
      data: { current, summary: example.summary, history: history.map(present) },
    });
  } catch (error) {
    logger.error('Error fetching cancellation policy settings', { error: error.message });
    return res.status(500).json({ success: false, message: "Server error" });
  }
}

// ─────────────────────────────────────────────
// PUT /admin/shortlet-settings/cancellation-policy — super admin
// Body: { rules: {...}, note? }. Saves a NEW version (nothing is overwritten).
// Only bookings made after this get the new rules.
// ─────────────────────────────────────────────
async function updateCancellationPolicySettings(req, res) {
  try {
    const { rules, note } = req.body || {};
    let row;
    try {
      row = await savePolicy({ rules, changedBy: req.user.userId, note });
    } catch (error) {
      if (error instanceof PolicyValidationError) {
        return res.status(400).json({ success: false, code: 'INVALID_POLICY', message: error.message, errors: error.errors });
      }
      throw error;
    }
    const saved = await ShortletCancellationPolicies.findByPk(row.id, { include: [CHANGED_BY] });
    logger.info('Cancellation policy updated', { version: row.version, by: req.user.userId });
    notifySuperAdmins(`The shortlet cancellation policy was changed to version ${row.version} by ${saved.changedBy?.full_name ?? req.user.userId}. It applies to new bookings only.`, 'shortlet')
      .catch(() => {});
    const active = await getActivePolicy();
    return res.status(200).json({
      success: true,
      message: "Cancellation policy updated. It applies to new bookings only.",
      data: { current: present(saved), activeVersion: active.version },
    });
  } catch (error) {
    logger.error('Error updating cancellation policy settings', { error: error.message });
    return res.status(500).json({ success: false, message: "Server error" });
  }
}

module.exports = { getCancellationPolicySettings, updateCancellationPolicySettings };
