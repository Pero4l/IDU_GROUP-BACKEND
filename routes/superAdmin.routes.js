const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../middleware/authUserMiddleware');
const { requireSuperAdmin } = require('../middleware/superAdminMiddleware');
const {
  getAllUsers, toggleUserStatus, deleteUser,
  getAllRentals, deleteRental, getLockedHouses,
  getAllReports, updateReportStatus,
  getAllConversations, getConversationMessages,
  getAnalytics, suspendUser, unsuspendUser,
  getWaitlist, getOutboundIp,
  updateLandlordCommission
} = require('../controllers/superAdmin.controller');
const {
  createCoupon, listCoupons, getCoupon, updateCoupon, deleteCoupon
} = require('../controllers/coupon.controller');


// Protected Admin Endpoints
router.get('/analytics', authMiddleware, requireSuperAdmin, getAnalytics);
router.get('/users', authMiddleware, requireSuperAdmin, getAllUsers);
router.put('/users/:id/status', authMiddleware, requireSuperAdmin, toggleUserStatus);
router.put('/users/:id/suspend', authMiddleware, requireSuperAdmin, suspendUser);
router.put('/users/:id/unsuspend', authMiddleware, requireSuperAdmin, unsuspendUser);
router.put('/users/:id/commission', authMiddleware, requireSuperAdmin, updateLandlordCommission);
router.delete('/users/:id', authMiddleware, requireSuperAdmin, deleteUser);

// Rentals Oversight
router.get('/rentals', authMiddleware, requireSuperAdmin, getAllRentals);
router.delete('/rentals/:id', authMiddleware, requireSuperAdmin, deleteRental);

// Progress oversight (locked houses)
router.get('/rentals/locked', authMiddleware, requireSuperAdmin, getLockedHouses);

// Reports oversight
router.get('/reports', authMiddleware, requireSuperAdmin, getAllReports);
router.put('/reports/:id/status', authMiddleware, requireSuperAdmin, updateReportStatus);

// Chat oversight
router.get('/chats', authMiddleware, requireSuperAdmin, getAllConversations);
router.get('/chats/:id/messages', authMiddleware, requireSuperAdmin, getConversationMessages);

// Waitlist oversight
router.get('/waitlist', authMiddleware, requireSuperAdmin, getWaitlist);

// Diagnostics — outbound IP for whitelisting with payment providers (e.g. Flutterwave transfers)
router.get('/outbound-ip', authMiddleware, requireSuperAdmin, getOutboundIp);

// Coupons — only admins can create/manage them; users redeem via POST /wallet/coupons/redeem
router.post('/coupons', authMiddleware, requireSuperAdmin, createCoupon);
router.get('/coupons', authMiddleware, requireSuperAdmin, listCoupons);
router.get('/coupons/:id', authMiddleware, requireSuperAdmin, getCoupon);
router.patch('/coupons/:id', authMiddleware, requireSuperAdmin, updateCoupon);
router.put('/coupons/:id', authMiddleware, requireSuperAdmin, updateCoupon);
router.delete('/coupons/:id', authMiddleware, requireSuperAdmin, deleteCoupon);

module.exports = router;
