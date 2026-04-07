const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../middleware/authUserMiddleware');
const { requireSuperAdmin } = require('../middleware/superAdminMiddleware');
const { getAllUsers, toggleUserStatus, deleteUser, makeSuperAdmin } = require('../controllers/superAdmin.controller');

// Unprotected endpoint to bootstrap first admin (make sure to secure or remove in production!)
router.put('/users/:id/make-admin', makeSuperAdmin);

// Protected Admin Endpoints
router.get('/users', authMiddleware, requireSuperAdmin, getAllUsers);
router.put('/users/:id/status', authMiddleware, requireSuperAdmin, toggleUserStatus);
router.delete('/users/:id', authMiddleware, requireSuperAdmin, deleteUser);

module.exports = router;
