const express = require("express");
const router = express.Router();
const { getAllCounts } = require("../controllers/allCounts.controller");

router.get("/", getAllCounts);

module.exports = router;