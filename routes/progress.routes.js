const express = require('express');
const router = express.Router();

const { authMiddleware } = require('../middleware/authUserMiddleware');
const { isVerifiedMiddleware } = require('../middleware/verificationMiddleware');
const {
  likeHouse, getLikedHouses, unlikeHouse, deleteAllLikedHouses,
  initializeLockPayment, verifyLockPayment, verifyLockPaymentCallback, getLockedHouses, deleteLockedHouse, deleteAllLockedHouses,
  bookHouse, getBookedHouses, deleteBookedHouse, deleteAllBookedHouses
} = require('../controllers/progreess.controller');

// Liked endpoints
router.post('/like', authMiddleware, likeHouse);
router.get('/like', authMiddleware, getLikedHouses);
router.delete('/like/:id', authMiddleware, unlikeHouse);
router.delete('/like', authMiddleware, deleteAllLikedHouses);

// Locked endpoints
router.post('/lock/initialize', authMiddleware, isVerifiedMiddleware, initializeLockPayment);
router.post('/lock/verify', authMiddleware, isVerifiedMiddleware, verifyLockPayment);
router.get('/lock/verify-callback', verifyLockPaymentCallback);
router.get('/lock', authMiddleware, getLockedHouses);
router.delete('/lock/:id', authMiddleware, deleteLockedHouse);
router.delete('/lock', authMiddleware, deleteAllLockedHouses);

// Booked endpoints
router.post('/book', authMiddleware, bookHouse);
router.get('/book', authMiddleware, getBookedHouses);
router.delete('/book/:id', authMiddleware, deleteBookedHouse);
router.delete('/book', authMiddleware, deleteAllBookedHouses);

module.exports = router;
