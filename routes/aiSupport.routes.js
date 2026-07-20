const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../middleware/authUserMiddleware');
const { chat, getHistory, deleteSession, getSessions } = require('../controllers/aiSupport.controller');
const rateLimit = require('express-rate-limit');

// AI support specific rate limiters
const aiChatLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 10,                  // 10 messages per minute
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: 'You are sending messages too quickly. Please slow down.',
  },
});

const aiHistoryLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Too many requests. Please try again later.',
  },
});

// Chat with AI — send message and get response
router.post('/chat', authMiddleware, aiChatLimiter, chat);

// Get all sessions for the current user
router.get('/sessions', authMiddleware, aiHistoryLimiter, getSessions);

// Get chat history (optionally filtered by session_id)
router.get('/history', authMiddleware, aiHistoryLimiter, getHistory);

// Delete a specific chat session
router.delete('/session/:session_id', authMiddleware, deleteSession);

module.exports = router;
