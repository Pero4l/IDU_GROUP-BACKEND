const express = require('express');
const router = express.Router();

const { authMiddleware } = require('../middleware/authUserMiddleware');
const { getLocationMiddleware } = require('../middleware/getLocationMiddleware');
const { addRental, seeAllRentals, getRental, updateRental, deleteRental, searchRentals } = require('../controllers/rental.controller');

router.post('/post', authMiddleware, addRental);
router.get('/all', authMiddleware, seeAllRentals);
router.get('/get1/:id', authMiddleware, getRental);
router.put('/update/:id', authMiddleware, updateRental);
router.delete('/delete/:id', authMiddleware, deleteRental);
router.get('/search', authMiddleware, getLocationMiddleware, searchRentals);

module.exports = router;