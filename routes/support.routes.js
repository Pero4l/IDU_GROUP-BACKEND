'use strict';

const express = require('express');
const rateLimit = require('express-rate-limit');
const { authMiddleware } = require('../middleware/authUserMiddleware');
const { requireSuperAdmin } = require('../middleware/superAdminMiddleware');
const {
  createTicket,
  getMyTickets,
  getTicketByRef,
  replyToTicket,
  getAllTickets,
  getAdminTicket,
  adminReplyTicket,
  adminResolveTicket,
  getTicketStats,
} = require('../controllers/support.controller');

const router = express.Router();

// Throttles ticket creation/replying so a single account can't flood the queue.
const supportLimiter = rateLimit({
  windowMs: 1 * 60 * 60 * 1000, // 1 hour
  max: 20,
  keyGenerator: (req) => req.user?.userId || rateLimit.ipKeyGenerator(req.ip),
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: 'You have reached the maximum number of support requests for now. Please try again later.',
  },
});

// ─── User routes ─────────────────────────────────────────────────────────────

router.post('/support/tickets', authMiddleware, supportLimiter, createTicket);
router.get('/support/tickets', authMiddleware, getMyTickets);
router.get('/support/tickets/:ref', authMiddleware, getTicketByRef);
router.post('/support/tickets/:ref/reply', authMiddleware, supportLimiter, replyToTicket);

// ─── Admin routes ────────────────────────────────────────────────────────────

router.get('/admin/support/stats', authMiddleware, requireSuperAdmin, getTicketStats);
router.get('/admin/support/tickets', authMiddleware, requireSuperAdmin, getAllTickets);
router.get('/admin/support/tickets/:ref', authMiddleware, requireSuperAdmin, getAdminTicket);
router.post('/admin/support/tickets/:ref/reply', authMiddleware, requireSuperAdmin, adminReplyTicket);
router.post('/admin/support/tickets/:ref/resolve', authMiddleware, requireSuperAdmin, adminResolveTicket);

module.exports = router;