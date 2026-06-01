const express = require('express');
const router = express.Router();
const { addToWaitlist } = require('../controllers/waitlist.controller');

router.post('/', addToWaitlist);

module.exports = router;
