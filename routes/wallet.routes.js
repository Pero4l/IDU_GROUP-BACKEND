const express = require("express");
const rateLimit = require("express-rate-limit");
const router = express.Router();
const {
  getWallet,
  getWalletTransactions,
  initializeTopUp,
  verifyTopUpCallback,
  verifyTopUpStatus,
  withdraw,
  transferToUser,
  handleWebhook,
} = require("../controllers/wallet.controller");
const { redeemCoupon } = require("../controllers/coupon.controller");
const { authMiddleware } = require("../middleware/authUserMiddleware");

// Tighter per-user limits on money movement — the global limiter (200/15min
// per IP) is far too loose for endpoints that move funds. The IP fallback
// goes through express-rate-limit's ipKeyGenerator so IPv6 keys are
// normalised (prevents IPv6-based limit bypass).
const byUser = (req) => req.user?.userId || rateLimit.ipKeyGenerator(req);

const withdrawLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  keyGenerator: byUser,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: "Too many withdrawal attempts, please try again later." },
});

const topUpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  keyGenerator: byUser,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: "Too many top-up attempts, please try again later." },
});

const transferLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  keyGenerator: byUser,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: "Too many transfer attempts, please try again later." },
});

// Coupon codes are guessable strings — keep redemption attempts per user low
// so a bot can't brute-force its way to free bonuses.
const couponLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  keyGenerator: byUser,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: "Too many coupon attempts, please try again later." },
});

// Generous burst allowance for Flutterwave's webhook delivery (the global
// limiter is skipped for this path in index.js). Keyed by IP since the
// webhook is unauthenticated — signature verification still gates it.
const webhookLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 500,
  keyGenerator: (req) => rateLimit.ipKeyGenerator(req),
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: "Too many webhook requests." },
});

router.get("/", authMiddleware, getWallet);
router.get("/transactions", authMiddleware, getWalletTransactions);
router.post("/topup/initialize", authMiddleware, topUpLimiter, initializeTopUp);
router.get("/topup/verify-callback", verifyTopUpCallback);
router.get("/topup/verify", authMiddleware, verifyTopUpStatus);
router.get("/topup/verify/:tx_ref", authMiddleware, verifyTopUpStatus);
router.post("/withdraw", authMiddleware, withdrawLimiter, withdraw);
router.post("/transfer", authMiddleware, transferLimiter, transferToUser);
router.post("/coupons/redeem", authMiddleware, couponLimiter, redeemCoupon);
router.post("/webhook", webhookLimiter, handleWebhook);

module.exports = router;
