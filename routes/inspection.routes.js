const express = require('express');
const router = express.Router();

const { authMiddleware } = require('../middleware/authUserMiddleware');
const {
  createInspection,
  getMyInspections,
  getInspection,
  updateInspection,
  getInspectionsForRental,
} = require('../controllers/inspection.controller');

// Tenant routes
router.post('/create', authMiddleware, createInspection);
router.get('/all', authMiddleware, getMyInspections);
router.get('/:id', authMiddleware, getInspection);
router.put('/update/:id', authMiddleware, updateInspection);

// Landlord route — view all inspections booked for one of their rentals
router.get('/rental/:rental_id', authMiddleware, getInspectionsForRental);

module.exports = router;
