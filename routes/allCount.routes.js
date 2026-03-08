const express = require("express");
const router = express.Router();
const { getAllCount } = require("../controller/allCount.controller");

router.get("/", getAllCount);

module.exports = router;