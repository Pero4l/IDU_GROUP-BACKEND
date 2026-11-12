const { Shortlets, ShortletBookings, Users, Profile } = require("../models");
const { notifySuperAdmins, logAndEmailUser } = require('./notification.controller');
const { withTransaction } = require('../utils/rollback');
const { chargeMarketplacePayment, InsufficientBalanceError } = require('../utils/wallet');
const { verifyTransactionPin } = require('../utils/pin');
const { toKobo, fromKobo } = require('../utils/money');
const {
  PAYOUT_DELAY_MS, DEPOSIT_CLAIM_WINDOW_MS, POLICY_NAMES, BookingActionError, todayInLagos, checkInAt, checkOutAt,
  describePolicy, getShortletCommissionPercent, splitKobo, cancellationTerms, cancelBooking,
  validateDepositClaim, fileDepositClaim, resolveDepositClaim,
} = require('../utils/shortletSettlement');
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
  cancellationPolicy: POLICY_NAMES, // flexible, moderate, firm, strict
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
  "smokingAllowed", "petsAllowed", "partiesAllowed", "houseRules", "cancellationPolicy", "status", "UserId", "createdAt"
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
      smokingAllowed, petsAllowed, partiesAllowed, houseRules, status, cancellationPolicy,
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

    const enumError = validateEnums({ rentalModel, propertyType, furnishingStatus, status, cancellationPolicy });
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
      cancellationPolicy: cancellationPolicy || 'flexible',
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
      smokingAllowed, petsAllowed, partiesAllowed, houseRules, status, cancellationPolicy,
    } = req.body;

    const shortlet = await findShortletByIdOrSlug(id);
    if (!shortlet) {
      return res.status(404).json({ success: false, message: "Short let not found" });
    }
    if (shortlet.UserId !== req.user.userId || req.user.role !== 'landlord') {
      return res.status(403).json({ success: false, message: "You are not authorized to update this short let" });
    }

    const enumError = validateEnums({ rentalModel, propertyType, furnishingStatus, status, cancellationPolicy });
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
      // Only affects new bookings — each booking keeps the policy it was made under.
      cancellationPolicy: cancellationPolicy || shortlet.cancellationPolicy,
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

      // Don't let the host shrink the window out from under confirmed guests.
      const stranded = await ShortletBookings.findOne({
        where: {
          shortlet_id: shortlet.id,
          status: 'confirmed',
          [Op.or]: [
            { check_in: { [Op.lt]: updateData.availableFrom } },
            { check_out: { [Op.gt]: updateData.availableTo } },
          ],
        },
      });
      if (stranded) {
        return res.status(409).json({
          success: false,
          message: `There is a confirmed booking from ${stranded.check_in} to ${stranded.check_out} outside the new availability dates. Cancel it first or keep those dates available.`,
        });
      }
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

    const upcomingBooking = await ShortletBookings.findOne({
      where: {
        shortlet_id: shortlet.id,
        [Op.or]: [
          { status: 'confirmed', check_out: { [Op.gt]: todayInLagos() } },
          // a guest who ended early but hasn't left yet
          { status: 'cancelled', actual_check_out: { [Op.gt]: todayInLagos() } },
        ],
      },
    });
    if (upcomingBooking) {
      return res.status(409).json({ success: false, message: "This short let has upcoming bookings and cannot be deleted" });
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
// Bookings
// ─────────────────────────────────────────────
// Money flow (held payment, host payout, deposit, cancellation policy) lives
// in utils/shortletSettlement.js — see the header comment there.

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 24 * 60 * 60 * 1000;

// Strict YYYY-MM-DD check that also rejects impossible dates like 2026-02-31.
function isValidDateOnly(value) {
  if (typeof value !== 'string' || !DATE_PATTERN.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

function dateOnlyToUTC(value) {
  return Date.parse(`${value}T00:00:00Z`);
}

// Two stays overlap when one starts before the other ends. check_out is the
// departure day, so a stay ending on the 5th and one starting on the 5th
// do NOT clash (same-day turnover, like Airbnb).
//
// A stay ended early (cancelled during the stay) still blocks the nights up
// to the guest's actual_check_out; the nights after it are free again.
function overlapWhere(shortlet_id, checkIn, checkOut) {
  return {
    shortlet_id,
    check_in: { [Op.lt]: checkOut },
    [Op.or]: [
      { status: 'confirmed', check_out: { [Op.gt]: checkIn } },
      { status: 'cancelled', actual_check_out: { [Op.gt]: checkIn } },
    ],
  };
}

class BookingConflictError extends Error {}

const BOOKING_SHORTLET_ATTRIBUTES = [
  "id", "slug", "title", "address", "city", "area", "coverImage", "images",
  "pricePerNight", "checkInTime", "checkOutTime", "status", "UserId",
];
const PERSON_ATTRIBUTES = ['id', 'full_name', 'phone_no'];

// Validates a requested stay against the listing's rules and prices it.
// Shared by the quote and booking endpoints so they can never disagree.
// Returns { error: { status, message } } or { stay }.
async function evaluateStay(shortlet, user_id, { checkIn, checkOut, guests: rawGuests }) {
  const fail = (status, message, code) => ({ error: { status, message, code } });
  const guests = rawGuests === undefined || rawGuests === '' ? 1 : toInt(rawGuests, NaN);

  if (!checkIn || !checkOut) return fail(400, "checkIn and checkOut are required");
  if (!isValidDateOnly(checkIn) || !isValidDateOnly(checkOut)) {
    return fail(400, "checkIn and checkOut must be valid dates in YYYY-MM-DD format");
  }
  if (!Number.isInteger(guests) || guests < 1) return fail(400, "guests must be a whole number of at least 1");

  if (shortlet.UserId === user_id) return fail(400, "You cannot book your own short let");
  if (shortlet.status !== 'available') return fail(400, "This short let is not available for booking");

  const nights = Math.round((dateOnlyToUTC(checkOut) - dateOnlyToUTC(checkIn)) / DAY_MS);
  if (nights < 1) return fail(400, "Check-out must be at least one day after check-in");
  // Same-day check-in is allowed only until the listing's check-in time.
  if (checkIn < todayInLagos() || checkInAt({ check_in: checkIn, check_in_time: shortlet.checkInTime }) <= new Date()) {
    return fail(400, "Check-in date is in the past");
  }
  if (checkIn < shortlet.availableFrom || checkOut > shortlet.availableTo) {
    return fail(400, `This short let is only available from ${shortlet.availableFrom} to ${shortlet.availableTo}`);
  }
  if (nights < shortlet.minimumStay) return fail(400, `Minimum stay is ${shortlet.minimumStay} night(s)`);
  if (nights > shortlet.maximumStay) return fail(400, `Maximum stay is ${shortlet.maximumStay} night(s)`);
  if (guests > shortlet.guestCapacity) return fail(400, `This short let sleeps at most ${shortlet.guestCapacity} guest(s)`);

  const clash = await ShortletBookings.findOne({ where: overlapWhere(shortlet.id, checkIn, checkOut) });
  if (clash) return fail(409, "This short let is already booked for some of the selected dates", 'DATES_UNAVAILABLE');

  // Price in kobo to avoid float drift.
  const pricePerNightKobo = toKobo(shortlet.pricePerNight);
  const cleaningFeeKobo = toKobo(shortlet.cleaningFee || 0);
  const securityDepositKobo = toKobo(shortlet.securityDeposit || 0);
  const subtotalKobo = pricePerNightKobo * nights;
  const totalKobo = subtotalKobo + cleaningFeeKobo + securityDepositKobo;
  if (!Number.isSafeInteger(totalKobo) || pricePerNightKobo <= 0) {
    logger.error('Shortlet has an invalid price', { shortlet_id: shortlet.id, pricePerNight: shortlet.pricePerNight });
    return fail(400, "This short let does not have a valid price and cannot be booked yet");
  }

  return {
    stay: {
      checkIn, checkOut, nights, guests,
      checkInTime: shortlet.checkInTime,
      checkOutTime: shortlet.checkOutTime,
      pricePerNightKobo, cleaningFeeKobo, securityDepositKobo, subtotalKobo, totalKobo,
      breakdown: {
        pricePerNight: fromKobo(pricePerNightKobo),
        nights,
        subtotal: fromKobo(subtotalKobo),
        cleaningFee: fromKobo(cleaningFeeKobo),
        securityDeposit: fromKobo(securityDepositKobo),
        securityDepositRefundable: true,
        total: fromKobo(totalKobo),
      },
      cancellationPolicy: describePolicy(shortlet.cancellationPolicy, { checkIn, checkInTime: shortlet.checkInTime }),
    },
  };
}

function sendError(res, error) {
  return res.status(error.status).json({ success: false, ...(error.code && { code: error.code }), message: error.message });
}

// ─────────────────────────────────────────────
// GET /shortlet/availability/:id  — booked ranges for the date picker
// ─────────────────────────────────────────────
async function getShortletAvailability(req, res) {
  try {
    const shortlet = await findShortletByIdOrSlug(req.params.id, {
      attributes: ['id', 'availableFrom', 'availableTo', 'minimumStay', 'maximumStay', 'checkInTime', 'checkOutTime', 'guestCapacity', 'cancellationPolicy', 'status'],
    });
    if (!shortlet) {
      return res.status(404).json({ success: false, message: "Short let not found" });
    }

    const today = todayInLagos();
    const booked = await ShortletBookings.findAll({
      attributes: ['check_in', 'check_out', 'status', 'actual_check_out'],
      where: {
        shortlet_id: shortlet.id,
        [Op.or]: [
          { status: 'confirmed', check_out: { [Op.gt]: today } },
          { status: 'cancelled', actual_check_out: { [Op.gt]: today } },
        ],
      },
      order: [['check_in', 'ASC']],
    });

    return res.status(200).json({
      success: true,
      data: {
        ...shortlet.toJSON(),
        bookable: shortlet.status === 'available',
        // check_out is the departure day and is free for a new check-in.
        bookedRanges: booked.map((b) => ({ checkIn: b.check_in, checkOut: b.status === 'cancelled' ? b.actual_check_out : b.check_out })),
      },
      message: "Availability retrieved successfully",
    });
  } catch (error) {
    logger.error('Error fetching shortlet availability', { error: error.message });
    return res.status(500).json({ success: false, message: "Server error" });
  }
}

// ─────────────────────────────────────────────
// GET /shortlet/quote/:id?checkIn=&checkOut=&guests=  — price before paying
// ─────────────────────────────────────────────
async function quoteShortlet(req, res) {
  try {
    const shortlet = await findShortletByIdOrSlug(req.params.id);
    if (!shortlet) {
      return res.status(404).json({ success: false, message: "Short let not found" });
    }
    const { error, stay } = await evaluateStay(shortlet, req.user.userId, req.query);
    if (error) return sendError(res, error);

    return res.status(200).json({
      success: true,
      message: "Quote generated successfully",
      data: {
        shortlet_id: shortlet.id,
        checkIn: stay.checkIn,
        checkOut: stay.checkOut,
        guests: stay.guests,
        checkInTime: stay.checkInTime,
        checkOutTime: stay.checkOutTime,
        ...stay.breakdown,
        cancellationPolicy: stay.cancellationPolicy,
      },
    });
  } catch (error) {
    logger.error('Error quoting shortlet', { error: error.message, userId: req.user?.userId });
    return res.status(500).json({ success: false, message: "Server error" });
  }
}

// ─────────────────────────────────────────────
// POST /shortlet/book
// Body: { shortlet_id, checkIn: 'YYYY-MM-DD', checkOut: 'YYYY-MM-DD', guests?, pin }
// Charges the guest's wallet (PIN-protected); the platform holds the money
// until the host payout 24h after check-in.
// ─────────────────────────────────────────────
async function bookShortlet(req, res) {
  try {
    const user_id = req.user.userId;
    const { shortlet_id, pin } = req.body;

    if (!shortlet_id) {
      return res.status(400).json({ success: false, message: "shortlet_id is required" });
    }

    const shortlet = await findShortletByIdOrSlug(String(shortlet_id));
    if (!shortlet) {
      return res.status(404).json({ success: false, message: "Short let not found" });
    }

    const { error, stay } = await evaluateStay(shortlet, user_id, req.body);
    if (error) return sendError(res, error);

    // PIN — required before any money leaves the wallet.
    const pinError = await verifyTransactionPin(user_id, pin, 'booking');
    if (pinError) {
      logger.warn('Shortlet booking blocked by PIN check', { user_id, shortlet_id: shortlet.id, reason: pinError.code });
      return sendError(res, pinError);
    }

    // Commission is the admin-set per-landlord value, frozen on the booking.
    // It applies to nights + cleaning fee; the deposit goes back to the guest.
    const commissionPercent = await getShortletCommissionPercent(shortlet.UserId);
    const { hostKobo, platformKobo } = splitKobo(stay.subtotalKobo + stay.cleaningFeeKobo, commissionPercent);
    const payoutDueAt = new Date(checkInAt({ check_in: stay.checkIn, check_in_time: stay.checkInTime }).getTime() + PAYOUT_DELAY_MS);
    // Deposit is held until 48h after check-out so the host can file a claim.
    const depositRefundDueAt = stay.securityDepositKobo > 0
      ? new Date(checkOutAt({ check_out: stay.checkOut, check_out_time: stay.checkOutTime }).getTime() + DEPOSIT_CLAIM_WINDOW_MS)
      : null;

    let chargeResult;
    try {
      chargeResult = await chargeMarketplacePayment({
        payerUserId: user_id,
        // No landlord here on purpose: the platform holds the full amount
        // until the payout job pays the host.
        landlordUserId: null,
        amount: fromKobo(stay.totalKobo),
        commissionPercent: 100,
        type: 'shortlet booking',
        narration: `Shortlet booking for "${shortlet.title}" (${stay.checkIn} to ${stay.checkOut})`,
        // Runs inside the same DB transaction as the charge: if the dates were
        // taken in the meantime (or anything else fails) the charge rolls back,
        // so a guest is never charged without a booking.
        applyEffects: async (t) => {
          // Serialise bookings for the same shortlet so two guests can't both
          // pass the overlap check for the same nights.
          const fresh = await Shortlets.findByPk(shortlet.id, { transaction: t, lock: t.LOCK.UPDATE });
          if (!fresh || fresh.status !== 'available') throw new BookingConflictError();
          const conflict = await ShortletBookings.findOne({
            where: overlapWhere(shortlet.id, stay.checkIn, stay.checkOut),
            transaction: t,
          });
          if (conflict) throw new BookingConflictError();

          return ShortletBookings.create({
            user_id,
            shortlet_id: shortlet.id,
            host_id: shortlet.UserId,
            check_in: stay.checkIn,
            check_out: stay.checkOut,
            check_in_time: stay.checkInTime,
            check_out_time: stay.checkOutTime,
            nights: stay.nights,
            guests: stay.guests,
            price_per_night: fromKobo(stay.pricePerNightKobo),
            cleaning_fee: fromKobo(stay.cleaningFeeKobo),
            security_deposit: fromKobo(stay.securityDepositKobo),
            total_amount: fromKobo(stay.totalKobo),
            status: 'confirmed',
            commission_percent: commissionPercent,
            host_payout: fromKobo(hostKobo),
            platform_fee: fromKobo(platformKobo),
            payout_status: 'pending',
            payout_due_at: payoutDueAt,
            deposit_status: stay.securityDepositKobo > 0 ? 'held' : 'none',
            deposit_refund_due_at: depositRefundDueAt,
            cancellation_policy: stay.cancellationPolicy.policy,
          }, { transaction: t });
        },
      });
    } catch (error) {
      if (error instanceof InsufficientBalanceError) {
        return res.status(400).json({
          success: false,
          code: 'INSUFFICIENT_BALANCE',
          message: "Insufficient wallet balance. Please top up your wallet to book this short let.",
        });
      }
      if (error instanceof BookingConflictError) {
        return res.status(409).json({ success: false, code: 'DATES_UNAVAILABLE', message: "This short let was just booked for some of the selected dates" });
      }
      if (error.code === 'WALLET_NOT_FOUND' || error.code === 'WALLET_INACTIVE') {
        return res.status(400).json({ success: false, code: error.code, message: "Your wallet is not available. Please contact support." });
      }
      throw error;
    }

    const booking = chargeResult.effects;
    logger.info('Shortlet booked', { user_id, shortlet_id: shortlet.id, booking_id: booking.id, nights: stay.nights, total: stay.breakdown.total });

    // Non-critical notifications
    try {
      const [guest, host] = await Promise.all([
        Users.findByPk(user_id, { attributes: ['id', 'email', 'full_name'] }),
        Users.findByPk(shortlet.UserId, { attributes: ['id', 'email', 'full_name'] }),
      ]);
      const amountText = `₦${Number(stay.breakdown.total).toLocaleString()}`;
      const when = `${stay.checkIn} (check-in from ${stay.checkInTime}) to ${stay.checkOut} (check-out by ${stay.checkOutTime})`;

      await logAndEmailUser(user_id, guest?.email, "Shortlet Booked",
        `Your booking for "${shortlet.title}" from ${when}, ${stay.nights} night(s), ${stay.guests} guest(s), is confirmed. ${amountText} has been deducted from your wallet. Cancellation policy (${stay.cancellationPolicy.label}): ${stay.cancellationPolicy.summary}`
      );
      if (host) {
        await logAndEmailUser(host.id, host.email, "New Shortlet Booking",
          `${guest?.full_name ?? 'A guest'} booked your short let "${shortlet.title}" from ${when}, ${stay.nights} night(s), ${stay.guests} guest(s). Your payout of ₦${Number(fromKobo(hostKobo)).toLocaleString()} will be sent to your wallet 24 hours after check-in.`
        );
      }
      await notifySuperAdmins(
        `Short let "${shortlet.title}" was booked by ${guest?.full_name ?? user_id} for ${stay.nights} night(s) (${amountText}).`,
        "shortlet"
      );
    } catch (notifyError) {
      logger.error('Shortlet booking notification failed', { error: notifyError.message, booking_id: booking.id });
    }

    return res.status(201).json({
      success: true,
      message: "Short let booked successfully",
      data: guestView(booking),
      walletBalance: chargeResult.payerBalance,
    });
  } catch (error) {
    logger.error('Error booking shortlet', { error: error.message, userId: req.user?.userId });
    return res.status(500).json({ success: false, message: "Server error" });
  }
}

// Guests shouldn't see the host's payout or the platform's cut.
// One summary of the security deposit + any claim, identical for guest, host
// and admin, so every side sees the same facts (amount, reason, photos,
// decision, admin note, who got what). Only the action flags differ:
//   canClaim   — host only, while the claim window is open
//   canResolve — admin only, while a claim is waiting for a decision
function depositClaimSummary(booking, role, now = new Date()) {
  const b = typeof booking.toJSON === 'function' ? booking.toJSON() : booking;
  const deposit = Number(b.security_deposit) || 0;
  const paidToHost = Number(b.deposit_paid_to_host) || 0;
  const resolved = !!b.deposit_claim_resolved_at;
  const windowOpen = b.deposit_status === 'held' && now >= checkInAt(b)
    && (!b.deposit_refund_due_at || now <= new Date(b.deposit_refund_due_at));
  return {
    depositStatus: b.deposit_status,                   // none · held · claimed · refunded · settled
    securityDeposit: fromKobo(toKobo(b.security_deposit)),
    claimWindowEndsAt: b.deposit_status === 'held' ? b.deposit_refund_due_at : null,
    claimed: !!b.deposit_claimed_at,
    claim: b.deposit_claimed_at ? {
      amount: b.deposit_claim_amount,
      reason: b.deposit_claim_reason,
      photos: b.deposit_claim_photos || [],
      claimedAt: b.deposit_claimed_at,
      status: resolved ? 'resolved' : 'pending_review',
      decision: b.deposit_claim_decision,             // approved · partially_approved · rejected · null
      adminNote: b.deposit_claim_note,
      resolvedAt: b.deposit_claim_resolved_at,
      paidToHost: resolved ? fromKobo(toKobo(paidToHost)) : null,
      refundedToGuest: resolved ? fromKobo(toKobo(deposit - paidToHost)) : null,
    } : null,
    canClaim: role === 'host' && windowOpen,
    canResolve: role === 'admin' && b.deposit_status === 'claimed',
  };
}

function guestView(booking) {
  const json = typeof booking.toJSON === 'function' ? booking.toJSON() : { ...booking };
  json.depositClaim = depositClaimSummary(json, 'guest');
  delete json.host_payout;
  delete json.platform_fee;
  delete json.commission_percent;
  delete json.payout_status;
  delete json.payout_due_at;
  delete json.paid_out_at;
  return json;
}

// Hosts see their payout; only the platform's cut is hidden.
function hostView(booking) {
  const json = typeof booking.toJSON === 'function' ? booking.toJSON() : { ...booking };
  json.depositClaim = depositClaimSummary(json, 'host');
  delete json.platform_fee;
  return json;
}

// Admins see every field, including the platform's cut.
function adminView(booking) {
  const json = typeof booking.toJSON === 'function' ? booking.toJSON() : { ...booking };
  json.depositClaim = depositClaimSummary(json, 'admin');
  return json;
}

// ─────────────────────────────────────────────
// GET /shortlet/bookings  — the signed-in guest's shortlet bookings
// ─────────────────────────────────────────────
async function getUserShortletBookings(user_id) {
  const bookings = await ShortletBookings.findAll({
    where: { user_id },
    include: [
      { model: Shortlets, as: 'shortlet', attributes: BOOKING_SHORTLET_ATTRIBUTES },
      { model: Users, as: 'host', attributes: PERSON_ATTRIBUTES },
    ],
    order: [['check_in', 'DESC']],
  });
  return bookings.map(guestView);
}

async function getMyShortletBookings(req, res) {
  try {
    const bookings = await getUserShortletBookings(req.user.userId);
    return res.status(200).json({ success: true, message: "Shortlet bookings retrieved successfully", data: bookings });
  } catch (error) {
    logger.error('Error fetching shortlet bookings', { error: error.message, userId: req.user?.userId });
    return res.status(500).json({ success: false, message: "Server error" });
  }
}

// ─────────────────────────────────────────────
// GET /shortlet/host/bookings?status=  — bookings on the signed-in host's listings
// ─────────────────────────────────────────────
async function getHostShortletBookings(req, res) {
  try {
    const where = { host_id: req.user.userId };
    if (req.query.status) {
      if (!['confirmed', 'cancelled', 'completed'].includes(req.query.status)) {
        return res.status(400).json({ success: false, message: "status must be one of: confirmed, cancelled, completed" });
      }
      where.status = req.query.status;
    }
    const bookings = await ShortletBookings.findAll({
      where,
      include: [
        { model: Shortlets, as: 'shortlet', attributes: BOOKING_SHORTLET_ATTRIBUTES },
        { model: Users, as: 'guest', attributes: PERSON_ATTRIBUTES },
      ],
      order: [['check_in', 'DESC']],
    });
    return res.status(200).json({ success: true, message: "Host bookings retrieved successfully", data: bookings.map(hostView) });
  } catch (error) {
    logger.error('Error fetching host shortlet bookings', { error: error.message, userId: req.user?.userId });
    return res.status(500).json({ success: false, message: "Server error" });
  }
}

// ─────────────────────────────────────────────
// GET /shortlet/bookings/:bookingId  — guest or host
// ─────────────────────────────────────────────
async function getShortletBooking(req, res) {
  try {
    const { bookingId } = req.params;
    if (!isUUID(bookingId)) {
      return res.status(404).json({ success: false, message: "Booking not found" });
    }
    const user_id = req.user.userId;
    const booking = await ShortletBookings.findOne({
      where: { id: bookingId, [Op.or]: [{ user_id }, { host_id: user_id }] },
      include: [
        { model: Shortlets, as: 'shortlet', attributes: [...BOOKING_SHORTLET_ATTRIBUTES, 'houseRules', 'landmark'] },
        { model: Users, as: 'guest', attributes: PERSON_ATTRIBUTES },
        { model: Users, as: 'host', attributes: PERSON_ATTRIBUTES },
      ],
    });
    if (!booking) {
      return res.status(404).json({ success: false, message: "Booking not found" });
    }

    const isGuest = booking.user_id === user_id;
    const data = isGuest ? guestView(booking) : hostView(booking);
    // What cancelling right now would mean (before check-in, or ending the stay early).
    if (booking.status === 'confirmed') {
      try {
        const terms = cancellationTerms(booking, isGuest ? 'guest' : 'host');
        data.cancellation = {
          canCancel: true,
          policy: terms.policy,
          stage: terms.stage, // 'before_check_in' | 'during_stay'
          refundAmount: terms.refundAmount,
          nonRefundableAmount: terms.nonRefundableAmount,
          freeCancellationUntil: terms.freeCancellationUntil,
          // during_stay only: when the guest would leave, and that the deposit
          // stays held for the host's 48h claim window
          actualCheckOut: terms.actualCheckOut,
          depositHeldForClaims: terms.depositHeldForClaims,
        };
      } catch (e) {
        data.cancellation = { canCancel: false, reason: e.message };
      }
    } else {
      data.cancellation = { canCancel: false };
    }


    return res.status(200).json({ success: true, message: "Booking retrieved successfully", data });
  } catch (error) {
    logger.error('Error fetching shortlet booking', { error: error.message, userId: req.user?.userId });
    return res.status(500).json({ success: false, message: "Server error" });
  }
}

// ─────────────────────────────────────────────
// POST /shortlet/bookings/:bookingId/cancel  — guest or host
// Body: { reason? }
// ─────────────────────────────────────────────
async function cancelShortletBooking(req, res) {
  try {
    const { bookingId } = req.params;
    if (!isUUID(bookingId)) {
      return res.status(404).json({ success: false, message: "Booking not found" });
    }
    const user_id = req.user.userId;

    let result;
    try {
      result = await cancelBooking({ bookingId, actorUserId: user_id, reason: req.body?.reason });
    } catch (error) {
      if (error instanceof BookingActionError) return sendError(res, error);
      throw error;
    }

    const { booking, cancelledBy, terms, debtKobo } = result;
    logger.info('Shortlet booking cancelled', { booking_id: booking.id, cancelledBy, stage: terms.stage, refund: terms.refundAmount });

    try {
      const [guest, host, shortlet] = await Promise.all([
        Users.findByPk(booking.user_id, { attributes: ['id', 'email', 'full_name'] }),
        booking.host_id ? Users.findByPk(booking.host_id, { attributes: ['id', 'email', 'full_name'] }) : null,
        booking.shortlet_id ? Shortlets.findByPk(booking.shortlet_id, { attributes: ['id', 'title'] }) : null,
      ]);
      const title = shortlet?.title ?? 'your short let';
      const dates = `${booking.check_in} to ${booking.check_out}`;
      const refundText = `₦${Number(terms.refundAmount).toLocaleString()}`;
      const keptText = `₦${Number(terms.nonRefundableAmount).toLocaleString()}`;
      const early = terms.stage === 'during_stay';
      const depositNote = terms.depositHeldForClaims
        ? ' Your security deposit will be returned 48 hours after you leave, unless the host makes an approved damage claim.'
        : '';
      const what = early ? `Your stay at "${title}" has been ended early (leaving on ${terms.actualCheckOut}).` : `Your booking for "${title}" (${dates}) has been cancelled.`;

      await logAndEmailUser(booking.user_id, guest?.email, early ? "Shortlet Stay Ended Early" : "Shortlet Booking Cancelled",
        cancelledBy === 'host'
          ? `${early ? `Your host ended your stay at "${title}" early (leaving on ${terms.actualCheckOut}).` : `Your host cancelled your booking for "${title}" (${dates}).`} ${refundText} has been refunded to your wallet.${depositNote}`
          : `${what} ${refundText} has been refunded to your wallet.${terms.fullRefund ? '' : ` Under the ${terms.policy} cancellation policy, ${keptText} is non-refundable.`}${depositNote}`
      );
      if (host) {
        await logAndEmailUser(host.id, host.email, early ? "Shortlet Stay Ended Early" : "Shortlet Booking Cancelled",
          cancelledBy === 'host'
            ? `You ${early ? 'ended the stay early' : 'cancelled the booking'} for "${title}" (${dates}). The guest was refunded ${refundText}.`
            : `${guest?.full_name ?? 'The guest'} ${early ? `ended their stay early (leaving on ${terms.actualCheckOut})` : 'cancelled their booking'} for "${title}" (${dates}). Your earnings for this booking are now ₦${Number(booking.host_payout).toLocaleString()}.${terms.depositHeldForClaims ? ' You can still file a deposit claim for 48 hours after they leave.' : ''}`
        );
        if (debtKobo > 0) {
          await logAndEmailUser(host.id, host.email, "Amount Owed for a Guest Refund",
            `The guest was refunded for unused nights at "${title}", but your wallet didn't have enough to cover your share. You owe ₦${Number(fromKobo(debtKobo)).toLocaleString()}. It will be taken automatically from your wallet as money comes in (payouts, rent, top-ups), and before any withdrawal or transfer.`
          );
        }
      }
      await notifySuperAdmins(`Shortlet booking for "${title}" (${dates}) was ${early ? 'ended early' : 'cancelled'} by the ${cancelledBy}. Refund: ${refundText}.${debtKobo > 0 ? ` The host now owes ₦${Number(fromKobo(debtKobo)).toLocaleString()} (recovered automatically).` : ''}`, "shortlet");
    } catch (notifyError) {
      logger.error('Shortlet cancellation notification failed', { error: notifyError.message, booking_id: booking.id });
    }

    return res.status(200).json({
      success: true,
      message: "Booking cancelled successfully",
      data: cancelledBy === 'guest' ? guestView(booking) : hostView(booking),
      refundAmount: terms.refundAmount,
      // Only shown to the host: how much of their share they still owe.
      ...(cancelledBy === 'host' && debtKobo > 0 && { hostDebtCreated: fromKobo(debtKobo) }),
    });
  } catch (error) {
    logger.error('Error cancelling shortlet booking', { error: error.message, userId: req.user?.userId });
    return res.status(500).json({ success: false, message: "Server error" });
  }
}

// ─────────────────────────────────────────────
// POST /shortlet/bookings/:bookingId/deposit-claim  — host only
// multipart/form-data: amount, reason, photos (1–5 images). Allowed from check-in until 48h after check-out.
// ─────────────────────────────────────────────
async function claimShortletDeposit(req, res) {
  try {
    const { bookingId } = req.params;
    if (!isUUID(bookingId)) {
      return res.status(404).json({ success: false, message: "Booking not found" });
    }
    const hostUserId = req.user.userId;
    const { amount, reason } = req.body || {};
    const files = req.files || [];

    // 1. Check everything BEFORE uploading, so a claim that can't be filed
    //    never leaves photos behind on Cloudinary.
    try {
      validateDepositClaim(await ShortletBookings.findByPk(bookingId), { hostUserId, amount, reason, photoCount: files.length });
    } catch (error) {
      if (error instanceof BookingActionError) return sendError(res, error);
      throw error;
    }

    // 2. Upload the evidence.
    let uploaded;
    try {
      uploaded = await Promise.all(files.map((f) => uploadBufferToCloudinary(f.buffer, f.mimetype, "deposit-claims")));
    } catch (error) {
      logger.error('Deposit claim photo upload failed', { error: error.message, booking_id: bookingId });
      return res.status(502).json({ success: false, code: 'UPLOAD_FAILED', message: "Couldn't upload the photos. Please try again." });
    }

    // 3. File the claim (re-checked under a row lock). If that fails, remove
    //    the photos we just uploaded.
    let result;
    try {
      result = await fileDepositClaim({ bookingId, hostUserId, amount, reason, photos: uploaded.map((u) => u.secure_url) });
    } catch (error) {
      Promise.all(uploaded.map((u) => cloudinary.uploader.destroy(u.public_id).catch(() => {}))).catch(() => {});
      if (error instanceof BookingActionError) return sendError(res, error);
      throw error;
    }
    const { booking } = result;
    logger.info('Shortlet deposit claim filed', { booking_id: booking.id, amount: booking.deposit_claim_amount, photos: booking.deposit_claim_photos.length });

    try {
      const [guest, host] = await Promise.all([
        Users.findByPk(booking.user_id, { attributes: ['id', 'email', 'full_name'] }),
        Users.findByPk(booking.host_id, { attributes: ['id', 'email', 'full_name'] }),
      ]);
      const amountText = `₦${Number(booking.deposit_claim_amount).toLocaleString()}`;
      await logAndEmailUser(booking.user_id, guest?.email, "Security Deposit Claim",
        `Your host has claimed ${amountText} of your ₦${Number(booking.security_deposit).toLocaleString()} security deposit for your stay from ${booking.check_in}. Reason: "${booking.deposit_claim_reason}". ${booking.deposit_claim_photos.length} photo(s) were attached; you can see them on the booking. Our team will review it; contact support if you disagree.`
      );
      await notifySuperAdmins(`${host?.full_name ?? 'A host'} filed a ${amountText} security deposit claim (booking ${booking.id}). Review it under deposit claims.`, "shortlet");
    } catch (notifyError) {
      logger.error('Deposit claim notification failed', { error: notifyError.message, booking_id: booking.id });
    }

    return res.status(200).json({ success: true, message: "Deposit claim submitted for review", data: hostView(booking) });
  } catch (error) {
    logger.error('Error filing deposit claim', { error: error.message, userId: req.user?.userId });
    return res.status(500).json({ success: false, message: "Server error" });
  }
}

// ─────────────────────────────────────────────
// GET /admin/shortlet-bookings/deposit-claims?status=open|resolved|all  — super admin
// ─────────────────────────────────────────────
async function adminListDepositClaims(req, res) {
  try {
    const status = req.query.status || 'open';
    const where = { deposit_claimed_at: { [Op.ne]: null } };
    if (status === 'open') where.deposit_status = 'claimed';
    else if (status === 'resolved') where.deposit_claim_resolved_at = { [Op.ne]: null };
    else if (status !== 'all') {
      return res.status(400).json({ success: false, message: "status must be one of: open, resolved, all" });
    }
    const claims = await ShortletBookings.findAll({
      where,
      include: [
        { model: Shortlets, as: 'shortlet', attributes: ['id', 'slug', 'title', 'city', 'area'] },
        { model: Users, as: 'guest', attributes: ['id', 'full_name', 'email', 'phone_no'] },
        { model: Users, as: 'host', attributes: ['id', 'full_name', 'email', 'phone_no'] },
      ],
      order: [['deposit_claimed_at', 'ASC']],
    });
    return res.status(200).json({ success: true, count: claims.length, data: claims.map(adminView), message: "Deposit claims retrieved successfully" });
  } catch (error) {
    logger.error('Error listing deposit claims', { error: error.message });
    return res.status(500).json({ success: false, message: "Server error" });
  }
}

// ─────────────────────────────────────────────
// PUT /admin/shortlet-bookings/:bookingId/deposit-claim  — super admin
// Body: { decision: 'approve' | 'reject', amount?, note? }
// ─────────────────────────────────────────────
async function adminResolveDepositClaim(req, res) {
  try {
    const { bookingId } = req.params;
    if (!isUUID(bookingId)) {
      return res.status(404).json({ success: false, message: "Booking not found" });
    }
    const { decision, amount, note } = req.body || {};
    let result;
    try {
      result = await resolveDepositClaim({ bookingId, decision, amount, note });
    } catch (error) {
      if (error instanceof BookingActionError) return sendError(res, error);
      throw error;
    }
    const { booking, awardKobo, guestKobo } = result;
    logger.info('Shortlet deposit claim resolved', { booking_id: booking.id, decision: booking.deposit_claim_decision, toHost: awardKobo / 100, toGuest: guestKobo / 100 });

    try {
      const [guest, host] = await Promise.all([
        Users.findByPk(booking.user_id, { attributes: ['id', 'email'] }),
        Users.findByPk(booking.host_id, { attributes: ['id', 'email'] }),
      ]);
      const toHost = `₦${Number(fromKobo(awardKobo)).toLocaleString()}`;
      const toGuest = `₦${Number(fromKobo(guestKobo)).toLocaleString()}`;
      const noteText = booking.deposit_claim_note ? ` Note from our team: "${booking.deposit_claim_note}"` : '';
      await logAndEmailUser(booking.user_id, guest?.email, "Security Deposit Claim Decided",
        awardKobo > 0
          ? `The host's deposit claim for your stay from ${booking.check_in} was ${booking.deposit_claim_decision === 'approved' ? 'approved' : 'partly approved'}: ${toHost} went to the host and ${toGuest} was refunded to your wallet.${noteText}`
          : `The host's deposit claim for your stay from ${booking.check_in} was rejected. Your full deposit of ${toGuest} has been refunded to your wallet.${noteText}`
      );
      if (host) {
        await logAndEmailUser(host.id, host.email, "Security Deposit Claim Decided",
          awardKobo > 0
            ? `Your deposit claim for the stay from ${booking.check_in} was ${booking.deposit_claim_decision === 'approved' ? 'approved' : 'partly approved'}. ${toHost} has been credited to your wallet.${noteText}`
            : `Your deposit claim for the stay from ${booking.check_in} was rejected and the deposit was returned to the guest.${noteText}`
        );
      }
    } catch (notifyError) {
      logger.error('Deposit claim decision notification failed', { error: notifyError.message, booking_id: booking.id });
    }

    return res.status(200).json({
      success: true,
      message: "Deposit claim resolved",
      data: adminView(booking),
      paidToHost: fromKobo(awardKobo),
      refundedToGuest: fromKobo(guestKobo),
    });
  } catch (error) {
    logger.error('Error resolving deposit claim', { error: error.message });
    return res.status(500).json({ success: false, message: "Server error" });
  }
}

// ─────────────────────────────────────────────
// GET /admin/shortlet-bookings  — super admin: every booking
// Query: status, deposit_status, shortlet_id, guest_id, host_id, limit (≤100, default 50), offset
// ─────────────────────────────────────────────
const ADMIN_BOOKING_INCLUDE = [
  { model: Shortlets, as: 'shortlet', attributes: ['id', 'slug', 'title', 'address', 'city', 'area', 'coverImage', 'cancellationPolicy'] },
  { model: Users, as: 'guest', attributes: ['id', 'full_name', 'email', 'phone_no'] },
  { model: Users, as: 'host', attributes: ['id', 'full_name', 'email', 'phone_no'] },
];

async function adminListShortletBookings(req, res) {
  try {
    const { status, deposit_status, shortlet_id, guest_id, host_id } = req.query;
    const where = {};
    if (status) {
      if (!['confirmed', 'completed', 'cancelled'].includes(status)) {
        return res.status(400).json({ success: false, message: "status must be one of: confirmed, completed, cancelled" });
      }
      where.status = status;
    }
    if (deposit_status) {
      if (!['none', 'held', 'claimed', 'refunded', 'settled'].includes(deposit_status)) {
        return res.status(400).json({ success: false, message: "deposit_status must be one of: none, held, claimed, refunded, settled" });
      }
      where.deposit_status = deposit_status;
    }
    for (const [key, col] of [['shortlet_id', 'shortlet_id'], ['guest_id', 'user_id'], ['host_id', 'host_id']]) {
      const v = req.query[key];
      if (v === undefined) continue;
      if (!isUUID(v)) return res.status(400).json({ success: false, message: `${key} must be a valid UUID` });
      where[col] = v;
    }
    const { limit, offset } = parsePagination(req.query.limit, req.query.offset);
    const { count, rows } = await ShortletBookings.findAndCountAll({
      where,
      include: ADMIN_BOOKING_INCLUDE,
      order: [['createdAt', 'DESC']],
      limit: limit || 50,
      offset: offset || 0,
      distinct: true,
    });
    return res.status(200).json({ success: true, count, data: rows.map(adminView), message: "Shortlet bookings retrieved successfully" });
  } catch (error) {
    logger.error('Error listing shortlet bookings (admin)', { error: error.message });
    return res.status(500).json({ success: false, message: "Server error" });
  }
}

// ─────────────────────────────────────────────
// GET /admin/shortlet-bookings/:bookingId  — super admin: one booking, all fields
// ─────────────────────────────────────────────
async function adminGetShortletBooking(req, res) {
  try {
    const { bookingId } = req.params;
    if (!isUUID(bookingId)) {
      return res.status(404).json({ success: false, message: "Booking not found" });
    }
    const booking = await ShortletBookings.findByPk(bookingId, { include: ADMIN_BOOKING_INCLUDE });
    if (!booking) {
      return res.status(404).json({ success: false, message: "Booking not found" });
    }
    return res.status(200).json({ success: true, data: adminView(booking), message: "Booking retrieved successfully" });
  } catch (error) {
    logger.error('Error fetching shortlet booking (admin)', { error: error.message });
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
  getShortletAvailability,
  quoteShortlet,
  bookShortlet,
  getMyShortletBookings,
  getUserShortletBookings,
  getHostShortletBookings,
  getShortletBooking,
  cancelShortletBooking,
  claimShortletDeposit,
  adminListDepositClaims,
  adminResolveDepositClaim,
  adminListShortletBookings,
  adminGetShortletBooking,
};
