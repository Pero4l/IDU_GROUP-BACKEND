const express = require('express');
const router = express.Router();
const multer = require('multer');

// Configure multer to store uploaded files in memory as buffer objects
const upload = multer({ storage: multer.memoryStorage() });

const { authMiddleware } = require('../middleware/authUserMiddleware');
const { updateProfile, getUserProfile } = require('../controllers/profile.controller');

// Define expected file fields and max counts for profile update
const profileUploadFields = upload.fields([
  { name: 'profileImage', maxCount: 1 },
  { name: 'coverImage', maxCount: 1 }
]);

// Profile endpoints
router.put('/update', authMiddleware, profileUploadFields, updateProfile);
router.get('/get1/:id', authMiddleware, getUserProfile);

module.exports = router;
