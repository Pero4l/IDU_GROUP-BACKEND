const express = require('express');
const router = express.Router();

const { register, login, searchUsers, forgotPassword, confirmOtp, resetPassword, googleAuth } = require('../controllers/users.controller');
const { loginMiddleware } = require('../middleware/loginMiddleware');
const { authMiddleware } = require('../middleware/authUserMiddleware');

router.post('/register', register);
router.post('/login', loginMiddleware, login);
router.post('/google-auth', googleAuth);
router.get('/', authMiddleware, searchUsers);
router.post('/forgot-password', forgotPassword);
router.post('/confirm-otp', confirmOtp);
router.post('/reset-password', resetPassword);

module.exports = router;