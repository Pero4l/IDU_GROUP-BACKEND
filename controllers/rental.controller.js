const { Rentals, Users, Notifications, Profile, Progress } = require("../models");
const { notifySuperAdmins, logAndEmailUser } = require('./notification.controller');
const { withTransaction } = require('../utils/rollback');
const logger = require('../utils/logger');
const { Op } = require('sequelize');
const cloudinary = require("cloudinary").v2;
const { v4: uuidv4 } = require("uuid");
const jwt = require("jsonwebtoken");
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
// POST /rental/post  — landlord adds a rental
// ─────────────────────────────────────────────
async function addRental(req, res) {
  try {
    const { title, description, propertyType, location, price, priceType, status } = req.body;
    const images = req.files?.images || [];
    const videos = req.files?.videos || [];

    if (!title || !description || !propertyType || !location || !price || !priceType || !status || !images) {
      return res.status(400).json({ success: false, message: "All fields are required, including images or videos" });
    }

    if (req.user.role !== 'landlord') {
      return res.status(403).json({ success: false, message: "Only landlords can add rentals" });
    }

    if (images.length && !videos.length && images.length > 10)
      return res.status(400).json({ success: false, message: "Max 10 images allowed" });
    if (videos.length && !images.length && videos.length > 4)
      return res.status(400).json({ success: false, message: "Max 4 videos allowed" });
    if (images.length && videos.length && (images.length > 4 || videos.length > 2))
      return res.status(400).json({ success: false, message: "When uploading both, max is 4 images + 2 videos" });

    // Upload to Cloudinary BEFORE the transaction — Cloudinary is external,
    // not transactional. If the upload fails we never touch the DB.
    const uploadedImages = await Promise.all(
      images.map((img) => uploadBufferToCloudinary(img.buffer, img.mimetype, "posts/images"))
    );
    const uploadedVideos = await Promise.all(
      videos.map((vid) =>
        new Promise((resolve, reject) => {
          const stream = cloudinary.uploader.upload_stream(
            { folder: "posts/videos", resource_type: "video", public_id: uuidv4() },
            (error, result) => {
              if (error) { logger.error('Video upload error', { error: error.message }); reject(error); }
              else resolve(result);
            }
          );
          stream.end(vid.buffer);
        })
      )
    );

    // Single DB write — no multi-step transaction needed here.
    // The notification is a side-effect; keep it outside so a mail/DB
    // notification failure never rolls back the rental creation.
    const rental = await Rentals.create({
      title, description, propertyType, location, price, priceType, status,
      images: uploadedImages.map((i) => i.secure_url),
      videos: uploadedVideos.map((v) => v.secure_url),
      amenities: amenitiesData,
      UserId: req.user.userId,
    });

    logger.info('Rental created', { rentalId: rental.id, userId: req.user.userId });

    // Non-critical side-effects — logAndEmailUser and notifySuperAdmins
    // never throw, so no .catch() needed
    const landlord = await Users.findByPk(req.user.userId);
    await logAndEmailUser(req.user.userId, landlord?.email, "Rental Added", `Your rental "${title}" has been added successfully.`);
    await notifySuperAdmins(`New rental posted by user ${req.user.userId}: ${title}`, "rental");

    return res.status(201).json({ success: true, message: "Rental property added successfully" });
  } catch (err) {
    logger.error('Error adding rental', { error: err.message, userId: req.user?.userId });
    return res.status(500).json({ success: false, message: "Error adding rental" });
  }
}

// ─────────────────────────────────────────────
// GET /rental/all
// ─────────────────────────────────────────────
async function seeAllRentals(req, res) {
  try {
    const { limit, offset } = req.query;

    const queryOptions = {
      attributes: ["id", "slug", "title", "description", "propertyType", "location", "price", "priceType", "images", "status", "UserId", "createdAt"],
      include: [{
        model: Users,
        attributes: ["id", "full_name", "phone_no"],
        include: [{ model: Profile, attributes: ['image', 'verified'] }]
      }],
      order: [['createdAt', 'DESC']],
    };

    const parsedLimit = limit ? parseInt(limit, 10) : null;
    const parsedOffset = offset ? parseInt(offset, 10) : null;

    if (parsedLimit !== null) {
      queryOptions.limit = parsedLimit;
    }
    if (parsedOffset !== null) {
      queryOptions.offset = parsedOffset;
    }

    let result;
    if (parsedLimit !== null) {
      result = await Rentals.findAndCountAll(queryOptions);
    } else {
      const rows = await Rentals.findAll(queryOptions);
      result = { count: rows.length, rows };
    }

    const { count, rows } = result;

    return res.status(200).json({ success: true, count, data: rows, message: "Rentals retrieved successfully" });
  } catch (error) {
    logger.error('Error fetching all rentals', { error: error.message });
    return res.status(500).json({ success: false, message: "Server error" });
  }
}

