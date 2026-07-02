const rateLimit = require("express-rate-limit");

const respondTooManyRequests = (req, res) => {
  res.status(429).json({
    success: false,
    message: "Too many requests. Please try again later.",
  });
};

// Login: guards against password brute-forcing
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  handler: respondTooManyRequests,
});

// OTP verification (registration/admin verify/password reset confirm):
// guards against brute-forcing the 6-digit OTP
const otpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  handler: respondTooManyRequests,
});

// Account creation / OTP issuance: guards against registration and
// forgot-password spam (each triggers an outbound email)
const otpRequestLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  handler: respondTooManyRequests,
});

module.exports = { loginLimiter, otpLimiter, otpRequestLimiter };
