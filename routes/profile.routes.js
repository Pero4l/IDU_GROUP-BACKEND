const express = require('express');
const router = express.Router();

const { authMiddleware } = require('../middleware/authUserMiddleware');
const { updateProfile, getUserProfile } = require('../controllers/profile.controller');

// Profile endpoints
router.put('/update', authMiddleware, updateProfile);
router.get('/get1/:id',authMiddleware, getUserProfile);

module.exports = router;
