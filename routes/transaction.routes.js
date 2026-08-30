const express = require("express");
const router = express.Router();
const {
  getTransactionStats,
  getAllTransactions,
  getTransaction,
} = require("../controllers/transaction.controller");
const { authMiddleware } = require("../middleware/authUserMiddleware");
const { requireSuperAdmin } = require("../middleware/superAdminMiddleware");

router.get("/stats", authMiddleware, requireSuperAdmin, getTransactionStats);
router.get("/", authMiddleware, requireSuperAdmin, getAllTransactions);
router.get("/:id", authMiddleware, requireSuperAdmin, getTransaction);

module.exports = router;
