const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../middleware/authUserMiddleware');
const { isVerifiedMiddleware } = require('../middleware/verificationMiddleware');
const { createReport } = require('../controllers/report.controller');

router.post('/', authMiddleware, isVerifiedMiddleware, createReport);

module.exports = router;
