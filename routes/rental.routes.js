const express = require('express');
const router = express.Router();
const multer = require('multer');

// Configure multer to store uploaded files in memory as buffer objects
const upload = multer({ storage: multer.memoryStorage() });

const { authMiddleware } = require('../middleware/authUserMiddleware');
const { getLocationMiddleware } = require('../middleware/getLocationMiddleware');
const { requireProfileCompletion } = require('../middleware/requireProfileCompletion');
const { addRental, seeAllRentals, getRental, updateRental, deleteRental, searchRentals, seeRecentRentals, seeRecommendedRentals } = require('../controllers/rental.controller');

// Define expected file fields and max counts for rental images and videos
const rentalUploadFields = upload.fields([
  { name: 'images', maxCount: 6 },
  { name: 'videos', maxCount: 2 }
]);

router.post('/post', authMiddleware, requireProfileCompletion, rentalUploadFields, addRental);
router.get('/all', authMiddleware, requireProfileCompletion, seeAllRentals);
router.get('/recent', seeRecentRentals);
router.get('/recommended', authMiddleware, requireProfileCompletion, seeRecommendedRentals);
router.get('/get1/:id', authMiddleware, requireProfileCompletion, getRental);
router.put('/update/:id', authMiddleware, requireProfileCompletion, updateRental);
router.delete('/delete/:id', authMiddleware, requireProfileCompletion, deleteRental);
router.get('/search', authMiddleware, getLocationMiddleware, requireProfileCompletion, searchRentals);

module.exports = router;