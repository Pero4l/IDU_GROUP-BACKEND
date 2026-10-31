const { Shortlets, Users, Notifications, Profile } = require("../models");
const { notifySuperAdmins, logAndEmailUser } = require('./notification.controller');
const { withTransaction } = require('../utils/rollback');
const logger = require('../utils/logger');
const { Op } = require('sequelize');
const cloudinary = require("cloudinary").v2;
const { v4: uuidv4 } = require("uuid");
require("dotenv").config();

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure: true
});

// Upload from buffer (memoryStorage)
function uploadBufferToCloudinary(buffer, mimetype, folder) {
  return new Promise((resolve, reject) => {
    const type = mimetype.startsWith("video") ? "video" : "image";
    const stream = cloudinary.uploader.upload_stream(
      { folder, resource_type: type, public_id: uuidv4() },
      (error, result) => {
        if (error) {
          logger.error('Cloudinary upload error', { error: error.message, folder });
          reject(error);
        } else {
          resolve(result);
        }
      }
    );
    stream.end(buffer);
  });
}

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

function parseJsonArray(value) {
  if (value === undefined || value === null) return [];
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
}

function toNumber(value, fallback = 0) {
  const n = parseFloat(value);
  return isNaN(n) ? fallback : n;
}

function toInt(value, fallback = 0) {
  const n = parseInt(value, 10);
  return isNaN(n) ? fallback : n;
}

function toBoolean(value, fallback = false) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'boolean') return value;
  return ['true', '1', 'yes'].includes(String(value).toLowerCase());
}

function normalizeTime(value, fallback = '14:00:00') {
  if (value === undefined || value === null || value === '') return fallback;
  const parts = String(value).split(':');
  const hours = String(parts[0] || '0').padStart(2, '0');
  const minutes = String(parts[1] || '0').padStart(2, '0');
  const seconds = String(parts[2] || '0').padStart(2, '0');
  return `${hours}:${minutes}:${seconds}`;
}