// ─────────────────────────────────────────────
// GET /rental/get1/:id
// ─────────────────────────────────────────────
async function getRental(req, res) {
  try {
    const { id } = req.params;
    const query = {
      attributes: ["id", "slug", "title", "description", "propertyType", "location", "price", "priceType", "images", "videos", "status", "UserId", "createdAt", "updatedAt"],
      include: [{
        model: Users,
        attributes: ["id", "full_name", "phone_no"],
        include: [{ model: Profile, attributes: ['image', 'verified'] }]
      }]
    };

    const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
    const rental = isUUID
      ? await Rentals.findByPk(id, query)
      : await Rentals.findOne({ where: { slug: id }, ...query });

    if (!rental) {
      return res.status(404).json({ success: false, message: "Rental not found" });
    }

    const rentalData = rental.toJSON();
    return res.status(200).json({
      success: true,
      data: {
        ...rentalData,
        images: rentalData.images || [],
        videos: rentalData.videos || [],
        amenities: rentalData.amenities || [],
        landlord: rentalData.Users || { full_name: "User" },
      },
      message: "Rental retrieved successfully",
    });
  } catch (error) {
    logger.error('Error fetching rental', { error: error.message });
    return res.status(500).json({ success: false, message: "Server error" });
  }
}

// ─────────────────────────────────────────────
// PUT /rental/update/:id
// ─────────────────────────────────────────────
async function updateRental(req, res) {
  try {
    const { id } = req.params;
    const { title, description, propertyType, location, price, priceType, images, videos, status, amenities, legalFee, cautionFee, brokeFee, mgtServiceCharge } = req.body;

    const rental = await Rentals.findByPk(id);
    if (!rental) {
      return res.status(404).json({ success: false, message: "Rental not found" });
    }
    if (rental.UserId !== req.user.userId || req.user.role !== 'landlord') {
      return res.status(403).json({ success: false, message: "You are not authorized to update this rental" });
    }

    // Single record update — no transaction needed
    await rental.update({
      title: title || rental.title,
      description: description || rental.description,
      propertyType: propertyType || rental.propertyType,
      location: location || rental.location,
      price: price || rental.price,
      priceType: priceType || rental.priceType,
      legalFee: legalFee !== undefined ? legalFee : rental.legalFee,
      cautionFee: cautionFee !== undefined ? cautionFee : rental.cautionFee,
      brokeFee: brokeFee !== undefined ? brokeFee : rental.brokeFee,
      mgtServiceCharge: mgtServiceCharge !== undefined ? mgtServiceCharge : rental.mgtServiceCharge,
      images: images || rental.images,
      videos: videos || rental.videos,
      status: status || rental.status,
      amenities: amenitiesData !== undefined ? amenitiesData : rental.amenities,
    });

    const updatedRental = await Rentals.findByPk(id, {
      include: [{ model: Users, attributes: ["id", "full_name", "email"] }]
    });

    logger.info('Rental updated', { rentalId: id, userId: req.user.userId });

    if (updatedRental.User) {
      await logAndEmailUser(req.user.userId, updatedRental.User.email, "Rental Updated", `Your rental "${updatedRental.title}" has been updated.`);
    }
    await notifySuperAdmins(`Rental ${id} was updated by user ${req.user.userId}`, "rental");

    return res.status(200).json({ success: true, data: updatedRental, message: "Rental updated successfully" });
  } catch (error) {
    logger.error('Error updating rental', { error: error.message, userId: req.user?.userId });
    return res.status(500).json({ success: false, message: "Server error" });
  }
}

// ─────────────────────────────────────────────
// DELETE /rental/delete/:id
// Wraps destroy + notification in a transaction so if the
// notification DB write fails the rental is NOT deleted.
// ─────────────────────────────────────────────
async function deleteRental(req, res) {
  try {
    const { id } = req.params;

    const rental = await Rentals.findByPk(id);
    if (!rental) {
      return res.status(404).json({ success: false, message: "Rental not found" });
    }
    if (rental.UserId !== req.user.userId || (req.user.role !== 'landlord' && req.user.role !== 'agent')) {
      return res.status(403).json({ success: false, message: "You are not authorized to delete this rental" });
    }

    const rentalTitle = rental.title;
    const landlordId  = req.user.userId;

    // Wrap destroy inside transaction so any follow-up DB write failure
    // rolls the delete back (rental stays in DB, user is notified to retry)
    await withTransaction(async (t) => {
      await rental.destroy({ transaction: t });
    }, { context: 'deleteRental', rentalId: id, userId: landlordId });

    logger.info('Rental deleted', { rentalId: id, title: rentalTitle, userId: landlordId });

    // Non-critical side-effects
    const landlord = await Users.findByPk(landlordId);
    await logAndEmailUser(landlordId, landlord?.email, "Rental Deleted", `Your rental "${rentalTitle}" has been deleted.`);
    await notifySuperAdmins(`Rental "${rentalTitle}" was deleted by user ${landlordId}`, "rental");

    return res.status(200).json({ success: true, message: "Rental deleted successfully" });
  } catch (error) {
    logger.error('Error deleting rental', { error: error.message, userId: req.user?.userId });
    return res.status(500).json({ success: false, message: "Server error", error: error.message });
  }
}

