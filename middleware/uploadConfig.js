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

// Shortlet uploads: images + videos, validated per field (same rules as rentals)
const shortletUpload = rentalUpload;

// Deposit claim evidence: 1–5 images in the "photos" field.
const MAX_CLAIM_PHOTOS = 5;
const claimPhotoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_IMAGE_SIZE, files: MAX_CLAIM_PHOTOS },
  fileFilter: (req, file, cb) => {
    if (file.fieldname !== "photos") return cb(new Error('Upload the photos in the "photos" field'));
    if (!ALLOWED_IMAGE_TYPES.includes(file.mimetype)) {
      return cb(new Error("Only JPEG, PNG, WEBP, or AVIF images are allowed"));
    }
    cb(null, true);
  },
}).array("photos", MAX_CLAIM_PHOTOS);

// Wraps it so a bad file is a clean 400 instead of falling through to the
// global error handler as a 500.
function depositClaimPhotos(req, res, next) {
  claimPhotoUpload(req, res, (err) => {
    if (!err) return next();
    let message = err.message;
    if (err.code === "LIMIT_FILE_SIZE") message = "Each photo must be 5MB or smaller";
    if (err.code === "LIMIT_FILE_COUNT" || err.code === "LIMIT_UNEXPECTED_FILE") message = `Attach at most ${MAX_CLAIM_PHOTOS} photos in the "photos" field`;
    return res.status(400).json({ success: false, code: "INVALID_PHOTOS", message });
  });
}

module.exports = { imageUpload, rentalUpload, shortletUpload, depositClaimPhotos };
