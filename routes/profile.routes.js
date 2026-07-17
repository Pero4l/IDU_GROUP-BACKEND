const express = require('express');
const router = express.Router();
const multer = require('multer');

const profileFileFilter = (req, file, cb) => {
  const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
  if (allowedTypes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('Invalid file type. Only JPEG, PNG, and WebP images are allowed.'), false);
  }
};

const upload = multer({
  storage: multer.memoryStorage(),
  fileFilter: profileFileFilter,
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB per file
});

const { imageUpload: upload } = require('../middleware/uploadConfig');
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
