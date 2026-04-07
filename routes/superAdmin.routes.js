const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../middleware/authUserMiddleware');
const { requireSuperAdmin } = require('../middleware/superAdminMiddleware');
const { 
  getAllUsers, toggleUserStatus, deleteUser,
  getAllRentals, deleteRental, getLockedHouses,
  getAllReports, updateReportStatus
} = require('../controllers/superAdmin.controller');


// Protected Admin Endpoints
router.get('/users', authMiddleware, requireSuperAdmin, getAllUsers);
router.put('/users/:id/status', authMiddleware, requireSuperAdmin, toggleUserStatus);
router.delete('/users/:id', authMiddleware, requireSuperAdmin, deleteUser);

// Rentals Oversight
router.get('/rentals', authMiddleware, requireSuperAdmin, getAllRentals);
router.delete('/rentals/:id', authMiddleware, requireSuperAdmin, deleteRental);

// Progress oversight (locked houses)
router.get('/rentals/locked', authMiddleware, requireSuperAdmin, getLockedHouses);

// Reports oversight
router.get('/reports', authMiddleware, requireSuperAdmin, getAllReports);
router.put('/reports/:id/status', authMiddleware, requireSuperAdmin, updateReportStatus);

module.exports = router;
