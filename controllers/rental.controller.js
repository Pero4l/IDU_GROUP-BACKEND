const { Rentals, Users, Notifications, Profile, Progress } = require("../models");
const { notifySuperAdmins, logAndEmailUser } = require('./notification.controller');
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
      {
        folder,
        resource_type: type,
        public_id: uuidv4(),
      },
      (error, result) => {
        if (error) {
          console.error("Cloudinary Upload Error:", error);
          reject(error);
        } else {
          resolve(result);
        }
      }
    );

    stream.end(buffer);
  });
}


// only agnet/landlord can be able to add an apartment to the plartform
async function addRental(req, res) {
  try {
    const { title, description, propertyType, location, price, priceType, status, amenities, legalFee, cautionFee, brokeFee, mgtServiceCharge } = req.body;



    const images = req.files?.images || [];
    const videos = req.files?.videos || [];

    console.log("Files received:", req.files);

    if (!title || !description || !propertyType || !location || !price || !priceType || !status || !images ) {
      return res.status(400).json({
        success: false,
        message: "All fields are required, including images or videos",
      });
    }

    if (req.user.role !== 'landlord') {
      return res.status(403).json({
        success: false,
        message: "Only landlords can add rentals"
      });
    }

    // VALIDATION
    if (images.length && !videos.length && images.length > 10)
      return res.status(400).json({ success: false, message: "Max 10 images allowed" });

    if (videos.length && !images.length && videos.length > 4)
      return res.status(400).json({ success: false, message: "Max 4 videos allowed" });

    if (images.length && videos.length && (images.length > 4 || videos.length > 2))
      return res.status(400).json({
        success: false,
        message: "When uploading both, max is 4 images + 2 videos",
      });

    // UPLOAD IMAGES
    const uploadedImages = await Promise.all(
      images.map((img) =>
        uploadBufferToCloudinary(img.buffer, img.mimetype, "posts/images")
      )
    );

    // ---- UPLOAD VIDEOS ----
    const uploadedVideos = await Promise.all(
      videos.map((vid) =>
        new Promise((resolve, reject) => {
          const stream = cloudinary.uploader.upload_stream(
            {
              folder: "posts/videos",
              resource_type: "video",
              public_id: uuidv4(),
            },
            (error, result) => {
              if (error) {
                console.error("Video upload error:", error);
                reject(error);
              } else {
                resolve(result);
              }
            }
          );

          stream.end(vid.buffer);
        })
      )
    );


    

    let amenitiesData = [];
    if (amenities) {
      if (typeof amenities === 'string') {
        try {
          amenitiesData = JSON.parse(amenities);
        } catch (e) {
          if (amenities.includes(',')) {
            amenitiesData = amenities.split(',').map(item => item.trim());
          } else {
            amenitiesData = [amenities];
          }
        }
      } else if (Array.isArray(amenities)) {
        amenitiesData = amenities;
      }
    }

    const newRental = {
      title,
      description,
      propertyType,
      location,
      price,
      priceType,
      legalFee: legalFee || 0.00,
      cautionFee: cautionFee || 0.00,
      brokeFee: brokeFee || 0.00,
      mgtServiceCharge: mgtServiceCharge || 0.00,
      status,
      images: uploadedImages.map((i) => i.secure_url),
      videos: uploadedVideos.map((v) => v.secure_url),
      amenities: amenitiesData,
      UserId: req.user.userId,
    };

    const rental = await Rentals.create(newRental);

    // const rentalWithLandlord = await Rentals.findByPk(rental.id, {
    //   include: [{
    //     model: Users,
    //     attributes: ["id", "first_name", "last_name", "phone_no"]
    //   }]
    // });

    // Notification
    const landlord = await Users.findByPk(req.user.userId);
    await logAndEmailUser(req.user.userId, landlord?.email, "Rental Added", `Your rental ${title} has been added successfully to the platform`);
    await notifySuperAdmins(`New rental posted by user ${req.user.userId}: ${title}`, "rental");

    
    return res.status(201).json({
      success: true,
      message: "Rental property added successfully",
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({
      success: false,
      message: "Error adding rental",
      error: err.message,
    });
  }
}


async function seeAllRentals(req, res) {
  try {
    const where = {}; 

    const rentals = await Rentals.findAll({
      where,
      attributes: [
        "id", "slug", "title", "description", "propertyType", "location", "price",
        "priceType", "legalFee", "cautionFee", "brokeFee", "mgtServiceCharge", "images", "amenities", "status", "UserId", "createdAt"
      ],
      include: [{
        model: Users,
        attributes: ["id", "full_name", "phone_no"],
        include: [{ model: Profile, attributes: ['image', 'verified'] }]
      }],
      order: [['createdAt', 'DESC']],
    });

    if (!rentals || rentals.length === 0) {
      return res.status(404).json({
        success: false,
        message: "No rentals found",
      });
    }

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

    return res.status(200).json({
      success: true,
      data: rentalsWithLiked,
      message: "Rentals retrieved successfully",
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({
      success: false,
      message: "Server error",
    });
  }
}

// all user's both agnet, landlord, tenant can be able to see one apartment
async function getRental(req, res) {
  try {
    const { id } = req.params;

    const query = {
      attributes: [
        "id",
        "slug",
        "title",
        "description",
        "propertyType",
        "location",
        "price",
        "priceType",
        "legalFee",
        "cautionFee",
        "brokeFee",
        "mgtServiceCharge",
        "images",
        "videos",
        "amenities",
        "status",
        "UserId",
        "createdAt",
        "updatedAt"
      ],
      include: [{
        model: Users,
        attributes: ["id", "full_name", "phone_no"],
        include: [{ model: Profile, attributes: ['image', 'verified'] }]
      }]
    };

    // Check if ID is a valid UUID, otherwise search by slug
    const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
    let rental;
    if (isUUID) {
      rental = await Rentals.findByPk(id, query);
    } else {
      rental = await Rentals.findOne({
        where: { slug: id },
        ...query
      });
    }

    if (!rental) {
      return res.status(404).json({
        success: false,
        message: "Rental not found",
      });
    }

    const rentalData = rental.toJSON();

    let liked = false;
    if (req.user && req.user.userId) {
      const progressRecord = await Progress.findOne({
        where: { user_id: req.user.userId, rental_id: rental.id }
      });
      if (progressRecord && progressRecord.liked) {
        liked = true;
      }
    }

    return res.status(200).json({
      success: true,
      data: {
        ...rentalData,
        liked,
        // Sequelize handles JSON parsing for us
        images: rentalData.images || [],
        videos: rentalData.videos || [],
        amenities: rentalData.amenities || [],
        landlord: rentalData.Users || { full_name: "User" },
      },
      message: "Rental retrieved successfully",
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({
      success: false,
      message: "Server error",
      error: error.message,
    });
  }
}

// only agnet/landlord can be able to update an apartment
async function updateRental(req, res) {
  try {
    const { id } = req.params;
    const { title, description, propertyType, location, price, priceType, images, videos, status, amenities, legalFee, cautionFee, brokeFee, mgtServiceCharge } = req.body;

    const rental = await Rentals.findByPk(id);

    if (!rental) {
      return res.status(404).json({
        success: false,
        message: "Rental not found",
      });
    }
    
    if (rental.UserId !== req.user.userId || (req.user.role !== 'landlord')) {
      return res.status(403).json({
        success: false,
        message: "You are not authorized to update this rental",
      });
    }

    let amenitiesData = undefined;
    if (amenities !== undefined) {
      if (typeof amenities === 'string') {
        try {
          amenitiesData = JSON.parse(amenities);
        } catch (e) {
          if (amenities.includes(',')) {
            amenitiesData = amenities.split(',').map(item => item.trim());
          } else {
            amenitiesData = [amenities];
          }
        }
      } else if (Array.isArray(amenities)) {
        amenitiesData = amenities;
      }
    }

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

    if (updatedRental.User) {
        await logAndEmailUser(req.user.userId, updatedRental.User.email, "Rental Updated", `Your rental ${updatedRental.title} has been updated.`);
    }
    await notifySuperAdmins(`Rental ${id} was updated by user ${req.user.userId}`, "rental");

    return res.status(200).json({
      success: true,
      data: updatedRental,
      message: "Rental updated successfully",
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({
      success: false,
      message: "Server error",
      error: error.message,
    });
  }
}

// only agnet/landlord can be able to delete an apartment
async function deleteRental(req, res) {
  try {
    const { id } = req.params;

    const rental = await Rentals.findByPk(id);
    if (!rental) {
      return res.status(404).json({
        success: false,
        message: "Rental not found",
      });
    }

    if (rental.UserId !== req.user.userId || (req.user.role !== 'landlord' && req.user.role !== 'agent')) {
      return res.status(403).json({
        success: false,
        message: "You are not authorized to delete this rental",
      });
    }

    const rentalTitle = rental.title;
    await rental.destroy();

    const landlord = await Users.findByPk(req.user.userId);
    await logAndEmailUser(req.user.userId, landlord?.email, "Rental Deleted", `Your rental ${rentalTitle} has been deleted.`);
    await notifySuperAdmins(`Rental ${rentalTitle} was deleted by user ${req.user.userId}`, "rental");

    return res.status(200).json({
      success: true,
      message: "Rental deleted successfully",
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({
      success: false,
      message: "Server error",
      error: error.message,
    });
  }
}

async function searchRentals(req, res) {
  try {
    const { location } = req.query;
    if (!location) return res.status(400).json({ success: false, message: "Search location query parameter is required." });
    
    const rentals = await Rentals.findAll({
      where: {
        location: { [Op.iLike]: `%${location}%` }
      },
      attributes: [
        "id", "slug", "title", "description", "propertyType", "location", "price",
        "priceType", "legalFee", "cautionFee", "brokeFee", "mgtServiceCharge", "images", "amenities", "status", "UserId", "createdAt"
      ],
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
    console.error("Search error:", error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
}

async function seeRecentRentals(req, res) {
  try {
    const rentals = await Rentals.findAll({
      attributes: [
        "id", "slug", "title", "description", "propertyType", "location", "price",
        "priceType", "legalFee", "cautionFee", "brokeFee", "mgtServiceCharge", "images", "amenities", "status", "UserId", "createdAt"
      ],
      include: [{
        model: Users,
        attributes: ["id", "full_name", "phone_no"],
        include: [{ model: Profile, attributes: ['image', 'verified'] }]
      }],
      order: [['createdAt', 'DESC']],
      limit: 10
    });

    if (!rentals || rentals.length === 0) {
      return res.status(404).json({
        success: false,
        message: "No recent rentals found",
      });
    }

    // Optional user authentication to determine liked status
    let userId = null;
    const authHeader = req.headers["authorization"];
    if (authHeader) {
      const parts = authHeader.split(" ");
      if (parts.length === 2 && parts[0] === "Bearer") {
        try {
          const decoded = jwt.verify(parts[1], process.env.JWT_SECRET);
          userId = decoded.userId;
        } catch (err) {
          // Ignore invalid token verification errors for optional auth
        }
      }
    }

    let likedRentalIds = new Set();
    if (userId) {
      const userLikes = await Progress.findAll({
        where: { user_id: userId, liked: true },
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

    return res.status(200).json({
      success: true,
      data: rentalsWithLiked,
      message: "Recent rentals retrieved successfully",
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({
      success: false,
      message: "Server error",
    });
  }
}

async function seeRecommendedRentals(req, res) {
  try {
    const userId = req.user.userId;

    // 1. Fetch user to get their state or location
    const user = await Users.findByPk(userId, {
      include: [{ model: Profile, attributes: ['location'] }]
    });

    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    // Determine the search location: prefer user state, fallback to profile location, then Nigeria
    const state = user.state;
    const profileLocation = user.Profile?.location;
    const searchLocation = state || (profileLocation ? profileLocation.split(',')[0] : null) || 'Nigeria';

    // 2. Fetch all rentals matching this location (case-insensitive)
    const rentals = await Rentals.findAll({
      where: {
        location: { [Op.iLike]: `%${searchLocation.trim()}%` }
      },
      attributes: [
        "id", "slug", "title", "description", "propertyType", "location", "price",
        "priceType", "legalFee", "cautionFee", "brokeFee", "mgtServiceCharge", "images", "amenities", "status", "UserId", "createdAt"
      ],
      include: [{
        model: Users,
        attributes: ["id", "full_name", "phone_no"],
        include: [{ model: Profile, attributes: ['image', 'verified'] }]
      }],
      order: [['createdAt', 'DESC']],
    });

    // Determine liked status
    const userLikes = await Progress.findAll({
      where: { user_id: userId, liked: true },
      attributes: ['rental_id']
    });
    const likedRentalIds = new Set(userLikes.map(like => like.rental_id));

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

    return res.status(200).json({
      success: true,
      data: rentalsWithLiked,
      message: `Recommended rentals in ${searchLocation} retrieved successfully`,
    });
  } catch (error) {
    console.error("Recommended rentals error:", error);
    return res.status(500).json({ success: false, message: "Server error retrieving recommendations" });
  }
}

module.exports = {
  addRental,
  seeAllRentals,
  getRental,
  updateRental,
  deleteRental,
  searchRentals,
  seeRecentRentals,
  seeRecommendedRentals
};