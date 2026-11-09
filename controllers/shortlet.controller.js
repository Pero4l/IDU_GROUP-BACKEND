const { Shortlets, Users, Profile } = require("../models");
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

// Allowed enum values — mirror models/shortlets.js. Validating up front gives
// the client a 400 instead of a DB enum error surfacing as a 500.
const ENUMS = {
  rentalModel: ['entire_place', 'private_room', 'shared_room', 'hotel'],
  propertyType: ['apartment', 'house', 'villa', 'studio', 'condo', 'townhouse', 'bungalow', 'loft'],
  furnishingStatus: ['unfurnished', 'semi_furnished', 'fully_furnished'],
  status: ['available', 'rented', 'pending', 'locked'],
};

function validateEnums(values) {
  for (const [field, allowed] of Object.entries(ENUMS)) {
    const value = values[field];
    if (value !== undefined && value !== null && value !== '' && !allowed.includes(value)) {
      return `${field} must be one of: ${allowed.join(', ')}`;
    }
  }
  return null;
}

function isValidTime(value) {
  if (value === undefined || value === null || value === '') return true;
  return /^([01]?\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/.test(String(value));
}

function parsePagination(limit, offset) {
  const l = parseInt(limit, 10);
  const o = parseInt(offset, 10);
  return {
    limit: Number.isInteger(l) && l > 0 ? Math.min(l, 100) : null,
    offset: Number.isInteger(o) && o >= 0 ? o : null,
  };
}

// Builds the shared filter used by /all and /search.
function buildFilters(query) {
  const {
    location, city, area, propertyType, rentalModel, furnishingStatus, status,
    minPrice, maxPrice, guestCapacity, bedrooms,
  } = query;

  const where = {};

  if (location) {
    const like = { [Op.iLike]: `%${location}%` };
    where[Op.or] = [{ city: like }, { area: like }, { address: like }, { landmark: like }];
  }
  if (city) where.city = { [Op.iLike]: `%${city}%` };
  if (area) where.area = { [Op.iLike]: `%${area}%` };
  if (propertyType) where.propertyType = propertyType;
  if (rentalModel) where.rentalModel = rentalModel;
  if (furnishingStatus) where.furnishingStatus = furnishingStatus;
  if (status) where.status = status;

  const min = parseFloat(minPrice);
  const max = parseFloat(maxPrice);
  if (!isNaN(min) || !isNaN(max)) {
    where.pricePerNight = {};
    if (!isNaN(min)) where.pricePerNight[Op.gte] = min;
    if (!isNaN(max)) where.pricePerNight[Op.lte] = max;
  }

  // "Sleeps at least N" is what users mean when filtering on guests
  const guests = parseInt(guestCapacity, 10);
  if (!isNaN(guests)) where.guestCapacity = { [Op.gte]: guests };
  const beds = parseInt(bedrooms, 10);
  if (!isNaN(beds)) where.bedrooms = beds;

  return where;
}

const LIST_ATTRIBUTES = [
  "id", "slug", "rentalModel", "propertyType", "title", "description",
  "bedrooms", "bathrooms", "livingRooms", "guestCapacity", "furnishingStatus",
  "address", "city", "area", "landmark", "amenities", "images", "videos", "coverImage",
  "pricePerNight", "cleaningFee", "securityDeposit", "minimumStay", "maximumStay",
  "availableFrom", "availableTo", "checkInTime", "checkOutTime",
  "smokingAllowed", "petsAllowed", "partiesAllowed", "houseRules", "status", "UserId", "createdAt"
];

const OWNER_INCLUDE = [{
  model: Users,
  attributes: ["id", "full_name", "phone_no"],
  include: [{ model: Profile, attributes: ['image', 'verified'] }]
}];

// Accepts either a UUID or a slug. Querying a UUID column with a non-UUID
// string makes Postgres throw, which previously surfaced as a 500.
function findShortletByIdOrSlug(id, options = {}) {
  return isUUID(id)
    ? Shortlets.findByPk(id, options)
    : Shortlets.findOne({ ...options, where: { slug: id } });
}

async function isSuperAdmin(userId) {
  if (!userId) return false;
  const user = await Users.findByPk(userId, { attributes: ['id', 'is_superadmin'] });
  return user?.is_superadmin === true;
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

    const enumError = validateEnums({ rentalModel, propertyType, furnishingStatus, status });
    if (enumError) return res.status(400).json({ success: false, message: enumError });

    if (!isValidTime(checkInTime) || !isValidTime(checkOutTime)) {
      return res.status(400).json({ success: false, message: "checkInTime and checkOutTime must be in HH:MM format" });
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

    if (uploadedImagesList.length === 0) {
      return res.status(400).json({ success: false, message: "At least one image is required" });
    }
    // Same media rules as rentals: up to 10 images alone, or 4 images + 2 videos together
    if (uploadedVideosList.length === 0 && uploadedImagesList.length > 10) {
      return res.status(400).json({ success: false, message: "Max 10 images allowed" });
    }
    if (uploadedVideosList.length > 0 && (uploadedImagesList.length > 4 || uploadedVideosList.length > 2)) {
      return res.status(400).json({ success: false, message: "When uploading both, max is 4 images + 2 videos" });
    }

    const amenitiesData = parseJsonArray(amenities);

    // Upload to Cloudinary before the DB write — Cloudinary is external and
    // not transactional. If the upload fails we never touch the DB.
    const uploadedImages = await Promise.all(
      uploadedImagesList.map((img) => uploadBufferToCloudinary(img.buffer, img.mimetype, "shortlets/images"))
    );
    const uploadedVideos = await Promise.all(
      uploadedVideosList.map((vid) => uploadBufferToCloudinary(vid.buffer, vid.mimetype, "shortlets/videos"))
    );
    const imageUrls = uploadedImages.map((i) => i.secure_url);

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
      area: area || '',
      landmark,
      amenities: amenitiesData,
      images: imageUrls,
      videos: uploadedVideos.map((v) => v.secure_url),
      // Only accept a cover that is one of the uploaded images
      coverImage: imageUrls.includes(coverImage) ? coverImage : imageUrls[0],
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

    return res.status(201).json({ success: true, data: shortlet, message: "Short let property added successfully" });
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
    const { limit, offset } = parsePagination(req.query.limit, req.query.offset);
    const where = buildFilters(req.query);

    const queryOptions = {
      where,
      attributes: LIST_ATTRIBUTES,
      include: OWNER_INCLUDE,
      order: [['createdAt', 'DESC']],
      distinct: true, // keep count correct with the include
    };
    if (limit !== null) queryOptions.limit = limit;
    if (offset !== null) queryOptions.offset = offset;

    const { count, rows } = await Shortlets.findAndCountAll(queryOptions);

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
    const { limit } = parsePagination(req.query.limit);

    const shortlets = await Shortlets.findAll({
      attributes: LIST_ATTRIBUTES,
      include: OWNER_INCLUDE,
      order: [['createdAt', 'DESC']],
      limit: limit ?? 10,
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

    const shortlet = await findShortletByIdOrSlug(id, {
      attributes: [...LIST_ATTRIBUTES, "updatedAt"],
      include: OWNER_INCLUDE,
    });

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

    const shortlet = await findShortletByIdOrSlug(id);
    if (!shortlet) {
      return res.status(404).json({ success: false, message: "Short let not found" });
    }
    if (shortlet.UserId !== req.user.userId || req.user.role !== 'landlord') {
      return res.status(403).json({ success: false, message: "You are not authorized to update this short let" });
    }

    const enumError = validateEnums({ rentalModel, propertyType, furnishingStatus, status });
    if (enumError) return res.status(400).json({ success: false, message: enumError });

    if (!isValidTime(checkInTime) || !isValidTime(checkOutTime)) {
      return res.status(400).json({ success: false, message: "checkInTime and checkOutTime must be in HH:MM format" });
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
      status: status || shortlet.status,
    };

    // A shortlet must always keep at least one image (model: images NOT NULL, required on create)
    if (updateData.images.length === 0) {
      return res.status(400).json({ success: false, message: "At least one image is required" });
    }
    // Cover must be one of the listing's images; fall back to the first image
    const requestedCover = coverImage !== undefined ? coverImage : shortlet.coverImage;
    updateData.coverImage = updateData.images.includes(requestedCover) ? requestedCover : updateData.images[0];

    // Availability dates are only updatable when the new window is valid
    if (availableFrom || availableTo) {
      const nextFrom = availableFrom ? new Date(`${availableFrom}`) : new Date(`${shortlet.availableFrom}`);
      const nextTo = availableTo ? new Date(`${availableTo}`) : new Date(`${shortlet.availableTo}`);
      if (isNaN(nextFrom.getTime()) || isNaN(nextTo.getTime())) {
        return res.status(400).json({ success: false, message: "availableFrom and availableTo must be valid dates" });
      }
      if (nextTo < nextFrom) {
        return res.status(400).json({ success: false, message: "availableTo cannot be earlier than availableFrom" });
      }
      updateData.availableFrom = availableFrom || shortlet.availableFrom;
      updateData.availableTo = availableTo || shortlet.availableTo;
    }

    await shortlet.update(updateData);

    const updatedShortlet = await Shortlets.findByPk(shortlet.id, {
      attributes: [...LIST_ATTRIBUTES, "updatedAt"],
      include: OWNER_INCLUDE,
    });

    logger.info('Shortlet updated', { shortletId: shortlet.id, userId: req.user.userId });

    const landlord = await Users.findByPk(req.user.userId, { attributes: ['id', 'email', 'full_name'] });
    await logAndEmailUser(req.user.userId, landlord?.email, "Shortlet Updated", `Your short let "${updatedShortlet.title}" has been updated.`);
    await notifySuperAdmins(`Short let "${updatedShortlet.title}" was updated by ${landlord?.full_name ?? req.user.userId}`, "shortlet");

    return res.status(200).json({ success: true, data: updatedShortlet, message: "Short let updated successfully" });
  } catch (error) {
    logger.error('Error updating shortlet', { error: error.message, userId: req.user?.userId });
    return res.status(500).json({ success: false, message: "Server error" });
  }
}

// ─────────────────────────────────────────────
// DELETE /shortlet/delete/:id       — owner (landlord) or super admin
// DELETE /admin/shortlets/:id       — super admin
// ─────────────────────────────────────────────
async function deleteShortlet(req, res) {
  try {
    const { id } = req.params;
    const requesterId = req.user.userId;

    const shortlet = await findShortletByIdOrSlug(id);
    if (!shortlet) {
      return res.status(404).json({ success: false, message: "Short let not found" });
    }

    const isOwner = shortlet.UserId === requesterId && req.user.role === 'landlord';
    const isAdmin = req.adminUser?.is_superadmin === true || (!isOwner && await isSuperAdmin(requesterId));
    if (!isOwner && !isAdmin) {
      return res.status(403).json({ success: false, message: "You are not authorized to delete this short let" });
    }

    const shortletId = shortlet.id;
    const shortletTitle = shortlet.title;
    const ownerId = shortlet.UserId;

    await withTransaction(async (t) => {
      await shortlet.destroy({ transaction: t });
    }, { context: 'deleteShortlet', shortletId, userId: requesterId, byAdmin: !isOwner });

    logger.info('Shortlet deleted', { shortletId, ownerId, deletedBy: requesterId, byAdmin: !isOwner });

    // Non-critical side-effects — always notify the actual owner, not the requester
    const owner = await Users.findByPk(ownerId, { attributes: ['id', 'email', 'full_name'] });
    if (isOwner) {
      await logAndEmailUser(ownerId, owner?.email, "Shortlet Deleted", `Your short let "${shortletTitle}" has been deleted.`);
      await notifySuperAdmins(`Short let "${shortletTitle}" was deleted by ${owner?.full_name ?? ownerId}`, "shortlet");
    } else {
      await logAndEmailUser(ownerId, owner?.email, "Shortlet Removed", `Your short let "${shortletTitle}" was removed by an administrator.`);
      await notifySuperAdmins(`Short let "${shortletTitle}" (owner: ${owner?.full_name ?? ownerId}) was deleted by an admin`, "shortlet");
    }

    return res.status(200).json({ success: true, message: "Short let deleted successfully" });
  } catch (error) {
    logger.error('Error deleting shortlet', { error: error.message, userId: req.user?.userId });
    return res.status(500).json({ success: false, message: "Server error" });
  }
}

// ─────────────────────────────────────────────
// GET /admin/shortlets  — super admin oversight
// ─────────────────────────────────────────────
async function adminGetAllShortlets(req, res) {
  try {
    const shortlets = await Shortlets.findAll({
      include: [{ model: Users, attributes: ['id', 'full_name', 'email'] }],
      order: [['createdAt', 'DESC']],
    });
    return res.status(200).json({ success: true, count: shortlets.length, data: shortlets });
  } catch (error) {
    logger.error('Super Admin - getAllShortlets error', { error: error.message });
    return res.status(500).json({ success: false, message: "Server error" });
  }
}

// ─────────────────────────────────────────────
// GET /shortlet/search
// ─────────────────────────────────────────────
async function searchShortlets(req, res) {
  try {
    const shortlets = await Shortlets.findAll({
      where: buildFilters(req.query),
      attributes: LIST_ATTRIBUTES,
      include: OWNER_INCLUDE,
      order: [['createdAt', 'DESC']],
    });

    return res.status(200).json({ success: true, count: shortlets.length, data: shortlets, message: "Shortlets fetched successfully" });
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
  adminGetAllShortlets,
};
