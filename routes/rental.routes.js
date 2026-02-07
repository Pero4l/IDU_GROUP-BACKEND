const express = require('express');
const router = express.Router();

const { authMiddleware } = require('../middleware/authUserMiddleware');
const { addRental, seeAllRentals, getRental, updateRental, deleteRental } = require('../controllers/rental.controller');

router.post('/createrentals',  authMiddleware, addRental);
router.post('/seeallrentals', authMiddleware, seeAllRentals);
router.post('/seesinglerentals', authMiddleware, getRental); 
router.post('/updaterentals/:id', authMiddleware, updateRental);
router.post('/deleterentals/:id', authMiddleware, deleteRental); 

module.exports = router;