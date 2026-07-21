const express = require("express");
const router = express.Router();
const {
  register,
  verifyRegistration,
  login,
  searchUsers,
  forgotPassword,
  confirmOtp,
  resetPassword,
  googleAuth,
  getMe,
  logout,
  registerAdmin,
  verifyAdmin,
} = require("../controllers/users.controller");
const { loginMiddleware } = require("../middleware/loginMiddleware");
const { authMiddleware } = require("../middleware/authUserMiddleware");
const { loginLimiter, otpLimiter, otpRequestLimiter } = require("../middleware/rateLimiter");

router.post("/register", otpRequestLimiter, register);
router.post("/verify-registration", otpLimiter, verifyRegistration);
router.post("/register-admin", authMiddleware, otpRequestLimiter, registerAdmin);
router.post("/verify-admin", otpLimiter, verifyAdmin);
router.post("/login", loginLimiter, loginMiddleware, login);
router.post("/google-auth", googleAuth);
router.get("/", authMiddleware, searchUsers);
router.post("/forgot-password", otpRequestLimiter, forgotPassword);
router.post("/confirm-otp", otpLimiter, confirmOtp);
router.post("/reset-password", otpLimiter, resetPassword);

router.get("/me", getMe);
router.post("/logout", logout);

module.exports = router;
