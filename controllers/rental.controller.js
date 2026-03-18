const { Rentals, Users, Notifications } = require("../models");
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
    const { title, description, propertyType, location, price, priceType, status } = req.body;



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


    

    const newRental = {
      title,
      description,
      propertyType,
      location,
      price,
      priceType,
      status,
      images: uploadedImages.map((i) => i.secure_url),
      videos: uploadedVideos.map((v) => v.secure_url),
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
    Notifications.create({
      user_id: req.user.userId,
      type: "rental",
      notification: `Your rental "${title}" has been successfully added to the platform!`,
      is_read: false
    });

    
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

    // Get total count of rentals
    const total = await Rentals.count({ where });

    const rentals = await Rentals.findAll({
      where,
      attributes: [
        "id", "title", "description", "propertyType", "location", "price",
        "priceType", "images", "status", "UserId", "createdAt"
      ],
      include: [{
        model: Users,
        attributes: ["id", "first_name", "last_name", "phone_no"]
      }],
      order: [['createdAt', 'DESC']],
    });

    if (total === 0) {
      return res.status(404).json({
        success: false,
        message: "No rentals found",
      });
    }

    return res.status(200).json({
      success: true,
      data: rentals,
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

    const rental = await Rentals.findByPk(id, {
      attributes: [
        "id",
        "title",
        "description",
        "propertyType",
        "location",
        "price",
        "priceType",
        "images",
        "status",
        "UserId",
        "createdAt",
        "updatedAt"
      ],
      include: [{
        model: Users,
        attributes: ["id", "first_name", "last_name", "phone_no"]
      }]
    });

    if (!rental) {
      return res.status(404).json({
        success: false,
        message: "Rental not found",
      });
    }

    const rentalData = rental.toJSON();

    return res.status(200).json({
      success: true,
      data: {
        ...rentalData,
        // Sequelize handles JSON parsing for us
        images: rentalData.images || [],
        videos: rentalData.videos || [],
        // landlord: rentalData.Users || { first_name: "", last_name: "User" },
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
    const { title, description, propertyType, location, price, priceType, images, videos, status } = req.body;

    const rental = await Rentals.findByPk(id);

    if (!rental) {
      return res.status(404).json({
        success: false,
        message: "Rental not found",
      });
    }

    if (rental.UserId !== req.user.id || (req.user.role !== 'landlord')) {
      return res.status(403).json({
        success: false,
        message: "You are not authorized to update this rental",
      });
    }

    await rental.update({
      title: title || rental.title,
      description: description || rental.description,
      propertyType: propertyType || rental.propertyType,
      location: location || rental.location,
      price: price || rental.price,
      priceType: priceType || rental.priceType,
      images: images || rental.images,
      videos: videos || rental.videos,
      status: status || rental.status,
    });

    const updatedRental = await Rentals.findByPk(id, {
      include: [{ model: Users, attributes: ["id", "first_name", "last_name"] }]
    });

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

    if (rental.UserId !== req.user.id || (req.user.role !== 'landlord' && req.user.role !== 'agent')) {
      return res.status(403).json({
        success: false,
        message: "You are not authorized to delete this rental",
      });
    }

    await rental.destroy();

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

module.exports = {
  addRental,
  seeAllRentals,
  getRental,
  updateRental,
  deleteRental
};