const express = require("express");
const router = express.Router();
const {
  createTestimonial,
  updateTestimonial,
  deleteTestimonial,
  getAllTestimonials,
  getMyTestimonial,
} = require("../controllers/testimonials.controller");
const { authMiddleware } = require("../middleware/authUserMiddleware");

router.get('/', getAllTestimonials)
router.get('/me', authMiddleware, getMyTestimonial)
router.post("/", authMiddleware, createTestimonial)
router.put('/', authMiddleware, updateTestimonial)
router.delete('/', authMiddleware, deleteTestimonial)

module.exports = router