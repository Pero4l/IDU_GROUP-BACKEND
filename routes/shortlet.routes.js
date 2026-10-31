const express = require('express');
const router = express.Router();

const { shortletUpload: upload } = require('../middleware/uploadConfig');
const { authMiddleware } = require('../middleware/authUserMiddleware');
const { getLocationMiddleware } = require('../middleware/getLocationMiddleware');
const { requireProfileCompletion } = require('../middleware/requireProfileCompletion');
const { addShortlet, seeAllShortlets, seeRecentShortlets, getShortlet, updateShortlet, deleteShortlet, searchShortlets } = require('../controllers/shortlet.controller');

// Define expected file fields and max counts for shortlet images and videos
const shortletUploadFields = upload.fields([
  { name: 'images', maxCount: 6 },
  { name: 'videos', maxCount: 2 }
]);

router.post('/post', authMiddleware, requireProfileCompletion, shortletUploadFields, addShortlet);
router.get('/all', authMiddleware, requireProfileCompletion, seeAllShortlets);
router.get('/recent', seeRecentShortlets);
router.get('/get1/:id', authMiddleware, requireProfileCompletion, getShortlet);
router.put('/update/:id', authMiddleware, requireProfileCompletion, updateShortlet);
router.delete('/delete/:id', authMiddleware, requireProfileCompletion, deleteShortlet);
router.get('/search', authMiddleware, getLocationMiddleware, requireProfileCompletion, searchShortlets);

module.exports = router;
