const express = require("express");
const router = express.Router();
const { subscribe } = require("../controllers/subscriptions.controller");
const { authMiddleware } = require("../middleware/authUserMiddleware");

router.post("/subscribe", authMiddleware, subscribe)

module.exports = router