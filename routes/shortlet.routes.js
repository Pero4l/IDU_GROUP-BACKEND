const express = require('express');
const router = express.Router();

const { shortletUpload: upload, depositClaimPhotos } = require('../middleware/uploadConfig');
const { authMiddleware } = require('../middleware/authUserMiddleware');
const { getLocationMiddleware } = require('../middleware/getLocationMiddleware');
const { requireProfileCompletion } = require('../middleware/requireProfileCompletion');
const { isVerifiedMiddleware } = require('../middleware/verificationMiddleware');
const {
  addShortlet, seeAllShortlets, seeRecentShortlets, getShortlet, updateShortlet, deleteShortlet, searchShortlets,
  getShortletAvailability, quoteShortlet, bookShortlet,
  getMyShortletBookings, getHostShortletBookings, getShortletBooking, cancelShortletBooking, claimShortletDeposit,
  getCancellationPreview,
} = require('../controllers/shortlet.controller');

// Field caps match the controller rules (10 images alone, or 4 images + 2 videos).
// The old caps (6 images) made multer reject 7-10 image uploads the controller allows.
const shortletUploadFields = upload.fields([
  { name: 'images', maxCount: 10 },
  { name: 'videos', maxCount: 2 }
]);

router.post('/post', authMiddleware, requireProfileCompletion, shortletUploadFields, addShortlet);
router.get('/all', authMiddleware, requireProfileCompletion, seeAllShortlets);
router.get('/recent', seeRecentShortlets);
router.get('/get1/:id', authMiddleware, requireProfileCompletion, getShortlet);
router.put('/update/:id', authMiddleware, requireProfileCompletion, updateShortlet);
router.delete('/delete/:id', authMiddleware, requireProfileCompletion, deleteShortlet);
// Bookings
router.get('/availability/:id', authMiddleware, getShortletAvailability);  // booked ranges for the date picker
router.get('/quote/:id', authMiddleware, quoteShortlet);                   // price breakdown, no charge
router.post('/book', authMiddleware, isVerifiedMiddleware, bookShortlet);  // charges wallet, requires PIN
router.get('/bookings', authMiddleware, getMyShortletBookings);            // guest's trips
router.get('/host/bookings', authMiddleware, getHostShortletBookings);     // host's reservations
router.get('/bookings/:bookingId', authMiddleware, getShortletBooking);    // guest or host
router.get('/bookings/:bookingId/cancellation', authMiddleware, getCancellationPreview); // cancel dialog: policy + exact refund
router.post('/bookings/:bookingId/cancel', authMiddleware, cancelShortletBooking);          // before check-in, or end a stay early
router.post('/bookings/:bookingId/deposit-claim', authMiddleware, depositClaimPhotos, claimShortletDeposit); // host claims the deposit (multipart, 1–5 photos)

router.get('/search', authMiddleware, getLocationMiddleware, requireProfileCompletion, searchShortlets);

module.exports = router;
