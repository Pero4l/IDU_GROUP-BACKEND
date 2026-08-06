const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const { authMiddleware, optionalAuth } = require('../middleware/authUserMiddleware');
const { chat, getHistory, deleteSession, getSessions } = require('../controllers/aiSupport.controller');

const aiChatLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 30,
  keyGenerator: (req) => req.user?.userId || req.ip,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: 'You are sending messages too quickly. Please wait a moment.',
  },
});

// Chat with AI — auth optional (works for guests and logged-in users)
router.post('/chat', optionalAuth, aiChatLimiter, chat);

// Get all sessions for the current user
router.get('/sessions', authMiddleware, getSessions);

// Get chat history (optionally filtered by session_id)
router.get('/history', authMiddleware, getHistory);

// Delete a specific chat session
router.delete('/session/:session_id', authMiddleware, deleteSession);

module.exports = router;
