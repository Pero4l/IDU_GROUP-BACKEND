const express = require('express');
const router = express.Router();
const chatController = require('../controllers/chat.controller');
const { authMiddleware } = require('../middleware/authUserMiddleware');
const { isVerifiedMiddleware } = require('../middleware/verificationMiddleware');

router.post('/conversation', authMiddleware, isVerifiedMiddleware, chatController.initiateChat);
router.get('/conversation', authMiddleware, chatController.getChats);
router.post('/message', authMiddleware, isVerifiedMiddleware, chatController.sendMessage);
router.get('/message/:conversation_id', authMiddleware, chatController.getMessages);

module.exports = router;
