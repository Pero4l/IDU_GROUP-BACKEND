const { Reports, Users, WalletTransactions } = require('../models');
const { Op } = require('sequelize');
const { notifySuperAdmins, logAndEmailUser } = require('./notification.controller');
const { withTransaction } = require('../utils/rollback');
const logger = require('../utils/logger');

const USER_REPORT_TYPES = ['spam', 'harassment', 'fraud', 'other'];
const WALLET_REPORT_TYPES = ['failed_transaction', 'missing_funds', 'wrong_charge', 'refund_issue', 'withdrawal_issue', 'fraud', 'other'];
const CATEGORIES = ['user', 'wallet'];
const MAX_MESSAGE_LENGTH = 2000;
const MAX_NAME_MATCHES = 10;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

class ReportError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

function escapeLike(value) {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

// Finds the one user a name refers to. Exact (case-insensitive) full-name
// matches win; otherwise a partial match is tried. More than one candidate
// is never guessed: the caller gets the list and resubmits with an id.
//   landlordOnly — `landlord_name`: only landlords, name only
//   otherwise    — legacy `search_name`: any user, name or email
async function findUserByName(rawName, { landlordOnly, excludeUserId }) {
  const name = String(rawName).trim().replace(/\s+/g, ' ');
  if (name.length < 2) {
    throw new ReportError(400, 'Please enter at least 2 characters of the name.');
  }
  const base = { id: { [Op.ne]: excludeUserId } };
  if (landlordOnly) base.role = 'landlord';
  const attributes = ['id', 'full_name', 'phone_no', 'role'];
  const like = `%${escapeLike(name)}%`;

  let matches = await Users.findAll({
    where: { ...base, full_name: { [Op.iLike]: escapeLike(name) } },
    attributes,
    limit: MAX_NAME_MATCHES + 1,
  });
  if (matches.length === 0) {
    const fields = landlordOnly
      ? [{ full_name: { [Op.iLike]: like } }]
      : [{ full_name: { [Op.iLike]: like } }, { email: { [Op.iLike]: like } }];
    matches = await Users.findAll({
      where: { ...base, [Op.or]: fields },
      attributes,
      order: [['full_name', 'ASC']],
      limit: MAX_NAME_MATCHES + 1,
    });
  }

  if (matches.length === 0) {
    throw new ReportError(404, landlordOnly ? 'No landlord found with that name.' : 'User to report not found.');
  }
  if (matches.length > 1) {
    throw new ReportError(409, `More than one ${landlordOnly ? 'landlord' : 'user'} matches that name. Please pick one and resubmit with report_user_id.`, {
      code: 'AMBIGUOUS_NAME',
      matches: matches.slice(0, MAX_NAME_MATCHES).map((u) => ({ id: u.id, full_name: u.full_name, role: u.role })),
      moreMatches: matches.length > MAX_NAME_MATCHES,
    });
  }
  return matches[0];
}

async function resolveReportedUser(body, user_id) {
  const { report_user_id, landlord_name, search_name } = body;
  const given = [report_user_id, landlord_name, search_name].filter((v) => v !== undefined && v !== null && v !== '');
  if (given.length === 0) {
    throw new ReportError(400, 'Please provide report_user_id or landlord_name to identify the user.');
  }
  if (given.length > 1) {
    throw new ReportError(400, 'Please provide only one of report_user_id, landlord_name or search_name.');
  }

  let user;
  if (report_user_id) {
    if (!UUID_PATTERN.test(String(report_user_id))) throw new ReportError(404, 'User to report not found.');
    user = await Users.findByPk(report_user_id, { attributes: ['id', 'full_name', 'phone_no', 'role'] });
    if (!user) throw new ReportError(404, 'User to report not found.');
  } else {
    user = await findUserByName(landlord_name ?? search_name, { landlordOnly: !!landlord_name, excludeUserId: user_id });
  }
  if (user.id === user_id) throw new ReportError(400, 'You cannot report yourself.');
  return user;
}

// The reporter's own wallet transaction, by tx_ref or id. Optional.
async function resolveWalletTransaction(body, user_id) {
  const { transaction_ref, wallet_transaction_id } = body;
  if (!transaction_ref && !wallet_transaction_id) return null;
  if (wallet_transaction_id && !UUID_PATTERN.test(String(wallet_transaction_id))) {
    throw new ReportError(404, 'Wallet transaction not found.');
  }
  const where = { user_id };
  if (wallet_transaction_id) where.id = wallet_transaction_id;
  if (transaction_ref) where.tx_ref = String(transaction_ref).trim();
  const tx = await WalletTransactions.findOne({
    where,
    attributes: ['id', 'tx_ref', 'type', 'amount', 'status', 'narration', 'createdAt'],
  });
  if (!tx) throw new ReportError(404, 'Wallet transaction not found.');
  return tx;
}

// POST /report
// User report:   { report_user_id | landlord_name | search_name, report_type, report_message }
// Wallet report: { report_category: "wallet", report_type, report_message, transaction_ref? | wallet_transaction_id? }
async function createReport(req, res) {
  try {
    const user_id = req.user.userId;
    const category = req.body.report_category || 'user';
    const report_message = typeof req.body.report_message === 'string' ? req.body.report_message.trim() : '';
    const report_type = req.body.report_type || 'other';

    if (!CATEGORIES.includes(category)) {
      return res.status(400).json({ success: false, message: `report_category must be one of: ${CATEGORIES.join(', ')}` });
    }
    if (!report_message) {
      return res.status(400).json({ success: false, message: "Report message is required." });
    }
    if (report_message.length > MAX_MESSAGE_LENGTH) {
      return res.status(400).json({ success: false, message: `Report message must be at most ${MAX_MESSAGE_LENGTH} characters.` });
    }
    const allowedTypes = category === 'wallet' ? WALLET_REPORT_TYPES : USER_REPORT_TYPES;
    if (!allowedTypes.includes(report_type)) {
      return res.status(400).json({ success: false, message: `report_type for a ${category} report must be one of: ${allowedTypes.join(', ')}` });
    }

    let report_user = null;
    let walletTx = null;
    if (category === 'user') {
      report_user = await resolveReportedUser(req.body, user_id);
    } else {
      walletTx = await resolveWalletTransaction(req.body, user_id);
    }

    const report = await withTransaction(async (t) => Reports.create({
      user_id,
      report_category: category,
      report_user_id: report_user?.id ?? null,
      report_name: report_user ? (report_user.full_name || '') : null,
      report_number: report_user ? (report_user.phone_no || '') : null,
      wallet_transaction_id: walletTx?.id ?? null,
      transaction_ref: walletTx?.tx_ref ?? null,
      report_type,
      report_message,
      report_status: 'pending',
    }, { transaction: t }), { context: 'createReport', user_id, category, reportedUserId: report_user?.id });

    logger.info('Report created', { reportId: report.id, user_id, category, reportedUserId: report_user?.id, walletTxId: walletTx?.id });

    // Non-critical side-effects
    const subject = category === 'wallet'
      ? `wallet issue${walletTx ? ` (${walletTx.tx_ref})` : ''}`
      : (report_user.full_name || 'a user');
    try {
      const reporter = await Users.findByPk(user_id, { attributes: ['email'] });
      await logAndEmailUser(user_id, reporter?.email, "Report Submitted",
        category === 'wallet'
          ? `Your report about a ${subject} has been submitted and is being reviewed.`
          : `Your report against ${subject} has been submitted and is being reviewed.`
      );
      await notifySuperAdmins(
        category === 'wallet' ? `New wallet report: ${report_type.replace(/_/g, ' ')}${walletTx ? ` (${walletTx.tx_ref})` : ''}` : `New report filed against ${subject}`,
        'warning'
      );
    } catch (e) {
      logger.warn('Report notifications failed', { error: e.message, reportId: report.id });
    }

    const data = report.toJSON();
    if (walletTx) data.wallet_transaction = walletTx.toJSON();
    return res.status(201).json({ success: true, message: "Report submitted successfully.", data });
  } catch (error) {
    if (error instanceof ReportError) {
      return res.status(error.status).json({ success: false, message: error.message, ...error.extra });
    }
    logger.error('Error creating report', { error: error.message, userId: req.user?.userId });
    return res.status(500).json({ success: false, message: "Server error" });
  }
}

module.exports = { createReport, USER_REPORT_TYPES, WALLET_REPORT_TYPES };
