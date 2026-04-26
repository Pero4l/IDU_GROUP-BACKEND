const express = require('express');
const router = express.Router();

const { authMiddleware } = require('../middleware/authUserMiddleware');
const { getLocationMiddleware } = require('../middleware/getLocationMiddleware');
const { requireProfileCompletion } = require('../middleware/requireProfileCompletion');
const { addRental, seeAllRentals, getRental, updateRental, deleteRental, searchRentals } = require('../controllers/rental.controller');

router.post('/post', authMiddleware, requireProfileCompletion, addRental);
router.get('/all', authMiddleware, requireProfileCompletion, seeAllRentals);
router.get('/get1/:id', authMiddleware, requireProfileCompletion, getRental);
router.put('/update/:id', authMiddleware, requireProfileCompletion, updateRental);
router.delete('/delete/:id', authMiddleware, requireProfileCompletion, deleteRental);
router.get('/search', authMiddleware, getLocationMiddleware, requireProfileCompletion, searchRentals);

module.exports = router;