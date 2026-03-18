const express = require('express');
const router = express.Router();

const { authMiddleware } = require('../middleware/authUserMiddleware');
const { addRental, seeAllRentals, getRental, updateRental, deleteRental } = require('../controllers/rental.controller');

router.post('/post', authMiddleware, addRental);
router.get('/all', authMiddleware, seeAllRentals);
router.get('/get1/:id', authMiddleware, getRental);
router.put('/update/:id', authMiddleware, updateRental);
router.delete('/delete/:id', authMiddleware, deleteRental);

module.exports = router;