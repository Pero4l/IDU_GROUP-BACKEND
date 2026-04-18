const {Users, Notifications, Profile} = require('../models');
const { Op } = require('sequelize');
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const nodemailer = require("nodemailer");
require("dotenv").config();
const { OAuth2Client } = require('google-auth-library');
const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);
const { notifySuperAdmins } = require('./notification.controller');

// To generate a free test account automatically if env vars are missing:
let testAccount = null;

async function getTransporter() {
  if (process.env.EMAIL_USER && process.env.EMAIL_PASS) {
    // If user provided a real email, configure it dynamically properly
    return nodemailer.createTransport({
      service: process.env.EMAIL_HOST && process.env.EMAIL_HOST.includes('gmail') ? 'gmail' : undefined,
      host: process.env.EMAIL_HOST || 'smtp.ethereal.email',
      port: process.env.EMAIL_PORT ? parseInt(process.env.EMAIL_PORT) : 587,
      secure: process.env.EMAIL_PORT == '465' ? true : false,
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS,
      }
    });
  }
  
  if (!testAccount) {
    testAccount = await nodemailer.createTestAccount();
  }
  
  return nodemailer.createTransport({
    host: "smtp.ethereal.email",
    port: 587,
    secure: false,
    auth: {
      user: testAccount.user,
      pass: testAccount.pass,
    },
  });
}

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
    

    // SEND WELCOME EMAIL
    try {
      const mailer = await getTransporter();
     const mailOptions = {
  from: '"RentULO Team" <no-reply@rentulo.com>',
  to: email,
  subject: 'Welcome to RentULO 🎉',

  text: `Hi ${first_name},

Welcome to RentULO!

Your account has been successfully created. We're excited to have you join our platform.

You can now explore listings, manage your rentals, and enjoy a seamless experience.

If you have any questions, feel free to reach out to our support team anytime.

Best regards,  
The RentULO Team
`,

  html: `
  <div style="font-family: Arial, sans-serif; background-color: #f9fafb; padding: 20px;">
    <div style="max-width: 600px; margin: auto; background: #ffffff; border-radius: 10px; padding: 30px; box-shadow: 0 4px 10px rgba(0,0,0,0.05);">
      
      <h2 style="color: #111827;">Welcome to RentULO, ${first_name} ${last_name}👋</h2>
      
      <p style="color: #4b5563; font-size: 15px; line-height: 1.6;">
        Your account has been successfully created. We're excited to have you on board and can't wait for you to start exploring everything RentULO has to offer.
      </p>

      <p style="color: #4b5563; font-size: 15px; line-height: 1.6;">
        With RentULO, you can easily browse listings, manage your rentals, and enjoy a smooth, secure experience.
      </p>

      <div style="text-align: center; margin: 30px 0;">
        <a href="https://rentulo.com/dashboard" 
           style="background-color: #111827; color: #ffffff; padding: 12px 20px; text-decoration: none; border-radius: 6px; font-size: 14px;">
          Go to Dashboard
        </a>
      </div>

      <p style="color: #6b7280; font-size: 13px;">
        If you have any questions, feel free to contact our support team anytime.
      </p>

      <hr style="margin: 30px 0; border: none; border-top: 1px solid #e5e7eb;" />

      <p style="color: #9ca3af; font-size: 12px; text-align: center;">
        © ${new Date().getFullYear()} RentULO. All rights reserved.
      </p>

    </div>
  </div>
  `,
};

      const info = await mailer.sendMail(mailOptions);
      console.log("Welcome email sent: %s", info.messageId);
      
      const previewUrl = nodemailer.getTestMessageUrl(info);
      if (previewUrl) {
        console.log("Welcome email Preview URL: %s", previewUrl);
      }
    } catch (mailError) {
      // Log the error but don't stop the registration process
      console.error("Failed to send welcome email:", mailError);
    }
    
    // Broadcast notification to Super Admins
    await notifySuperAdmins(`New user registered: ${first_name} ${last_name} (${role})`, 'system');

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

    // Setup mailer and send OTP
    const mailer = await getTransporter();
    
    const mailOptions = {
      from: '"RentULO Security" <no-reply@rentulo.com>',
      to: email,
      subject: 'Password Reset OTP',
      text: `Your password reset OTP is ${otpCode}. It expires in 15 minutes.`,
      html: `<p>Your password reset OTP is <b>${otpCode}</b>. It expires in 15 minutes.</p>`,
    };

    
    const info = await mailer.sendMail(mailOptions);
    console.log("Message sent: %s", info.messageId);
    
    // Preview URL is available when using Ethereal mail
    const previewUrl = nodemailer.getTestMessageUrl(info);
    if (previewUrl) {
      console.log("Preview URL: %s", previewUrl);
    }

    return res.status(200).json({
      success: true,
      message: "OTP sent to email successfully",
      testMailUrl: previewUrl || null 
    });

  } catch (error) {
    console.error("Forgot password error:", error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
}

async function confirmOtp(req, res) {
  try {
    const { email, otpCode } = req.body;
    if (!email || !otpCode) {
      return res.status(400).json({ success: false, message: "Email and OTP code are required" });
    }

    const user = await Users.findOne({ where: { email } });
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    if (user.otpCode !== parseInt(otpCode)) {
      return res.status(400).json({ success: false, message: "Invalid OTP code" });
    }

    if (new Date() > new Date(user.otpExpiresAt)) {
      return res.status(400).json({ success: false, message: "OTP code has expired" });
    }

    return res.status(200).json({
      success: true,
      message: "OTP is correct. You may proceed to change your password."
    });
  } catch (error) {
    console.error("Confirm OTP error:", error);
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

async function googleAuth(req, res) {
  try {
    const { idToken } = req.body;
    if (!idToken) return res.status(400).json({ success: false, message: "idToken is required" });

    const ticket = await googleClient.verifyIdToken({
      idToken,
      audience: process.env.GOOGLE_CLIENT_ID
    });
    const payload = ticket.getPayload();
    const { email, given_name, family_name } = payload;

    let user = await Users.findOne({ where: { email } });
    
    if (!user) {
      // Create user if they don't exist
      const randomPassword = Math.random().toString(36).slice(-8) + "Aa1@";
      const hashedPassword = await bcrypt.hash(randomPassword, 12);
      
      user = await Users.create({
        first_name: given_name || "Google",
        last_name: family_name || "User",
        email,
        password: hashedPassword,
        // Optional fields left empty to enforce profile completion
        gender: null,
        phone_no: null,
        address: null,
        state: null,
        country: "Nigeria", // default
      });

      await Notifications.create({
        user_id: user.id,
        type: "account",
        notification: `Welcome to RentUIO ${user.first_name} ${user.last_name}! Your account has been successfully created via Google.`,
        is_read: false
      });

      await Profile.create({
        user_id: user.id,
        bio: null || 'Hey I am a verified user at RentULO',
        verified: false
      });

      await notifySuperAdmins(`New user registered via Google: ${user.first_name} ${user.last_name} (tenant)`, 'system');
    }

    const token = jwt.sign(
      {
        userId: user.id,
        currentUser: `${user.first_name} ${user.last_name}`,
        location: user.state ? `${user.state}, ${user.country}` : 'Not fully set',
        role: `${user.role}`,
        email: `${user.email}`
      },
      process.env.JWT_SECRET,
      { expiresIn: "24h" }
    );

    // Return standard 200 OK since the auth was successful.
    return res.status(200).json({
      success: true,
      message: "Google Auth Successful",
      token: token,
      role: user.role
    });

  } catch (error) {
    console.error("Google Auth error:", error);
    return res.status(500).json({ success: false, message: "Server error during Google auth" });
  }
}

module.exports = {register, login, searchUsers, forgotPassword, confirmOtp, resetPassword, googleAuth}