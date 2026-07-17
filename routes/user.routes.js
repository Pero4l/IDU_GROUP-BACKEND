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
const { authLimiter, otpLimiter, registrationLimiter } = require("../middleware/rateLimiter");

router.post("/register", registrationLimiter, register);
router.post("/verify-registration", registrationLimiter, verifyRegistration);
router.post("/register-admin", authMiddleware, registrationLimiter, registerAdmin);
router.post("/verify-admin", otpLimiter, verifyAdmin);
router.post("/login", authLimiter, loginMiddleware, login);
router.post("/google-auth", authLimiter, googleAuth);
router.get("/", authMiddleware, searchUsers);
router.post("/forgot-password", otpLimiter, forgotPassword);
router.post("/confirm-otp", otpLimiter, confirmOtp);
router.post("/reset-password", otpLimiter, resetPassword);

router.get("/me", getMe);
router.post("/logout", logout);

module.exports = router;
