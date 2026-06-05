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
    console.error("Error updating profile:", error);
    return res.status(500).json({ success: false, message: "Server error", error: error.message });
  }
}

// 2. Get Single User and Their Rentals (if landlord)
async function getUserProfile(req, res) {
  try {
    const { id } = req.params; // Get ID of the user whose profile is being viewed

    // 1. Fetch User along with their Profile in a single consolidated query (ignoring password and email)
    const user = await Users.findByPk(id, {
      attributes: { exclude: ['password', 'email'] },
      include: [{ model: Profile }]
    });

    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    const userData = user.toJSON();
    let responseData = {
      ...userData,
      profile: userData.Profile || null,
    };
    delete responseData.Profile;

  
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
