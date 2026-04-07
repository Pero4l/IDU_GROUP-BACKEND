const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../middleware/authUserMiddleware');
const { requireSuperAdmin } = require('../middleware/superAdminMiddleware');
const { 
  getAllUsers, toggleUserStatus, deleteUser, makeSuperAdmin,
  getAllRentals, deleteRental, getLockedHouses,
  getAllReports, updateReportStatus
} = require('../controllers/superAdmin.controller');

// Unprotected endpoint to bootstrap first admin (make sure to secure or remove in production!)
router.put('/users/:id/make-admin', makeSuperAdmin);

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
