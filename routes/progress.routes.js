const express = require('express');
const router = express.Router();

const { authMiddleware } = require('../middleware/authUserMiddleware');
const { isVerifiedMiddleware } = require('../middleware/verificationMiddleware');
const {
  likeHouse, getLikedHouses, unlikeHouse, deleteAllLikedHouses,
  lockHouse, getLockedHouses, deleteLockedHouse, deleteAllLockedHouses,
  bookHouse, getBookedHouses, deleteBookedHouse, deleteAllBookedHouses,
  payRent, getRentQuote
} = require('../controllers/progreess.controller');

// Liked endpoints
router.post('/like', authMiddleware, likeHouse);
router.get('/like', authMiddleware, getLikedHouses);
router.delete('/like/:id', authMiddleware, unlikeHouse);
router.delete('/like', authMiddleware, deleteAllLikedHouses);

// Locked endpoints — charges the wallet directly, no gateway redirect
router.post('/lock', authMiddleware, isVerifiedMiddleware, lockHouse);
router.get('/lock', authMiddleware, getLockedHouses);
router.delete('/lock/:id', authMiddleware, deleteLockedHouse);
router.delete('/lock', authMiddleware, deleteAllLockedHouses);

// Booked endpoints
router.post('/book', authMiddleware, bookHouse);
router.get('/book', authMiddleware, getBookedHouses);
router.delete('/book/:id', authMiddleware, deleteBookedHouse);
router.delete('/book', authMiddleware, deleteAllBookedHouses);

// Rent payment — charges the wallet directly, no gateway redirect
// First payment = basic rent + all fees; later payments by the same tenant = basic rent only
router.post('/rent/pay', authMiddleware, isVerifiedMiddleware, payRent);
// What the caller would pay right now (initial vs renewal), before paying
router.get('/rent/quote/:rental_id', authMiddleware, getRentQuote);

module.exports = router;
