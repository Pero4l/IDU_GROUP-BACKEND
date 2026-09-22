'use strict';

const crypto = require('crypto');
const { Op } = require('sequelize');
const { SupportTicket, SupportTicketReply, Users } = require('../models');
const { withTransaction } = require('../utils/rollback');
const { notifySuperAdmins, logAndEmailUser } = require('./notification.controller');
const { buildEmailShell } = require('../utils/emailTemplates');
const logger = require('../utils/logger');

const TICKET_CATEGORIES = ['general', 'billing', 'technical', 'account', 'property', 'other'];
const TICKET_PRIORITIES = ['low', 'medium', 'high', 'urgent'];
const TICKET_STATUSES = ['open', 'in_progress'];

// ─── Helpers ─────────────────────────────────────────────────────────────────

// Short, user-facing reference like TKT-7K3FSA. Ambiguous characters (I, O, 0, 1)
// are omitted so references can be dictated over the phone without confusion.
const REF_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function generateTicketRef() {
  let out = '';
  for (let i = 0; i < 6; i++) {
    out += REF_ALPHABET[crypto.randomInt(REF_ALPHABET.length)];
  }
  return `TKT-${out}`;
}

// Ensures the generated reference is unique. The DB unique constraint is the
// final guard — if a (unlikely) collision slips through, we retry a few times.
async function createTicketRef() {
  for (let attempt = 0; attempt < 5; attempt++) {
    const ticket_ref = generateTicketRef();
    const exists = await SupportTicket.findOne({ where: { ticket_ref } });
    if (!exists) return ticket_ref;
  }
  throw new Error('Failed to allocate a unique ticket reference');
}

function buildTicketEmail(subject, bodyText, actionLabel, actionUrl) {
  return buildEmailShell({
    preheader: subject,
    eyebrow: 'RentULO Support',
    heading: subject,
    bodyHtml: `
      <p style="margin:0 0 16px;">Hello there,</p>
      <p style="margin:0;">${bodyText}</p>
      ${actionLabel && actionUrl ? `
        <div style="margin:28px 0 4px;">
          <a href="${actionUrl}" style="background-color:#059669;color:#ffffff;padding:10px 24px;text-decoration:none;border-radius:4px;font-size:14px;font-weight:500;display:inline-block;">${actionLabel}</a>
        </div>` : ''}
    `,
  });
}

// Validates a body field against length rules, returning an error message or null.
function validateMessage(field, value, { required, min = 1, max = 5000, label }) {
  if (required && (!value || !String(value).trim())) {
    return `${label} is required.`;
  }
  if (value) {
    const len = String(value).trim().length;
    if (len < min) return `${label} must be at least ${min} characters.`;
    if (len > max) return `${label} must be under ${max} characters.`;
  }
  return null;
}

// ─── User endpoints ──────────────────────────────────────────────────────────

// POST /support/tickets
async function createTicket(req, res) {
  try {
    const { subject, category, priority, description } = req.body || {};
    const user_id = req.user.userId;

    const err =
      validateMessage('subject', subject, { required: true, min: 3, max: 200, label: 'Subject' }) ||
      validateMessage('description', description, { required: true, min: 10, max: 5000, label: 'Description' });

    if (err) {
      return res.status(400).json({ success: false, message: err });
    }

    if (category && !TICKET_CATEGORIES.includes(category)) {
      return res.status(400).json({ success: false, message: `Category must be one of: ${TICKET_CATEGORIES.join(', ')}.` });
    }
    if (priority && !TICKET_PRIORITIES.includes(priority)) {
      return res.status(400).json({ success: false, message: `Priority must be one of: ${TICKET_PRIORITIES.join(', ')}.` });
    }

    const ticket_ref = await createTicketRef();

    const ticket = await withTransaction(async (t) => {
      return SupportTicket.create(
        {
          ticket_ref,
          user_id,
          subject: subject.trim(),
          category: category || 'general',
          priority: priority || 'medium',
          status: 'open',
          description: description.trim(),
        },
        { transaction: t }
      );
    }, { context: 'createSupportTicket', user_id });

    logger.info('Support ticket created', { ticketId: ticket.id, ticket_ref: ticket.ticket_ref, user_id });

    // Non-critical side-effects — a notification/mail failure must never fail the request.
    const user = await Users.findByPk(user_id);
    await logAndEmailUser(
      user_id,
      user?.email,
      `Ticket ${ticket.ticket_ref} created`,
      buildTicketEmail(
        `We received your request ${ticket.ticket_ref}`,
        `Your ticket has been created successfully. An agent will respond shortly.<br/><br/>` +
          `<strong>Subject:</strong> ${ticket.subject}<br/><strong>Priority:</strong> ${ticket.priority}<br/><strong>Status:</strong> Open`,
        'View My Tickets',
        'https://rentulo.ng/support'
      )
    );
    await notifySuperAdmins(
      `New support ticket ${ticket.ticket_ref}: ${ticket.subject} (${ticket.priority})`,
      'warning'
    );

    return res.status(201).json({
      success: true,
      message: 'Support ticket created successfully.',
      data: ticket,
    });
  } catch (error) {
    logger.error('Error creating support ticket', { error: error.message, userId: req.user?.userId });
    return res.status(500).json({ success: false, message: 'Server error' });
  }
}

