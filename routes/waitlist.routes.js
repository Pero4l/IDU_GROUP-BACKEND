const express = require('express');
const router = express.Router();
const { addToWaitlist } = require('../controllers/waitlist.controller');
const { waitlistLimiter } = require('../middleware/rateLimiter');

// Public (no auth) and sends an email, so it's rate limited (10/hour per IP).
router.post('/', waitlistLimiter, addToWaitlist);

module.exports = router;
