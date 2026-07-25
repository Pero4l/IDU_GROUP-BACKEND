const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../middleware/authUserMiddleware');
const { chat, getHistory, deleteSession, getSessions } = require('../controllers/aiSupport.controller');

// Chat with AI — send message and get response
router.post('/chat', authMiddleware, chat);

// Get all sessions for the current user
router.get('/sessions', authMiddleware, getSessions);

// Get chat history (optionally filtered by session_id)
router.get('/history', authMiddleware, getHistory);

// Delete a specific chat session
router.delete('/session/:session_id', authMiddleware, deleteSession);

module.exports = router;