// GET /support/tickets — the current user's tickets, with last reply + reply count.
async function getMyTickets(req, res) {
  try {
    const user_id = req.user.userId;
    const { status: rawStatus, page = 1, limit = 20 } = req.query;

    const status = TICKET_STATUSES.includes(rawStatus) ? rawStatus : undefined;
    const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);
    const safePage = Math.max(parseInt(page, 10) || 1, 1);
    const offset = (safePage - 1) * safeLimit;

    const where = ['t.user_id = :user_id'];
    const replacements = { user_id, limit: safeLimit, offset };
    if (status) {
      where.push('t.status = :status');
      replacements.status = status;
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const statusWhere = status ? { status } : {};

    const { sequelize } = require('../models');
    const tickets = await sequelize.query(
      `SELECT t.id, t.ticket_ref, t.subject, t.category, t.priority, t.status,
              t."createdAt", t."updatedAt",
              (SELECT COUNT(*) FROM support_ticket_replies r WHERE r.ticket_id = t.id) AS reply_count,
              (SELECT r.message FROM support_ticket_replies r WHERE r.ticket_id = t.id
               ORDER BY r."createdAt" DESC LIMIT 1) AS last_reply
       FROM support_tickets t
       ${whereSql}
       ORDER BY t."updatedAt" DESC
       LIMIT :limit OFFSET :offset`,
      {
        replacements,
        type: sequelize.QueryTypes.SELECT,
      }
    );
    const total = await SupportTicket.count({ where: { user_id, ...statusWhere } });

    return res.status(200).json({
      success: true,
      data: tickets,
      pagination: { page: safePage, limit: safeLimit, total },
    });
  } catch (error) {
    logger.error('Error fetching user support tickets', { error: error.message, userId: req.user?.userId });
    return res.status(500).json({ success: false, message: 'Server error' });
  }
}

// GET /support/tickets/:ref — full detail (owner only)
async function getTicketByRef(req, res) {
  try {
    const user_id = req.user.userId;
    const { ref } = req.params;

    const ticket = await SupportTicket.findOne({
      where: { ticket_ref: ref, user_id },
    });

    if (!ticket) {
      return res.status(404).json({ success: false, message: 'Ticket not found.' });
    }

    const replies = await SupportTicketReply.findAll({
      where: { ticket_id: ticket.id },
      order: [['createdAt', 'ASC']],
      attributes: ['id', 'sender_role', 'message', 'createdAt'],
    });

    return res.status(200).json({ success: true, data: { ...ticket.toJSON(), replies } });
  } catch (error) {
    logger.error('Error fetching support ticket', { error: error.message, userId: req.user?.userId });
    return res.status(500).json({ success: false, message: 'Server error' });
  }
}

// POST /support/tickets/:ref/reply — the user adds a follow-up message.
async function replyToTicket(req, res) {
  try {
    const user_id = req.user.userId;
    const { ref } = req.params;
    const { message } = req.body || {};

    const err = validateMessage('message', message, { required: true, min: 1, max: 2000, label: 'Message' });
    if (err) {
      return res.status(400).json({ success: false, message: err });
    }

    const ticket = await SupportTicket.findOne({ where: { ticket_ref: ref, user_id } });
    if (!ticket) {
      return res.status(404).json({ success: false, message: 'Ticket not found.' });
    }

    const reply = await withTransaction(async (t) => {
      return SupportTicketReply.create(
        {
          ticket_id: ticket.id,
          sender_id: user_id,
          sender_role: 'user',
          message: message.trim(),
        },
        { transaction: t }
      );
    }, { context: 'replySupportTicket', user_id, ticketId: ticket.id });

    logger.info('User replied to support ticket', { ticketId: ticket.id, user_id });

    return res.status(201).json({
      success: true,
      message: 'Reply added successfully.',
      data: { ticket_ref: ticket.ticket_ref, reply },
    });
  } catch (error) {
    logger.error('Error replying to support ticket', { error: error.message, userId: req.user?.userId });
    return res.status(500).json({ success: false, message: 'Server error' });
  }
}

// ─── Admin endpoints ─────────────────────────────────────────────────────────

