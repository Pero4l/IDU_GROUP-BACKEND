const express = require("express");
const router = express.Router();
const { subscribe } = require("../controllers/subscriptions.controller");
const { authMiddleware } = require("../middleware/authUserMiddleware");
const { writeLimiter } = require("../middleware/rateLimiter");

router.post("/subscribe", authMiddleware, writeLimiter, subscribe);

module.exports = router;