// ─────────────────────────────────────────────
// GET /rental/search
// ─────────────────────────────────────────────
async function searchRentals(req, res) {
  try {
    const { location } = req.query;
    if (!location) return res.status(400).json({ success: false, message: "Search location query parameter is required." });

    const rentals = await Rentals.findAll({
      where: { location: { [Op.iLike]: `%${location}%` } },
      attributes: ["id", "slug", "title", "description", "propertyType", "location", "price", "priceType", "images", "status", "UserId", "createdAt"],
      include: [{
        model: Users,
        attributes: ["id", "full_name", "phone_no"],
        include: [{ model: Profile, attributes: ['image', 'verified'] }]
      }],
      order: [['createdAt', 'DESC']],
    });

    let likedRentalIds = new Set();
    if (req.user && req.user.userId) {
      const userLikes = await Progress.findAll({
        where: { user_id: req.user.userId, liked: true },
        attributes: ['rental_id']
      });
      likedRentalIds = new Set(userLikes.map(like => like.rental_id));
    }

    const rentalsWithLiked = rentals.map(rental => {
      const rentalData = rental.toJSON();
      return {
        ...rentalData,
        liked: likedRentalIds.has(rental.id),
        images: rentalData.images || [],
        videos: rentalData.videos || [],
        amenities: rentalData.amenities || [],
      };
    });

    return res.status(200).json({ success: true, message: "Rentals fetched successfully", data: rentalsWithLiked });
  } catch (error) {
    logger.error('Search rentals error', { error: error.message });
    return res.status(500).json({ success: false, message: "Server error" });
  }
}

// ─────────────────────────────────────────────
// GET /rental/recent  — most recent rentals (public)
// ─────────────────────────────────────────────
async function seeRecentRentals(req, res) {
  try {
    const { limit } = req.query;
    const parsedLimit = limit ? parseInt(limit, 10) : 10;

    const rentals = await Rentals.findAll({
      attributes: ["id", "slug", "title", "description", "propertyType", "location", "price", "priceType", "images", "status", "UserId", "createdAt"],
      include: [{
        model: Users,
        attributes: ["id", "full_name", "phone_no"],
        include: [{ model: Profile, attributes: ['image', 'verified'] }]
      }],
      order: [['createdAt', 'DESC']],
      limit: parsedLimit,
    });

    return res.status(200).json({ success: true, data: rentals, message: "Recent rentals retrieved successfully" });
  } catch (error) {
    logger.error('Error fetching recent rentals', { error: error.message });
    return res.status(500).json({ success: false, message: "Server error" });
  }
}

// ─────────────────────────────────────────────
// GET /rental/recommended  — recommended rentals for the user
// ─────────────────────────────────────────────
async function seeRecommendedRentals(req, res) {
  try {
    const { limit } = req.query;
    const parsedLimit = limit ? parseInt(limit, 10) : 10;

    // Simple recommendation: return available rentals ordered by likes (popular first)
    const rentals = await Rentals.findAll({
      where: { status: 'available' },
      attributes: ["id", "slug", "title", "description", "propertyType", "location", "price", "priceType", "images", "status", "UserId", "createdAt", "likesCount"],
      include: [{
        model: Users,
        attributes: ["id", "full_name", "phone_no"],
        include: [{ model: Profile, attributes: ['image', 'verified'] }]
      }],
      order: [['likesCount', 'DESC'], ['createdAt', 'DESC']],
      limit: parsedLimit,
    });

    return res.status(200).json({ success: true, data: rentals, message: "Recommended rentals retrieved successfully" });
  } catch (error) {
    logger.error('Error fetching recommended rentals', { error: error.message });
    return res.status(500).json({ success: false, message: "Server error" });
  }
}

module.exports = { addRental, seeAllRentals, getRental, updateRental, deleteRental, searchRentals, seeRecentRentals, seeRecommendedRentals };