// GET /admin/support/tickets — all tickets with filters, search and pagination.
async function getAllTickets(req, res) {
  try {
    const { status: rawStatus, priority: rawPriority, category: rawCategory, q, page = 1, limit = 20 } = req.query;

    const status = TICKET_STATUSES.includes(rawStatus) ? rawStatus : undefined;
    const priority = TICKET_PRIORITIES.includes(rawPriority) ? rawPriority : undefined;
    const category = TICKET_CATEGORIES.includes(rawCategory) ? rawCategory : undefined;
    const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);
    const safePage = Math.max(parseInt(page, 10) || 1, 1);
    const offset = (safePage - 1) * safeLimit;

    const where = [];
    const replacements = { limit: safeLimit, offset };
    if (status) {
      where.push('t.status = :status');
      replacements.status = status;
    }
    if (priority) {
      where.push('t.priority = :priority');
      replacements.priority = priority;
    }
    if (category) {
      where.push('t.category = :category');
      replacements.category = category;
    }
    if (q && String(q).trim()) {
      where.push(`(t.ticket_ref ILIKE :q OR t.subject ILIKE :q OR u.full_name ILIKE :q OR u.email ILIKE :q)`);
      replacements.q = `%${String(q).trim()}%`;
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const { sequelize } = require('../models');
    const tickets = await sequelize.query(
      `SELECT t.id, t.ticket_ref, t.subject, t.category, t.priority, t.status,
              t."createdAt", t."updatedAt",
              u.id AS user_id, u.full_name AS user_name, u.email AS user_email, u.phone_no AS user_phone,
              (SELECT COUNT(*) FROM support_ticket_replies r WHERE r.ticket_id = t.id) AS reply_count,
              (SELECT r.message FROM support_ticket_replies r WHERE r.ticket_id = t.id
               ORDER BY r."createdAt" DESC LIMIT 1) AS last_reply
       FROM support_tickets t
       LEFT JOIN users u ON u.id = t.user_id
       ${whereSql}
       ORDER BY
         CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
         t."updatedAt" ASC
       LIMIT :limit OFFSET :offset`,
      {
        replacements,
        type: sequelize.QueryTypes.SELECT,
      }
    );

    const countWhere = {
      ...(status ? { status } : {}),
      ...(priority ? { priority } : {}),
      ...(category ? { category } : {}),
    };
    if (q && String(q).trim()) {
      countWhere[Op.or] = [
        { ticket_ref: { [Op.iLike]: `%${String(q).trim()}%` } },
        { subject: { [Op.iLike]: `%${String(q).trim()}%` } },
        { '$user.full_name$': { [Op.iLike]: `%${String(q).trim()}%` } },
        { '$user.email$': { [Op.iLike]: `%${String(q).trim()}%` } },
      ];
    }
    const total = await SupportTicket.count({
      where: countWhere,
      include: [{ model: Users, as: 'user', attributes: [] }],
    });

    return res.status(200).json({
      success: true,
      data: tickets,
      pagination: { page: safePage, limit: safeLimit, total },
    });
  } catch (error) {
    logger.error('Error fetching all support tickets', { error: error.message, userId: req.user?.userId });
    return res.status(500).json({ success: false, message: 'Server error' });
  }
}

// GET /admin/support/tickets/:ref — full detail with sender info (admin view)
async function getAdminTicket(req, res) {
  try {
    const { ref } = req.params;

    const ticket = await SupportTicket.findOne({
      where: { ticket_ref: ref },
      include: [{ model: Users, as: 'user', attributes: ['id', 'full_name', 'email', 'phone_no'] }],
    });

    if (!ticket) {
      return res.status(404).json({ success: false, message: 'Ticket not found.' });
    }

    const replies = await SupportTicketReply.findAll({
      where: { ticket_id: ticket.id },
      order: [['createdAt', 'ASC']],
      include: [{ model: Users, as: 'sender', attributes: ['id', 'full_name'] }],
      attributes: ['id', 'sender_role', 'message', 'createdAt'],
    });

    return res.status(200).json({ success: true, data: { ...ticket.toJSON(), replies } });
  } catch (error) {
    logger.error('Error fetching admin support ticket', { error: error.message, userId: req.user?.userId });
    return res.status(500).json({ success: false, message: 'Server error' });
  }
}

