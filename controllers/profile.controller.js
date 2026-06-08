const { Profile, Users, Rentals, Progress, Inspections } = require('../models');
const cloudinary = require("cloudinary").v2;
const { v4: uuidv4 } = require("uuid");
const { Op } = require('sequelize');
const logger = require('../utils/logger');
require("dotenv").config();

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure: true
});


// Upload from buffer
function uploadBufferToCloudinary(buffer, mimetype, folder) {
  return new Promise((resolve, reject) => {
    const type = mimetype.startsWith("video") ? "video" : "image";

    const stream = cloudinary.uploader.upload_stream(
      {
        folder,
        resource_type: type,
        public_id: uuidv4(),
      },
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

// ─────────────────────────────────────────────────────────────
// PUT /profile/update
// ─────────────────────────────────────────────────────────────
async function updateProfile(req, res) {
  try {
    const userId = req.user.userId;
    const { bio, phone_no, state, address } = req.body;
    
    let profile = await Profile.findOne({ where: { user_id: userId } });
    if (!profile) {
      return res.status(404).json({ success: false, message: "Profile not found" });
    }

    let user = await Users.findByPk(userId);
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    // Update user details if supplied
    if (phone_no !== undefined) user.phone_no = phone_no;
    if (state !== undefined) user.state = state;
    if (address !== undefined) user.address = address;

    // Check if profile is complete
    const isCompleted = !!(user.phone_no && user.state && user.address);
    if (isCompleted) {
      user.is_verified = true;
    }
    await user.save();

    let imageUrl = profile.image;
    let coverImageUrl = profile.coverImage;

    const profileImages = req.files?.profileImage || [];
    const coverImages = req.files?.coverImage || [];

    if (profileImages.length > 0) {
      const img = profileImages[0];
      const result = await uploadBufferToCloudinary(img.buffer, img.mimetype, "profiles/images");
      imageUrl = result.secure_url;
    }

    if (coverImages.length > 0) {
      const img = coverImages[0];
      const result = await uploadBufferToCloudinary(img.buffer, img.mimetype, "profiles/covers");
      coverImageUrl = result.secure_url;
    }

    await profile.update({
      bio: bio || profile.bio,
      image: imageUrl,
      coverImage: coverImageUrl,
      phone: user.phone_no,
      address: user.address,
      location: user.state ? `${user.state}, ${user.country || 'Nigeria'}` : profile.location,
      verified: isCompleted ? true : profile.verified
    });

    logger.info('Profile updated', { userId });

    return res.status(200).json({
      success: true,
      message: isCompleted 
        ? "Profile updated and verified successfully." 
        : "Profile updated successfully.",
      user: {
        is_verified: user.is_verified
      }
    });

  } catch (error) {
    logger.error('Error updating profile', { error: error.message, userId: req.user?.userId });
    return res.status(500).json({ success: false, message: "Server error", error: error.message });
  }
}

// ─────────────────────────────────────────────────────────────
// GET /profile/get1/:id
// Returns profile data with role-specific sections:
//
//  TENANT  → locked houses, upcoming inspections, rental history
//  LANDLORD → rented-out houses, houses locked by tenants
//             (with tenant name), upcoming inspections
// ─────────────────────────────────────────────────────────────
async function getUserProfile(req, res) {
  try {
    const { id } = req.params;

    // 1. Fetch user (no password / email)
    const user = await Users.findByPk(id, {
      attributes: { exclude: ['password', 'email'] },
      include: [{ model: Profile }]
    });

    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    // 2. Fetch profile details
    const profile = await Profile.findOne({ where: { user_id: id } });

    const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD

    let responseData = {
      ...user.toJSON(),
      profile: profile || null,
    };
    delete responseData.Profile;

    // ────────────────────────────────────────
    // TENANT PROFILE
    // ────────────────────────────────────────
    if (user.role === 'tenant') {

      // Houses the tenant has locked (interest/hold)
      const lockedProgress = await Progress.findAll({
        where: { user_id: id, locked: true },
        include: [
          {
            model: Rentals,
            attributes: ['id', 'slug', 'title', 'location', 'price', 'priceType', 'images', 'status'],
          },
        ],
      });
      responseData.lockedHouses = lockedProgress.map((p) => p.Rentals).filter(Boolean);

      // Upcoming inspections (today or in the future)
      const upcomingInspections = await Inspections.findAll({
        where: {
          user_id: id,
          date: { [Op.gte]: today },
        },
        include: [
          {
            model: Rentals,
            as: 'rental',
            attributes: ['id', 'slug', 'title', 'location', 'price', 'priceType', 'images', 'status'],
          },
        ],
        order: [
          ['date', 'ASC'],
          ['time', 'ASC'],
        ],
      });
      responseData.upcomingInspections = upcomingInspections;

      // Rental history — rentals the tenant has booked (active or past)
      const rentalHistory = await Progress.findAll({
        where: { user_id: id, booked: true },
        include: [
          {
            model: Rentals,
            attributes: ['id', 'slug', 'title', 'location', 'price', 'priceType', 'images', 'status'],
            include: [
              {
                model: Users,
                attributes: ['id', 'first_name', 'last_name', 'phone_no'],
                include: [{ model: Profile, attributes: ['image', 'verified'] }],
              },
            ],
          },
        ],
        order: [['createdAt', 'DESC']],
      });
      responseData.rentalHistory = rentalHistory.map((p) => p.Rentals).filter(Boolean);
    }

    // ────────────────────────────────────────
    // LANDLORD PROFILE
    // ────────────────────────────────────────
    else if (user.role === 'landlord') {

      // All rentals this landlord owns
      const allListings = await Rentals.findAll({
        where: { UserId: id },
        attributes: ['id', 'slug', 'title', 'location', 'price', 'priceType', 'images', 'status', 'createdAt'],
        order: [['createdAt', 'DESC']],
      });

      // Rented-out houses (status === 'rented')
      responseData.rentedOutHouses = allListings.filter((r) => r.status === 'rented');
      responseData.totalListings = allListings.length;
      responseData.rentals = allListings;

      // Houses locked by tenants — include the tenant's name
      const rentalIds = allListings.map((r) => r.id);

      let lockedByTenants = [];
      if (rentalIds.length > 0) {
        const lockedProgress = await Progress.findAll({
          where: {
            rental_id: { [Op.in]: rentalIds },
            locked: true,
          },
          include: [
            {
              model: Rentals,
              attributes: ['id', 'slug', 'title', 'location', 'price', 'priceType', 'images', 'status'],
            },
            {
              model: Users,
              attributes: ['id', 'first_name', 'last_name', 'phone_no'],
              include: [{ model: Profile, attributes: ['image', 'verified'] }],
            },
          ],
        });

        lockedByTenants = lockedProgress.map((p) => ({
          rental: p.Rentals,
          tenant: p.Users
            ? {
                id: p.Users.id,
                name: `${p.Users.first_name} ${p.Users.last_name}`.trim(),
                phone_no: p.Users.phone_no,
                profile: p.Users.Profile || null,
              }
            : null,
        }));
      }
      responseData.lockedByTenants = lockedByTenants;

      // Upcoming inspections on any of the landlord's rentals
      let upcomingInspections = [];
      if (rentalIds.length > 0) {
        upcomingInspections = await Inspections.findAll({
          where: {
            rental_id: { [Op.in]: rentalIds },
            date: { [Op.gte]: today },
          },
          include: [
            {
              model: Rentals,
              as: 'rental',
              attributes: ['id', 'slug', 'title', 'location'],
            },
            {
              model: Users,
              as: 'tenant',
              attributes: ['id', 'first_name', 'last_name', 'phone_no'],
              include: [{ model: Profile, attributes: ['image'] }],
            },
          ],
          order: [
            ['date', 'ASC'],
            ['time', 'ASC'],
          ],
        });
      }
      responseData.upcomingInspections = upcomingInspections;
    }

    logger.info('Profile retrieved', { targetUserId: id, requestedBy: req.user?.userId });

    return res.status(200).json({
      success: true,
      data: responseData,
      message: "User profile retrieved successfully"
    });

  } catch (error) {
    logger.error('Error fetching user profile', { error: error.message, userId: req.user?.userId });
    return res.status(500).json({ success: false, message: "Server error", error: error.message });
  }
}

module.exports = {
  updateProfile,
  getUserProfile
};
