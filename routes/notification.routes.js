const express = require('express');
const router = express.Router();

const { getNotifications, notificationCount } = require('../controllers/notification.controller');
const { authMiddleware } = require('../middleware/authUserMiddleware');


router.get('/', authMiddleware, getNotifications);
router.get('/count', authMiddleware, notificationCount)


module.exports = router;