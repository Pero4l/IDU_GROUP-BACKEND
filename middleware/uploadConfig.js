const multer = require("multer");

const ALLOWED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/avif"];
const ALLOWED_VIDEO_TYPES = ["video/mp4", "video/quicktime", "video/webm"];

const MAX_IMAGE_SIZE = 5 * 1024 * 1024; // 5MB
const MAX_VIDEO_SIZE = 50 * 1024 * 1024; // 50MB

// Profile uploads: images only
const imageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_IMAGE_SIZE },
  fileFilter: (req, file, cb) => {
    if (!ALLOWED_IMAGE_TYPES.includes(file.mimetype)) {
      return cb(new Error("Only JPEG, PNG, WEBP, or AVIF images are allowed"));
    }
    cb(null, true);
  },
});

// Rental uploads: images + videos, validated per field
const rentalUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_VIDEO_SIZE },
  fileFilter: (req, file, cb) => {
    if (file.fieldname === "images") {
      if (!ALLOWED_IMAGE_TYPES.includes(file.mimetype)) {
        return cb(new Error("Only JPEG, PNG, WEBP, or AVIF images are allowed"));
      }
      return cb(null, true);
    }
    if (file.fieldname === "videos") {
      if (!ALLOWED_VIDEO_TYPES.includes(file.mimetype)) {
        return cb(new Error("Only MP4, MOV, or WEBM videos are allowed"));
      }
      return cb(null, true);
    }
    cb(new Error("Unexpected file field"));
  },
});

module.exports = { imageUpload, rentalUpload };
