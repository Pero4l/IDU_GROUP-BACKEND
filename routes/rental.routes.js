const express = require('express');
const router = express.Router();

const { authMiddleware } = require('../middleware/authUserMiddleware');
const { addRental, seeAllRentals, getRental, updateRental, deleteRental } = require('../controllers/rental.controller');

router.post('/post', authMiddleware, addRental);
router.get('/seeallrentals', authMiddleware, seeAllRentals);
router.get('/seesinglerentals/:id', authMiddleware, getRental);
router.put('/updaterentals/:id', authMiddleware, updateRental);
router.delete('/deleterentals/:id', authMiddleware, deleteRental);

module.exports = router;