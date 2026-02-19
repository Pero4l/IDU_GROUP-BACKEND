const {Rentals, Users} = require("../models");
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

    if (!title || !description || !propertyType || !location || !price || !priceType) {
      return res.status(400).json({
        success: false,
        message: "Title, description, property type, location, price, and price type are required",
      });
    }

    if (req.user.role !== 'landlord' && req.user.role !== 'agent') {
      return res.status(403).json({
        success: false,
        message: "Only landlords and agents can add rentals"
      });
    }

    const newRental = {
      title,
      description,
      propertyType,
      location,
      price,
      priceType,
      status,
      images: JSON.stringify(images || []),
      UserId: req.user.id,
    };

    const rental = await Rentals.create(newRental);

    const rentalWithLandlord = await Rentals.findByPk(rental.id, {
      include: [{
        model: Users,
        attributes: ["id", "first_name", "last_name", "phone_no"]
      }]
    });

    return res.status(201).json({
      success: true,
      data: rentalWithLandlord,
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

// all user's both agnet, landlord, tenant can be able to see all apartment in the plartform
async function seeAllRentals(req, res) {
  try {
    const rentals = await Rentals.findAll({
      where,
      attributes: [
        "id", "title", "description", "propertyType", "location", "price", 
        "priceType", "images", "status", "UserId", "createdAt"
      ],
      include: [{
        model: Users,
        attributes: ["id", "first_name", "last_name", "phoneno"]
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
        attributes: ["id", "first_name", "last_name", "phone_no", "email"]
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
        images: rentalData.images ? JSON.parse(rentalData.images) : [],
        landlord: rentalData.Users || { first_name, last_name },
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
    const { title, description, propertyType, location, price, priceType, images, status } = req.body;

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
      images: images ? JSON.stringify(images) : rental.images,
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