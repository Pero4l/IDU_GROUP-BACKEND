const express = require('express');
const router = express.Router();

const { register, verifyRegistration, login, searchUsers, forgotPassword, confirmOtp, resetPassword, googleAuth, getMe, logout, registerAdmin, verifyAdmin } = require('../controllers/users.controller');
const { loginMiddleware } = require('../middleware/loginMiddleware');
const { authMiddleware } = require('../middleware/authUserMiddleware');


router.post('/register', register);
router.post('/verify-registration', verifyRegistration);
router.post('/register-admin', registerAdmin);
router.post('/verify-admin', verifyAdmin);
router.post('/login', loginMiddleware, login);
router.post('/google-auth', googleAuth);
router.get('/', authMiddleware, searchUsers);
router.post('/forgot-password', forgotPassword);
router.post('/confirm-otp', confirmOtp);
router.post('/reset-password', resetPassword);

router.get('/me', getMe);
router.post('/logout', logout);

module.exports = router;