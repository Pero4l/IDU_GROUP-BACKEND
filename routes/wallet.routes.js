const express = require("express");
const router = express.Router();
const {
  getWallet,
  getWalletTransactions,
  initializeTopUp,
  verifyTopUpCallback,
  withdraw,
  transferToUser,
  handleWebhook,
} = require("../controllers/wallet.controller");
const { authMiddleware } = require("../middleware/authUserMiddleware");

router.get("/", authMiddleware, getWallet);
router.get("/transactions", authMiddleware, getWalletTransactions);
router.post("/topup/initialize", authMiddleware, initializeTopUp);
router.get("/topup/verify-callback", verifyTopUpCallback);
router.post("/withdraw", authMiddleware, withdraw);
router.post("/transfer", authMiddleware, transferToUser);
router.post("/webhook", handleWebhook);

module.exports = router;