// POST /admin/support/tickets/:ref/reply — admin replies and marks ticket in progress.
async function adminReplyTicket(req, res) {
  try {
    const admin_id = req.user.userId;
    const { ref } = req.params;
    const { message } = req.body || {};

    const err = validateMessage('message', message, { required: true, min: 1, max: 2000, label: 'Message' });
    if (err) {
      return res.status(400).json({ success: false, message: err });
    }

    const ticket = await SupportTicket.findOne({
      where: { ticket_ref: ref },
      include: [{ model: Users, as: 'user' }],
    });
    if (!ticket) {
      return res.status(404).json({ success: false, message: 'Ticket not found.' });
    }

    const reply = await withTransaction(async (t) => {
      const created = await SupportTicketReply.create(
        {
          ticket_id: ticket.id,
          sender_id: admin_id,
          sender_role: 'admin',
          message: message.trim(),
        },
        { transaction: t }
      );
      await SupportTicket.update({ status: 'in_progress' }, { where: { id: ticket.id }, transaction: t });
      return created;
    }, { context: 'adminReplySupportTicket', admin_id, ticketId: ticket.id });

    logger.info('Admin replied to support ticket', { ticketId: ticket.id, admin_id });

    await logAndEmailUser(
      ticket.user_id,
      ticket.user?.email,
      `New reply on ticket ${ticket.ticket_ref}`,
      buildTicketEmail(
        `An agent replied to ${ticket.ticket_ref}`,
        `You have a new response on your support ticket.<br/><br/>` +
          `<strong>Ticket:</strong> ${ticket.ticket_ref}<br/><strong>Subject:</strong> ${ticket.subject}<br/><br/>` +
          `<blockquote style="margin:12px 0;padding:12px 16px;border-left:3px solid #059669;background:#f8f9fa;color:#3c4043;">${message.trim()}</blockquote>`,
        'View Conversation',
        'https://rentulo.ng/support'
      )
    );

    return res.status(201).json({
      success: true,
      message: 'Reply sent to user.',
      data: { ticket_ref: ticket.ticket_ref, status: 'in_progress', reply },
    });
  } catch (error) {
    logger.error('Error replying as admin to support ticket', { error: error.message, userId: req.user?.userId });
    return res.status(500).json({ success: false, message: 'Server error' });
  }
}

// POST /admin/support/tickets/:ref/resolve — resolves the ticket and purges it.
// Once solved, the ticket and its replies are destroyed to keep customer data
// lean — the requesting user is notified before the record disappears.
async function adminResolveTicket(req, res) {
  try {
    const admin_id = req.user.userId;
    const { ref } = req.params;

    const ticket = await SupportTicket.findOne({
      where: { ticket_ref: ref },
      include: [{ model: Users, as: 'user' }],
    });
    if (!ticket) {
      return res.status(404).json({ success: false, message: 'Ticket not found.' });
    }

    await withTransaction(async (t) => {
      await SupportTicketReply.destroy({ where: { ticket_id: ticket.id }, transaction: t });
      await SupportTicket.destroy({ where: { id: ticket.id }, transaction: t });
    }, { context: 'resolveSupportTicket', admin_id, ticketId: ticket.id });

    logger.info('Support ticket resolved and purged', { ticketId: ticket.id, ticket_ref: ticket.ticket_ref, admin_id });

    await logAndEmailUser(
      ticket.user_id,
      ticket.user?.email,
      `Ticket ${ticket.ticket_ref} resolved`,
      buildTicketEmail(
        `Your issue has been resolved`,
        `Your support ticket <strong>${ticket.ticket_ref}</strong> ("${ticket.subject}") has been marked as resolved by our team.` +
          `<br/><br/>Ticket detail is now closed and has been removed from our records.` +
          `<br/><br/>If you need further assistance, feel free to open a new ticket anytime.`,
        'Open a New Ticket',
        'https://rentulo.ng/support'
      )
    );

    return res.status(200).json({
      success: true,
      message: 'Ticket resolved and removed.',
      data: { ticket_ref: ticket.ticket_ref },
    });
  } catch (error) {
    logger.error('Error resolving support ticket', { error: error.message, userId: req.user?.userId });
    return res.status(500).json({ success: false, message: 'Server error' });
  }
}

// GET /admin/support/stats — quick dashboard counts.
async function getTicketStats(req, res) {
  try {
    const { sequelize } = require('../models');
    const byStatus = await SupportTicket.findAll({
      attributes: ['status', [sequelize.fn('COUNT', sequelize.col('status')), 'count']],
      group: ['status'],
      raw: true,
    });
    const byPriority = await SupportTicket.findAll({
      attributes: ['priority', [sequelize.fn('COUNT', sequelize.col('priority')), 'count']],
      group: ['priority'],
      raw: true,
    });

    const shape = (rows, key) =>
      rows.reduce((acc, row) => ({ ...acc, [row[key]]: Number(row.count) }), {});

    return res.status(200).json({
      success: true,
      data: {
        total_open: await SupportTicket.count(),
        by_status: shape(byStatus, 'status'),
        by_priority: shape(byPriority, 'priority'),
      },
    });
  } catch (error) {
    logger.error('Error fetching support ticket stats', { error: error.message, userId: req.user?.userId });
    return res.status(500).json({ success: false, message: 'Server error' });
  }
}

module.exports = {
  createTicket,
  getMyTickets,
  getTicketByRef,
  replyToTicket,
  getAllTickets,
  getAdminTicket,
  adminReplyTicket,
  adminResolveTicket,
  getTicketStats,
};