function isUUID(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

// ─────────────────────────────────────────────
// POST /shortlet/post  — landlord adds a short let
// ─────────────────────────────────────────────
async function addShortlet(req, res) {
  try {
    const {
      rentalModel, propertyType, title, description, bedrooms, bathrooms, livingRooms,
      guestCapacity, furnishingStatus, address, city, area, landmark,
      amenities, images, videos, coverImage,
      pricePerNight, cleaningFee, securityDeposit, minimumStay, maximumStay,
      availableFrom, availableTo, checkInTime, checkOutTime,
      smokingAllowed, petsAllowed, partiesAllowed, houseRules, status,
    } = req.body;

    if (!title || !description || !propertyType || !rentalModel || !pricePerNight ||
        !address || !city || !availableFrom || !availableTo) {
      return res.status(400).json({
        success: false,
        message: "title, description, propertyType, rentalModel, pricePerNight, address, city, availableFrom and availableTo are required",
      });
    }

    if (req.user.role !== 'landlord') {
      return res.status(403).json({ success: false, message: "Only landlords can add shortlets" });
    }

    const parsedPricePerNight = toNumber(pricePerNight);
    if (parsedPricePerNight <= 0) {
      return res.status(400).json({ success: false, message: "pricePerNight must be a positive number" });
    }

    const parsedAvailableFrom = new Date(`${availableFrom}`);
    const parsedAvailableTo = new Date(`${availableTo}`);
    if (isNaN(parsedAvailableFrom.getTime()) || isNaN(parsedAvailableTo.getTime())) {
      return res.status(400).json({ success: false, message: "availableFrom and availableTo must be valid dates" });
    }
    if (parsedAvailableTo < parsedAvailableFrom) {
      return res.status(400).json({ success: false, message: "availableTo cannot be earlier than availableFrom" });
    }

    const parsedMinimumStay = toInt(minimumStay, 1) || 1;
    const parsedMaximumStay = toInt(maximumStay, 30) || 30;
    if (parsedMaximumStay < parsedMinimumStay) {
      return res.status(400).json({ success: false, message: "maximumStay cannot be less than minimumStay" });
    }

    const uploadedImagesList = req.files?.images || [];
    const uploadedVideosList = req.files?.videos || [];

    if (!uploadedImagesList || uploadedImagesList.length === 0) {
      return res.status(400).json({ success: false, message: "At least one image is required" });
    }
    if (uploadedImagesList.length > 10) return res.status(400).json({ success: false, message: "Max 10 images allowed" });
    if (uploadedVideosList.length > 4) return res.status(400).json({ success: false, message: "Max 4 videos allowed" });
    if (uploadedImagesList.length > 4 || uploadedVideosList.length > 2) {
      return res.status(400).json({ success: false, message: "When uploading both, max is 4 images + 2 videos" });
    }

    let amenitiesData = parseJsonArray(amenities);

    // Upload to Cloudinary BEFORE the transaction — Cloudinary is external,
    // not transactional. If the upload fails we never touch the DB.
    const uploadedImages = await Promise.all(
      uploadedImagesList.map((img) => uploadBufferToCloudinary(img.buffer, img.mimetype, "shortlets/images"))
    );
    const uploadedVideos = await Promise.all(
      uploadedVideosList.map((vid) =>
        new Promise((resolve, reject) => {
          const stream = cloudinary.uploader.upload_stream(
            { folder: "shortlets/videos", resource_type: "video", public_id: uuidv4() },
            (error, result) => {
              if (error) { logger.error('Video upload error', { error: error.message }); reject(error); }
              else resolve(result);
            }
          );
          stream.end(vid.buffer);
        })
      )
    );

    // Single DB write
    const shortlet = await Shortlets.create({
      rentalModel,
      propertyType,
      title,
      description,
      bedrooms: toInt(bedrooms, 0),
      bathrooms: toInt(bathrooms, 0),
      livingRooms: toInt(livingRooms, 0),
      guestCapacity: toInt(guestCapacity, 1),
      furnishingStatus: furnishingStatus || 'unfurnished',
      address,
      city,
      area,
      landmark,
      amenities: amenitiesData,
      images: uploadedImages.map((i) => i.secure_url),
      videos: uploadedVideos.map((v) => v.secure_url),
      coverImage: coverImage || uploadedImages[0].secure_url,
      pricePerNight: parsedPricePerNight,
      cleaningFee: toNumber(cleaningFee),
      securityDeposit: toNumber(securityDeposit),
      minimumStay: parsedMinimumStay,
      maximumStay: parsedMaximumStay,
      availableFrom,
      availableTo,
      checkInTime: normalizeTime(checkInTime),
      checkOutTime: normalizeTime(checkOutTime, '11:00:00'),
      smokingAllowed: toBoolean(smokingAllowed),
      petsAllowed: toBoolean(petsAllowed),
      partiesAllowed: toBoolean(partiesAllowed),
      houseRules,
      status: status || 'available',
      UserId: req.user.userId,
    });

    logger.info('Shortlet created', { shortletId: shortlet.id, userId: req.user.userId });

    const landlord = await Users.findByPk(req.user.userId);
    await logAndEmailUser(req.user.userId, landlord?.email, "Shortlet Added", `Your short let "${title}" has been added successfully.`);
    await notifySuperAdmins(`New shortlet posted by ${landlord?.full_name ?? req.user.userId}: ${title}`, "shortlet");

    return res.status(201).json({ success: true, message: "Short let property added successfully" });
  } catch (err) {
    logger.error('Error adding shortlet', { error: err.message, userId: req.user?.userId });
    return res.status(500).json({ success: false, message: "Error adding shortlet" });
  }
}

// ─────────────────────────────────────────────
// GET /shortlet/all
// ─────────────────────────────────────────────
async function seeAllShortlets(req, res) {
  try {
    const {
      city, area, propertyType, rentalModel, furnishingStatus, status,
      minPrice, maxPrice, guestCapacity, bedrooms, limit, offset,
    } = req.query;

    const parsedLimit = limit ? parseInt(limit, 10) : null;
    const parsedOffset = offset ? parseInt(offset, 10) : null;

    const where = {};

    if (city) where.city = { [Op.iLike]: `%${city}%` };
    if (area) where.area = { [Op.iLike]: `%${area}%` };
    if (propertyType) where.propertyType = propertyType;
    if (rentalModel) where.rentalModel = rentalModel;
    if (furnishingStatus) where.furnishingStatus = furnishingStatus;
    if (status) where.status = status;
    if (minPrice) where.pricePerNight = { [Op.gte]: parseFloat(minPrice) };
    if (maxPrice) where.pricePerNight = { [Op.lte]: parseFloat(maxPrice) };
    if (guestCapacity) where.guestCapacity = parseInt(guestCapacity, 10);
    if (bedrooms) where.bedrooms = parseInt(bedrooms, 10);

    const queryOptions = {
      attributes: [
        "id", "slug", "rentalModel", "propertyType", "title", "description",
        "bedrooms", "bathrooms", "livingRooms", "guestCapacity", "furnishingStatus",
        "address", "city", "area", "landmark", "amenities", "images", "videos", "coverImage",
        "pricePerNight", "cleaningFee", "securityDeposit", "minimumStay", "maximumStay",
        "availableFrom", "availableTo", "checkInTime", "checkOutTime",
        "smokingAllowed", "petsAllowed", "partiesAllowed", "houseRules", "status", "UserId", "createdAt"
      ],
      include: [{
        model: Users,
        attributes: ["id", "full_name", "phone_no"],
        include: [{ model: Profile, attributes: ['image', 'verified'] }]
      }],
      order: [['createdAt', 'DESC']],
    };

    if (Object.keys(where).length > 0) queryOptions.where = where;
    if (parsedLimit !== null) queryOptions.limit = parsedLimit;
    if (parsedOffset !== null) queryOptions.offset = parsedOffset;

    let result;
    if (parsedLimit !== null) {
      result = await Shortlets.findAndCountAll(queryOptions);
    } else {
      const rows = await Shortlets.findAll(queryOptions);
      result = { count: rows.length, rows };
    }

    const { count, rows } = result;

    if (count === 0) {
      return res.status(404).json({ success: false, message: "No shortlets found" });
    }

    return res.status(200).json({ success: true, count, data: rows, message: "Shortlets retrieved successfully" });
  } catch (error) {
    logger.error('Error fetching all shortlets', { error: error.message });
    return res.status(500).json({ success: false, message: "Server error" });
  }
}

// ─────────────────────────────────────────────
// GET /shortlet/recent  — most recent shortlets (public)
// ─────────────────────────────────────────────
async function seeRecentShortlets(req, res) {
  try {
    const { limit } = req.query;
    const parsedLimit = limit ? parseInt(limit, 10) : 10;

    const shortlets = await Shortlets.findAll({
      attributes: [
        "id", "slug", "rentalModel", "propertyType", "title", "description",
        "bedrooms", "bathrooms", "livingRooms", "guestCapacity", "furnishingStatus",
        "address", "city", "area", "landmark", "amenities", "images", "videos", "coverImage",
        "pricePerNight", "cleaningFee", "securityDeposit", "minimumStay", "maximumStay",
        "availableFrom", "availableTo", "checkInTime", "checkOutTime",
        "smokingAllowed", "petsAllowed", "partiesAllowed", "houseRules", "status", "UserId", "createdAt"
      ],
      include: [{
        model: Users,
        attributes: ["id", "full_name", "phone_no"],
        include: [{ model: Profile, attributes: ['image', 'verified'] }]
      }],
      order: [['createdAt', 'DESC']],
      limit: parsedLimit,
    });

    return res.status(200).json({ success: true, data: shortlets, message: "Recent shortlets retrieved successfully" });
  } catch (error) {
    logger.error('Error fetching recent shortlets', { error: error.message });
    return res.status(500).json({ success: false, message: "Server error" });
  }
}

// ─────────────────────────────────────────────
// GET /shortlet/get1/:id
// ─────────────────────────────────────────────
async function getShortlet(req, res) {
  try {
    const { id } = req.params;

    const query = {
      attributes: [
        "id", "slug", "rentalModel", "propertyType", "title", "description",
        "bedrooms", "bathrooms", "livingRooms", "guestCapacity", "furnishingStatus",
        "address", "city", "area", "landmark", "amenities", "images", "videos", "coverImage",
        "pricePerNight", "cleaningFee", "securityDeposit", "minimumStay", "maximumStay",
        "availableFrom", "availableTo", "checkInTime", "checkOutTime",
        "smokingAllowed", "petsAllowed", "partiesAllowed", "houseRules", "status", "UserId", "createdAt", "updatedAt"
      ],
      include: [{
        model: Users,
        attributes: ["id", "full_name", "phone_no"],
        include: [{ model: Profile, attributes: ['image', 'verified'] }]
      }]
    };

    const shortlet = isUUID(id)
      ? await Shortlets.findByPk(id, query)
      : await Shortlets.findOne({ where: { slug: id }, ...query });

    if (!shortlet) {
      return res.status(404).json({ success: false, message: "Short let not found" });
    }

    const shortletData = shortlet.toJSON();
    return res.status(200).json({
      success: true,
      data: {
        ...shortletData,
        images: shortletData.images || [],
        videos: shortletData.videos || [],
        amenities: shortletData.amenities || [],
        landlord: shortletData.User || { full_name: "User" },
      },
      message: "Short let retrieved successfully",
    });
  } catch (error) {
    logger.error('Error fetching shortlet', { error: error.message });
    return res.status(500).json({ success: false, message: "Server error" });
  }
}

// ─────────────────────────────────────────────
// PUT /shortlet/update/:id
// ─────────────────────────────────────────────
async function updateShortlet(req, res) {
  try {
    const { id } = req.params;
    const {
      rentalModel, propertyType, title, description, bedrooms, bathrooms, livingRooms,
      guestCapacity, furnishingStatus, address, city, area, landmark,
      amenities, images, videos, coverImage,
      pricePerNight, cleaningFee, securityDeposit, minimumStay, maximumStay,
      availableFrom, availableTo, checkInTime, checkOutTime,
      smokingAllowed, petsAllowed, partiesAllowed, houseRules, status,
    } = req.body;

    const shortlet = await Shortlets.findByPk(id);
    if (!shortlet) {
      return res.status(404).json({ success: false, message: "Short let not found" });
    }
    if (shortlet.UserId !== req.user.userId || req.user.role !== 'landlord') {
      return res.status(403).json({ success: false, message: "You are not authorized to update this short let" });
    }

    const parsedPricePerNight = pricePerNight !== undefined ? toNumber(pricePerNight) : toNumber(shortlet.pricePerNight);
    const parsedMinimumStay = minimumStay !== undefined ? toInt(minimumStay, 1) || 1 : toInt(shortlet.minimumStay, 1);
    const parsedMaximumStay = maximumStay !== undefined ? toInt(maximumStay, 30) || 30 : toInt(shortlet.maximumStay, 30);

    if (parsedPricePerNight <= 0) {
      return res.status(400).json({ success: false, message: "pricePerNight must be a positive number" });
    }
    if (parsedMaximumStay < parsedMinimumStay) {
      return res.status(400).json({ success: false, message: "maximumStay cannot be less than minimumStay" });
    }

    const updateData = {
      rentalModel: rentalModel || shortlet.rentalModel,
      propertyType: propertyType || shortlet.propertyType,
      title: title || shortlet.title,
      description: description || shortlet.description,
      bedrooms: bedrooms !== undefined ? toInt(bedrooms, 0) : toInt(shortlet.bedrooms, 0),
      bathrooms: bathrooms !== undefined ? toInt(bathrooms, 0) : toInt(shortlet.bathrooms, 0),
      livingRooms: livingRooms !== undefined ? toInt(livingRooms, 0) : toInt(shortlet.livingRooms, 0),
      guestCapacity: guestCapacity !== undefined ? toInt(guestCapacity, 1) : toInt(shortlet.guestCapacity, 1),
      furnishingStatus: furnishingStatus || shortlet.furnishingStatus,
      address: address || shortlet.address,
      city: city || shortlet.city,
      area: area !== undefined ? area : shortlet.area,
      landmark: landmark !== undefined ? landmark : shortlet.landmark,
      amenities: amenities !== undefined ? parseJsonArray(amenities) : shortlet.amenities,
      pricePerNight: parsedPricePerNight,
      cleaningFee: cleaningFee !== undefined ? toNumber(cleaningFee) : toNumber(shortlet.cleaningFee),
      securityDeposit: securityDeposit !== undefined ? toNumber(securityDeposit) : toNumber(shortlet.securityDeposit),
      minimumStay: parsedMinimumStay,
      maximumStay: parsedMaximumStay,
      checkInTime: checkInTime ? normalizeTime(checkInTime) : shortlet.checkInTime,
      checkOutTime: checkOutTime ? normalizeTime(checkOutTime, '11:00:00') : shortlet.checkOutTime,
      smokingAllowed: smokingAllowed !== undefined ? toBoolean(smokingAllowed) : shortlet.smokingAllowed,
      petsAllowed: petsAllowed !== undefined ? toBoolean(petsAllowed) : shortlet.petsAllowed,
      partiesAllowed: partiesAllowed !== undefined ? toBoolean(partiesAllowed) : shortlet.partiesAllowed,
      houseRules: houseRules !== undefined ? houseRules : shortlet.houseRules,
      images: images !== undefined ? parseJsonArray(images) : shortlet.images,
      videos: videos !== undefined ? parseJsonArray(videos) : shortlet.videos,
      coverImage: coverImage !== undefined ? coverImage : shortlet.coverImage,
      status: status || shortlet.status,
    };

    // Availability dates are only updatable when the new window is valid
    if (availableFrom || availableTo) {
      const nextFrom = availableFrom ? new Date(`${availableFrom}`) : new Date(`${shortlet.availableFrom}`);
      const nextTo = availableTo ? new Date(`${availableTo}`) : new Date(`${shortlet.availableTo}`);
      if (isNaN(nextFrom.getTime()) || isNaN(nextTo.getTime()) || nextTo < nextFrom) {
        return res.status(400).json({ success: false, message: "availableTo cannot be earlier than availableFrom" });
      }
      updateData.availableFrom = availableFrom || shortlet.availableFrom;
      updateData.availableTo = availableTo || shortlet.availableTo;
    }

    await shortlet.update(updateData);

    const updatedShortlet = await Shortlets.findByPk(id, {
      include: [{ model: Users, attributes: ["id", "full_name", "email"] }]
    });

    logger.info('Shortlet updated', { shortletId: id, userId: req.user.userId });

    if (updatedShortlet.User) {
      await logAndEmailUser(req.user.userId, updatedShortlet.User.email, "Shortlet Updated", `Your short let "${updatedShortlet.title}" has been updated.`);
    }
    await notifySuperAdmins(`Short let "${updatedShortlet.title}" was updated by ${updatedShortlet.User?.full_name ?? req.user.userId}`, "shortlet");

    return res.status(200).json({ success: true, data: updatedShortlet, message: "Short let updated successfully" });
  } catch (error) {
    logger.error('Error updating shortlet', { error: error.message, userId: req.user?.userId });
    return res.status(500).json({ success: false, message: "Server error" });
  }
}

// ─────────────────────────────────────────────
// DELETE /shortlet/delete/:id
// Wraps destroy + notification in a transaction so if the
// notification DB write fails the shortlet is NOT deleted.
// ─────────────────────────────────────────────
async function deleteShortlet(req, res) {
  try {
    const { id } = req.params;

    const shortlet = await Shortlets.findByPk(id);
    if (!shortlet) {
      return res.status(404).json({ success: false, message: "Short let not found" });
    }
    if (shortlet.UserId !== req.user.userId || (req.user.role !== 'landlord' && req.user.role !== 'agent')) {
      return res.status(403).json({ success: false, message: "You are not authorized to delete this short let" });
    }

    const shortletTitle = shortlet.title;
    const ownerId = req.user.userId;

    // Wrap destroy inside transaction so any follow-up DB write failure
    // rolls the delete back (shortlet stays in DB, user is notified to retry)
    await withTransaction(async (t) => {
      await shortlet.destroy({ transaction: t });
    }, { context: 'deleteShortlet', shortletId: id, userId: ownerId });

    logger.info('Shortlet deleted', { shortletId: id, userId: ownerId });

    // Non-critical side-effects
    const landlord = await Users.findByPk(ownerId);
    await logAndEmailUser(ownerId, landlord?.email, "Shortlet Deleted", `Your short let "${shortletTitle}" has been deleted.`);
    await notifySuperAdmins(`Short let "${shortletTitle}" was deleted by ${landlord?.full_name ?? ownerId}`, "shortlet");

    return res.status(200).json({ success: true, message: "Short let deleted successfully" });
  } catch (error) {
    logger.error('Error deleting shortlet', { error: error.message, userId: req.user?.userId });
    return res.status(500).json({ success: false, message: "Server error", error: error.message });
  }
}

// ─────────────────────────────────────────────
// GET /shortlet/search
// ─────────────────────────────────────────────
async function searchShortlets(req, res) {
  try {
    const { location, city, area, propertyType, rentalModel, furnishingStatus, status, minPrice, maxPrice, guestCapacity, bedrooms } = req.query;

    const where = {};

    if (location) where.city = { [Op.iLike]: `%${location}%` };
    if (city) where.city = { [Op.iLike]: `%${city}%` };
    if (area) where.area = { [Op.iLike]: `%${area}%` };
    if (propertyType) where.propertyType = propertyType;
    if (rentalModel) where.rentalModel = rentalModel;
    if (furnishingStatus) where.furnishingStatus = furnishingStatus;
    if (status) where.status = status;
    if (minPrice) where.pricePerNight = { [Op.gte]: parseFloat(minPrice) };
    if (maxPrice) where.pricePerNight = { [Op.lte]: parseFloat(maxPrice) };
    if (guestCapacity) where.guestCapacity = parseInt(guestCapacity, 10);
    if (bedrooms) where.bedrooms = parseInt(bedrooms, 10);

    const shortlets = await Shortlets.findAll({
      where,
      attributes: [
        "id", "slug", "rentalModel", "propertyType", "title", "description",
        "bedrooms", "bathrooms", "livingRooms", "guestCapacity", "furnishingStatus",
        "address", "city", "area", "landmark", "amenities", "images", "videos", "coverImage",
        "pricePerNight", "cleaningFee", "securityDeposit", "minimumStay", "maximumStay",
        "availableFrom", "availableTo", "checkInTime", "checkOutTime",
        "smokingAllowed", "petsAllowed", "partiesAllowed", "houseRules", "status", "UserId", "createdAt"
      ],
      include: [{
        model: Users,
        attributes: ["id", "full_name", "phone_no"],
        include: [{ model: Profile, attributes: ['image', 'verified'] }]
      }],
      order: [['createdAt', 'DESC']],
    });

    return res.status(200).json({ success: true, data: shortlets, message: "Shortlets fetched successfully" });
  } catch (error) {
    logger.error('Search shortlets error', { error: error.message });
    return res.status(500).json({ success: false, message: "Server error" });
  }
}

module.exports = {
  addShortlet,
  seeAllShortlets,
  seeRecentShortlets,
  getShortlet,
  updateShortlet,
  deleteShortlet,
  searchShortlets,
};
