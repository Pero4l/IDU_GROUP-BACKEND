const {Users, Notifications, Profile} = require('../models');
const { Op } = require('sequelize');
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
require("dotenv").config();


async function register(req, res) {
  try {
    
    const {
      first_name,
      last_name,
      gender,
      role,
      phone_no,
      email,
      address,
      state,
      password,
    } = req.body;

    if (
      !first_name ||
      !last_name ||
      !gender ||
      !role ||
      !phone_no ||
      !address ||
      !state ||
      !email ||
      !password
    ) {
      return res.status(400).json({ message: "All fields are required" });
    }

    if (password.length < 6) {
      return res.status(400).json({ message: "Password must be at least 6 characters" });
    } else if (!/[A-Z]/.test(password) || !/[a-z]/.test(password)) {
      return res.status(400).json({ message: "Password must contain both uppercase and lowercase letters" });
    } else if (!/[0-9]/.test(password)) {
      return res.status(400).json({ message: "Password must contain a number" });
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ message: "Invalid email format" });
    } else if (first_name.length < 3 || last_name.length < 3) {
      return res.status(400).json({ message: "Name must be at least 3 characters" });
    }

    const existingUser = await Users.findOne({ where: { email } });
    if (existingUser) {
      return res.status(400).json({ success: false, message: "User already exists" });
    }

    const hashedPassword = await bcrypt.hash(password, 12);

    const country = "Nigeria";
    

    await Users.create({
      first_name,
      last_name,
      gender,
      role,
      email,
      phone_no,
      address,
      state,
      country,
      password: hashedPassword,
    });


    // HANDLE NOTIFICATION
    const isUser = await Users.findOne({ where: { email } });
    if (isUser) {

      await Notifications.create({
        user_id: isUser.id,
        type: "account",
        notification: `Welcome to RentUIO ${isUser.first_name} ${isUser.last_name}! Your account has been successfully created.`,
        is_read: false
      })
      
    }

    // HANDLE PROFILE CREATION
    let location =  `${state}, ${country}`
    let share = `main/${phone_no}`
    const user = await Users.findOne({ where: { email } });
    if (user) {

      await Profile.create({
        user_id: user.id, 
        bio: null || 'Hey i\'m a verified user at RentULO',
        phone: phone_no,
        address: address,
        location: location,
        verified: false,
        // share_account: share,
      });
    }
    

    return res.status(201).json({
      success: true,
      message: "Account registered successfully",
    });

  } catch (error) {
    console.error(error);
    return res.status(500).json({
      success: false,
      message: "Server error",
    });
  }
}


async function login(req, res) {
  try {
    const token = jwt.sign(
      {
        userId: req.data.id,
        currentUser: `${req.data.first_name} ${req.data.last_name}`,
        location: `${req.data.state}, ${req.data.country}`,
        role: `${req.data.role}`,
        email: `${req.data.email}`
      },
      process.env.JWT_SECRET,
      { expiresIn: "24h" }
    );

    const role = req.data.role;

    if (req.user) {
      return res.status(200).json({
        success: true,
        message: "Login Successfully",
        token: token,
        role: role,
      });
    }
  } catch (error) {
    console.error("Login error:", error);
    return res.status(500).json({
      success: false,
      message: "Server error during login",
    });
  }
}


async function searchUsers(req, res) {
  try {
    const { name } = req.query;
    if (!name) return res.status(400).json({ success: false, message: "Search name query parameter is required." });
    
    const users = await Users.findAll({
      where: {
        [Op.or]: [
          { first_name: { [Op.iLike]: `%${name}%` } },
          { last_name: { [Op.iLike]: `%${name}%` } },
          { email: { [Op.iLike]: `%${name}%` } }
        ]
      },
      attributes: ['id', 'first_name', 'last_name', 'email', 'role'],
      include: [{ model: Profile, attributes: ['image', 'verified'] }]
    });

    return res.status(200).json({ success: true, message: "Users fetched successfully", data: users });
  } catch (error) {
    console.error("Search error:", error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
}


async function forgotPassword(req, res) {
  try {
    const { email } = req.body;
    if (!email) {
      return res.status(400).json({ success: false, message: "Email is required" });
    }

    const user = await Users.findOne({ where: { email } });
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    // Generate a 6-digit OTP
    const otpCode = Math.floor(100000 + Math.random() * 900000);
    // Set expiration to 15 minutes from now
    const otpExpiresAt = new Date(Date.now() + 15 * 60 * 1000);

    user.otpCode = otpCode;
    user.otpExpiresAt = otpExpiresAt;
    await user.save();

    // In a real application, send the OTP via email or SMS.
    // Given we don't have a mailer configured, we return it in the response for testing.
    return res.status(200).json({
      success: true,
      message: "OTP generated successfully",
      data: {
        otpCode // Returning it so we can test the reset endpoint easily
      }
    });

  } catch (error) {
    console.error("Forgot password error:", error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
}

async function resetPassword(req, res) {
  try {
    const { email, otpCode, newPassword } = req.body;
    if (!email || !otpCode || !newPassword) {
      return res.status(400).json({ success: false, message: "Email, OTP code, and new password are required" });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({ success: false, message: "Password must be at least 6 characters" });
    } else if (!/[A-Z]/.test(newPassword) || !/[a-z]/.test(newPassword)) {
      return res.status(400).json({ success: false, message: "Password must contain both uppercase and lowercase letters" });
    } else if (!/[0-9]/.test(newPassword)) {
      return res.status(400).json({ success: false, message: "Password must contain a number" });
    }

    const user = await Users.findOne({ where: { email } });
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    // Verify OTP
    if (user.otpCode !== parseInt(otpCode)) {
      return res.status(400).json({ success: false, message: "Invalid OTP code" });
    }

    // Check expiration
    if (new Date() > new Date(user.otpExpiresAt)) {
      return res.status(400).json({ success: false, message: "OTP code has expired" });
    }

    // Hash the new password
    const hashedPassword = await bcrypt.hash(newPassword, 12);
    user.password = hashedPassword;
    
    // Clear the OTP fields
    user.otpCode = null;
    user.otpExpiresAt = null;
    await user.save();

    return res.status(200).json({
      success: true,
      message: "Password reset successful"
    });

  } catch (error) {
    console.error("Reset password error:", error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
}

module.exports = {register, login, searchUsers, forgotPassword, resetPassword}