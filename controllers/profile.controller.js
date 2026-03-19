const { Profile, Users, Rentals } = require('../models');
const cloudinary = require("cloudinary").v2;
const { v4: uuidv4 } = require("uuid");
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

// 1. Update User Profile
async function updateProfile(req, res) {
  try {
    const userId = req.user.userId;
    const { bio } = req.body;
    
    let profile = await Profile.findOne({ where: { user_id: userId } });
    
    if (!profile) {
      return res.status(404).json({ success: false, message: "Profile not found" });
    }

    let imageUrl = profile.image;
    let coverImageUrl = profile.coverImage;

    // We assume you are passing files through a middleware like multer: req.files
    // e.g., name fields for the inputs: 'profileImage' and 'coverImage'
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
      coverImage: coverImageUrl
    });

    return res.status(200).json({
      success: true,
      data: profile,
      message: "Profile updated successfully"
    });

  } catch (error) {
    console.error("Error updating profile:", error);
    return res.status(500).json({ success: false, message: "Server error", error: error.message });
  }
}

// 2. Get Single User and Their Rentals (if landlord)
async function getUserProfile(req, res) {
  try {
    const { id } = req.params; // Get ID of the user whose profile is being viewed

    // 1. Fetch User (ignoring password)
    const user = await Users.findByPk(id, {
      attributes: { exclude: ['password'] }
    });

    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    // 2. Fetch Profile details
    const profile = await Profile.findOne({ where: { user_id: id } });

    let responseData = {
      ...user.toJSON(),
      profile: profile || null
    };

    // 3. Optional: If user is a landlord, get all the apartments they posted
    if (user.role === 'landlord') {
      const posts = await Rentals.findAll({
        where: { UserId: id },
        order: [['createdAt', 'DESC']]
      });
      responseData.rentals = posts;
      responseData.totalListings = posts.length;
    }

    return res.status(200).json({
      success: true,
      data: responseData,
      message: "User profile retrieved successfully"
    });

  } catch (error) {
    console.error("Error fetching user profile:", error);
    return res.status(500).json({ success: false, message: "Server error", error: error.message });
  }
}

module.exports = {
  updateProfile,
  getUserProfile
};
