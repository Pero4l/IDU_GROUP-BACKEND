const express = require('express');
const router = express.Router();

const { authMiddleware } = require('../middleware/authUserMiddleware');
const { createPin, updatePin } = require('../controllers/pin.controller');


router.post('/create', authMiddleware, createPin);
router.put('/update', authMiddleware, updatePin);

module.exports = router;