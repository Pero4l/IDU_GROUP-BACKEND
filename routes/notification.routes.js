const express = require('express');
const router = express.Router();
const { getNotifications } = require('../controllers/notification.controller');
const authMiddleware = require('../middleware/auth.middleware');

router.get('/', authMiddleware, getNotifications);

module.exports = router;