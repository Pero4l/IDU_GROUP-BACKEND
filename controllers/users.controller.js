const {
  Users,
  Notifications,
  Profile,
  PendingRegistrations,
} = require("../models");
const { Op } = require("sequelize");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
require("dotenv").config();
const { OAuth2Client } = require("google-auth-library");
const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);
const { notifySuperAdmins, logAndEmailUser } = require('./notification.controller');
const { sendEmail } = require('../utils/mailer');
const { buildEmailShell, buildCodeBadge, buildActionButton } = require('../utils/emailTemplates');
const { withTransaction } = require('../utils/rollback');
const { createWalletForUser } = require('../utils/wallet');
const logger = require('../utils/logger');


async function register(req, res) {
  try {
    const {
      gender,
      role,
      email,
      password,
    } = req.body;

    const full_name = (req.body.full_name || `${req.body.first_name || ''} ${req.body.last_name || ''}`).trim();

    if (
      !full_name ||
      !gender ||
      !role ||
      !email ||
      !password
    ) {
      return res.status(400).json({ message: "All fields are required" });
    }

    if (password.length < 8) {
      return res.status(400).json({ message: "Password must be at least 8 characters" });
    } else if (!/[A-Z]/.test(password) || !/[a-z]/.test(password)) {
      return res.status(400).json({ message: "Password must contain both uppercase and lowercase letters" });
    } else if (!/[0-9]/.test(password)) {
      return res.status(400).json({ message: "Password must contain a number" });
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ message: "Invalid email format" });
    } else if (full_name.length < 5) {
      return res.status(400).json({ message: "Name must be at least 5 characters" });
    }

    const existingUser = await Users.findOne({ where: { email } });
    if (existingUser) {
      return res.status(400).json({ success: false, message: "User already exists" });
    }

    const hashedPassword = await bcrypt.hash(password, 12);

    // Generate a 6-digit OTP code and set expiry to 15 minutes from now
    const otpCode = crypto.randomInt(100000, 999999);
    const otpExpiresAt = new Date(Date.now() + 15 * 60 * 1000);

    // Delete any stale pending signup for the same email
    await PendingRegistrations.destroy({ where: { email } });

    // Store details temporarily
    await PendingRegistrations.create({
      full_name,
      email,
      gender,
      role,
      password: hashedPassword,
      otpCode,
      otpExpiresAt
    });

    // Send OTP Verification Email
    let previewUrl = null;
    try {
      const verifyRegisterHtml = buildEmailShell({
        eyebrow: 'Account verification',
        heading: 'Verify your email address',
        bodyHtml: `
          <p style="margin:0;">Thanks for starting your registration on RentULO. Enter the 6-digit code below to verify your email and complete your sign-up:</p>
          ${buildCodeBadge(otpCode)}
          <p style="margin:0 0 8px;color:#d93025;font-weight:500;">This code expires in 15 minutes.</p>
          <p style="margin:0;color:#5f6368;">If you didn't request this, you can safely ignore this email.</p>
        `,
      });

      previewUrl = await sendEmail(
        email,
        'RentULO Account Verification OTP',
        `Hello ${full_name},\n\nYour OTP for registration is ${otpCode}. It is valid for 15 minutes.\n\nBest regards,\nThe RentULO Team`,
        verifyRegisterHtml
      );
    } catch (mailError) {
      console.error("Failed to send verification email:", mailError);
    }

    return res.status(200).json({
      success: true,
      message: "Verification OTP code sent to your email. Please verify to complete registration.",
      ...(process.env.NODE_ENV !== "production" && previewUrl ? { testMailUrl: previewUrl } : {}),
    });

  } catch (error) {
    console.error(error);
    return res.status(500).json({
      success: false,
      message: "Server error",
    });
  }
}

async function verifyRegistration(req, res) {
  try {
    const { email, otpCode } = req.body;
    if (!email || !otpCode) {
      return res
        .status(400)
        .json({ success: false, message: "Email and OTP code are required" });
    }

    const pending = await PendingRegistrations.findOne({ where: { email } });
    if (!pending) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid or expired OTP code" });
    }

    // Timing-safe OTP comparison
    const otpString = String(otpCode);
    const storedOtpString = String(pending.otpCode);
    if (otpString.length !== storedOtpString.length ||
        !crypto.timingSafeEqual(Buffer.from(otpString), Buffer.from(storedOtpString))) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid or expired OTP code" });
    }

    if (new Date() > new Date(pending.otpExpiresAt)) {
      return res
        .status(400)
        .json({ success: false, message: "OTP code has expired" });
    }

    // Move from pending to actual users
    const country = "Nigeria";
    const newUser = await withTransaction(async (t) => {
      const user = await Users.create(
        {
          full_name: pending.full_name,
          gender: pending.gender,
          role: pending.role,
          email: pending.email,
          password: pending.password,
          country,
          is_verified: true,
        },
        { transaction: t }
      );

      await Notifications.create(
        {
          user_id: user.id,
          type: "account",
          notification: `Welcome to RentULO ${user.full_name}! Your account has been successfully created.`,
          is_read: false,
        },
        { transaction: t }
      );

      await Profile.create(
        {
          user_id: user.id,
          bio: "Hey I'm a verified user at RentULO",
          verified: false,
        },
        { transaction: t }
      );

      // Remove the pending registration
      await createWalletForUser(user, t);

      await pending.destroy({ transaction: t });

      return user;
    }, { context: 'verifyRegistration', email });

    await notifySuperAdmins(
      `New user registered: ${newUser.full_name} (${newUser.role})`,
      "system"
    );

    logger.info("User registered via OTP verification", { userId: newUser.id, email });

    return res.status(201).json({
      success: true,
      message: "Account verified and registered successfully. You can now login.",
    });
  } catch (error) {
    logger.error("verifyRegistration failed", { email: req.body?.email, error: error.message });
    return res.status(500).json({
      success: false,
      message: "Registration verification failed. Please try again.",
    });
  }
}

async function login(req, res) {
  try {
    const token = jwt.sign(
      {
        userId: req.data.id,
        currentUser: req.data.full_name,
        location: `${req.data.state}, ${req.data.country}`,
        role: `${req.data.role}`,
        email: `${req.data.email}`,
      },
      process.env.JWT_SECRET,
      { expiresIn: "24h" },
    );

    const role = req.data.role;
    const id = req.data.id;

    if (req.user) {
      const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || req.ip || 'Unknown';
      const userAgent = req.headers['user-agent'] || 'Unknown';
      const loginTime = new Date().toLocaleString('en-US', { timeZone: 'Africa/Lagos', hour12: true }) + ' (Lagos Time)';
      const location = req.data.state && req.data.country ? `${req.data.state}, ${req.data.country}` : 'Nigeria';

      const loginHtml = buildEmailShell({
        eyebrow: 'Security alert',
        heading: 'New login detected',
        bodyHtml: `
          <p style="margin:0 0 16px;">Hello <strong>${req.data.full_name || 'User'}</strong>,</p>
          <p style="margin:0;">A successful login to your RentULO account was just detected. Please review the details below to verify it was you:</p>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e8eaed;border-radius:4px;margin:20px 0;">
            <tr><td style="padding:14px 16px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:14px;">
                <tr>
                  <td style="padding:6px 0;font-weight:600;color:#5f6368;width:110px;">Date & time</td>
                  <td style="padding:6px 0;color:#202124;">${loginTime}</td>
                </tr>
                <tr>
                  <td style="padding:6px 0;font-weight:600;color:#5f6368;">IP address</td>
                  <td style="padding:6px 0;color:#202124;font-family:monospace;">${ip}</td>
                </tr>
                <tr>
                  <td style="padding:6px 0;font-weight:600;color:#5f6368;">Device</td>
                  <td style="padding:6px 0;color:#202124;font-size:13px;">${userAgent}</td>
                </tr>
                <tr>
                  <td style="padding:6px 0;font-weight:600;color:#5f6368;">Location</td>
                  <td style="padding:6px 0;color:#202124;">${location}</td>
                </tr>
              </table>
            </td></tr>
          </table>
          <p style="margin:0;color:#5f6368;">If this was you, no action is needed. If you don't recognize this login, please reset your password immediately to secure your account.</p>
        `,
      });

      await logAndEmailUser(
        req.data.id,
        req.data.email,
        "New Login Alert",
        loginHtml,
      );

      const cookieOptions = {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "strict",
        path: "/",
        maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days in milliseconds
      };

      res.cookie("token", token, cookieOptions);
      res.cookie("userRole", role, cookieOptions);

      return res.status(200).json({
        success: true,
        message: "Login Successfully",
        token:token,
        role: role,
        id: id,
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
    if (!name)
      return res
        .status(400)
        .json({
          success: false,
          message: "Search name query parameter is required.",
        });

    const users = await Users.findAll({
      where: {
        [Op.or]: [
          { full_name: { [Op.iLike]: `%${name}%` } },
          { email: { [Op.iLike]: `%${name}%` } },
        ],
      },
      attributes: ["id", "full_name", "email", "role"],
      include: [{ model: Profile, attributes: ["image", "verified"] }],
    });

    return res
      .status(200)
      .json({
        success: true,
        message: "Users fetched successfully",
        data: users,
      });
  } catch (error) {
    console.error("Search error:", error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
}

async function forgotPassword(req, res) {
  try {
    const { email } = req.body;
    if (!email) {
      return res
        .status(400)
        .json({ success: false, message: "Email is required" });
    }

    const user = await Users.findOne({ where: { email } });
    if (!user) {
      // Return success even if user not found to prevent email enumeration
      return res.status(404).json({
        success: true, 
        message: "No account exist with this email." 
      })
    } else {
      // Generate a 6-digit OTP using cryptographically secure random
      const otpCode = crypto.randomInt(100000, 999999);
      // Set expiration to 15 minutes from now
      const otpExpiresAt = new Date(Date.now() + 15 * 60 * 1000);

      user.otpCode = otpCode;
      user.otpExpiresAt = otpExpiresAt;
      await user.save();

      // Setup mailer and send OTP
      let previewUrl = null;
      try {
        const resetOtpHtml = buildEmailShell({
          eyebrow: 'Password reset',
          heading: 'Reset your password',
          bodyHtml: `
            <p style="margin:0;">We received a request to reset the password for your RentULO account. Enter the 6-digit code below to continue:</p>
            ${buildCodeBadge(otpCode)}
            <p style="margin:0 0 8px;color:#d93025;font-weight:500;">This code expires in 15 minutes.</p>
            <p style="margin:0;color:#5f6368;">If you didn't request a password reset, you can safely ignore this email — your password won't be changed.</p>
          `,
        });

        previewUrl = await sendEmail(
          email,
          "Password Reset OTP",
          `Your password reset OTP is ${otpCode}. It expires in 15 minutes.`,
          resetOtpHtml,
        );
      } catch (mailError) {
        console.error("Forgot password email error:", mailError);
      }

      return res.status(200).json({
        success: true,
        message: "OTP sent to email successfully",
        ...(process.env.NODE_ENV !== "production" && previewUrl ? { testMailUrl: previewUrl } : {}),
      });
    }

  } catch (error) {
    console.error("Forgot password error:", error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
}

async function confirmOtp(req, res) {
  try {
    const { email, otpCode } = req.body;
    if (!email || !otpCode) {
      return res
        .status(400)
        .json({ success: false, message: "Email and OTP code are required" });
    }

    const user = await Users.findOne({ where: { email } });
    if (!user) {
      // Return generic message to prevent email enumeration
      return res
        .status(400)
        .json({ success: false, message: "Invalid or expired OTP code" });
    }

    // Timing-safe OTP comparison
    const otpString = String(otpCode);
    const storedOtpString = String(user.otpCode);
    if (otpString.length !== storedOtpString.length ||
        !crypto.timingSafeEqual(Buffer.from(otpString), Buffer.from(storedOtpString))) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid or expired OTP code" });
    }

    if (new Date() > new Date(user.otpExpiresAt)) {
      return res
        .status(400)
        .json({ success: false, message: "OTP code has expired" });
    }

    return res.status(200).json({
      success: true,
      message: "OTP is correct. You may proceed to change your password.",
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
      return res
        .status(400)
        .json({
          success: false,
          message: "Email, OTP code, and new password are required",
        });
    }

    if (newPassword.length < 8) {
      return res
        .status(400)
        .json({
          success: false,
          message: "Password must be at least 8 characters",
        });
    } else if (!/[A-Z]/.test(newPassword) || !/[a-z]/.test(newPassword)) {
      return res
        .status(400)
        .json({
          success: false,
          message: "Password must contain both uppercase and lowercase letters",
        });
    } else if (!/[0-9]/.test(newPassword)) {
      return res
        .status(400)
        .json({ success: false, message: "Password must contain a number" });
    }

    const user = await Users.findOne({ where: { email } });
    if (!user) {
      // Return generic message to prevent email enumeration
      return res
        .status(400)
        .json({ success: false, message: "Invalid or expired OTP code" });
    }

    // Timing-safe OTP comparison
    const otpString = String(otpCode);
    const storedOtpString = String(user.otpCode);
    if (otpString.length !== storedOtpString.length ||
        !crypto.timingSafeEqual(Buffer.from(otpString), Buffer.from(storedOtpString))) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid OTP code" });
    }

    // Check expiration
    if (new Date() > new Date(user.otpExpiresAt)) {
      return res
        .status(400)
        .json({ success: false, message: "OTP code has expired" });
    }

    // Hash the new password
    const hashedPassword = await bcrypt.hash(newPassword, 14);
    user.password = hashedPassword;

    // Clear the OTP fields
    user.otpCode = null;
    user.otpExpiresAt = null;
    await user.save();

    return res.status(200).json({
      success: true,
      message: "Password reset successful",
    });
  } catch (error) {
    console.error("Reset password error:", error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
}

async function googleAuth(req, res) {
  try {
    const { idToken } = req.body;
    if (!idToken)
      return res
        .status(400)
        .json({ success: false, message: "idToken is required" });

    const ticket = await googleClient.verifyIdToken({
      idToken,
      audience: process.env.GOOGLE_CLIENT_ID,
    });
    const payload = ticket.getPayload();
    const { email, given_name, family_name } = payload;

    let user = await Users.findOne({ where: { email } });

    if (!user) {
      // Create user if they don't exist
      const randomPassword = crypto.randomBytes(16).toString('hex') + "Aa1@";
      const hashedPassword = await bcrypt.hash(randomPassword, 14);
      
      user = await withTransaction(async (t) => {
        const created = await Users.create(
          {
            full_name: `${given_name || "Google"} ${family_name || "User"}`.trim(),
            email,
            password: hashedPassword,
            gender: null,
            phone_no: null,
            address: null,
            state: null,
            country: "Nigeria",
            is_verified: false,
          },
          { transaction: t }
        );

        await Notifications.create(
          {
            user_id: created.id,
            type: "account",
            notification: `Welcome to RentULO ${created.full_name}! Your account has been successfully created via Google.`,
            is_read: false,
          },
          { transaction: t }
        );

        await Profile.create(
          {
            user_id: created.id,
            bio: "Hey I'm a verified user at RentULO",
            phone: null,
            address: null,
            location: null,
            verified: false,
          },
          { transaction: t }
        );

        await createWalletForUser(created, t);

        return created;
      }, { context: 'googleAuth', email });

      await notifySuperAdmins(
        `New user registered via Google: ${user.full_name} (tenant)`,
        "system",
      );
    }

    const token = jwt.sign(
      {
        userId: user.id,
        currentUser: user.full_name,
        location: user.state
          ? `${user.state}, ${user.country}`
          : "Not fully set",
        role: `${user.role}`,
        email: `${user.email}`,
      },
      process.env.JWT_SECRET,
      { expiresIn: "24h" },
    );

    // Return standard 200 OK since the auth was successful.
    await logAndEmailUser(
      user.id,
      user.email,
      "New Login Alert",
      "A successful login via Google was just detected on your RentULO account.",
    );

    const cookieOptions = {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
      path: "/",
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days in milliseconds
    };

    res.cookie("token", token, cookieOptions);
    res.cookie("userRole", user.role, cookieOptions);

    return res.status(200).json({
      success: true,
      message: "Google Auth Successful",
      token: token,
      role: user.role,
    });
  } catch (error) {
    console.error("Google Auth error:", error);
    return res
      .status(500)
      .json({ success: false, message: "Server error during Google auth" });
  }
}

async function getMe(req, res) {
  const token = req.cookies.token;
  const userRole = req.cookies.userRole;

  if (token && userRole) {
    return res.status(200).json({
      isLoggedIn: true,
      userRole: userRole,
    });
  } else {
    return res.status(200).json({
      isLoggedIn: false,
      userRole: null,
    });
  }
}

async function logout(req, res) {
  const cookieOptions = {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: "/",
  };

  res.clearCookie("token", cookieOptions);
  res.clearCookie("userRole", cookieOptions);

  return res
    .status(200)
    .json({ success: true, message: "Logged out successfully" });
}

async function registerAdmin(req, res) {
  try {
    const {
      gender,
      phone_no,
      email,
      address,
      state,
      password,
    } = req.body;

    const full_name = (
      req.body.full_name ||
      `${req.body.first_name || ""} ${req.body.last_name || ""}`
    ).trim();

    if (
      !full_name ||
      !gender ||
      !phone_no ||
      !address ||
      !state ||
      !email ||
      !password
    ) {
      return res
        .status(400)
        .json({ success: false, message: "All fields are required" });
    }

    if (password.length < 8) {
      return res
        .status(400)
        .json({
          success: false,
          message: "Password must be at least 8 characters",
        });
    } else if (!/[A-Z]/.test(password) || !/[a-z]/.test(password)) {
      return res
        .status(400)
        .json({
          success: false,
          message: "Password must contain both uppercase and lowercase letters",
        });
    } else if (!/[0-9]/.test(password)) {
      return res
        .status(400)
        .json({
          success: false,
          message: "Password must contain a number",
        });
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid email format" });
    } else if (full_name.length < 3) {
      return res
        .status(400)
        .json({
          success: false,
          message: "Name must be at least 3 characters",
        });
    }

    const existingUser = await Users.findOne({ where: { email } });
    if (existingUser && existingUser.is_active) {
      return res
        .status(400)
        .json({ success: false, message: "User already exists" });
    }

    // Generate a 6-digit OTP using cryptographically secure random
    const otpCode = crypto.randomInt(100000, 999999);
    // Set expiration to 10 minutes from now
    const otpExpiresAt = new Date(Date.now() + 10 * 60 * 1000);
    const hashedPassword = await bcrypt.hash(password, 14);
    const country = "Nigeria";

    let user;
    if (existingUser) {
      // If user exists but is inactive, overwrite their details with the new registration attempt
      existingUser.full_name = full_name;
      existingUser.gender = gender;
      existingUser.phone_no = phone_no;
      existingUser.address = address;
      existingUser.state = state;
      existingUser.country = country;
      existingUser.password = hashedPassword;
      existingUser.role = "admin";
      existingUser.is_superadmin = true;
      existingUser.is_verified = true;
      existingUser.otpCode = otpCode;
      existingUser.otpExpiresAt = otpExpiresAt;
      await existingUser.save();
      user = existingUser;
    } else {
      user = await Users.create({
        full_name,
        gender,
        role: "admin",
        email,
        phone_no,
        address,
        state,
        country,
        password: hashedPassword,
        is_active: false,
        is_superadmin: true,
        is_verified: true,
        otpCode,
        otpExpiresAt,
      });
    }

    // SEND OTP EMAIL
    let previewUrl = null;
    try {
      const adminOtpHtml = buildEmailShell({
        eyebrow: 'Account verification',
        heading: 'Verify your admin account',
        bodyHtml: `
          <p style="margin:0;">Thanks for registering as an Admin on RentULO. Enter the 6-digit code below to verify your email and complete registration:</p>
          ${buildCodeBadge(otpCode)}
          <p style="margin:0 0 8px;color:#d93025;font-weight:500;">This code expires in 10 minutes.</p>
          <p style="margin:0;color:#5f6368;">If you didn't request this, you can safely ignore this email.</p>
        `,
      });

      previewUrl = await sendEmail(
        email,
        "Admin Account Verification OTP",
        `Hello ${full_name},\n\nYour OTP for admin account registration is ${otpCode}. It is valid for 10 minutes.\n\nBest regards,\nThe RentULO Team`,
        adminOtpHtml,
      );
    } catch (mailError) {
      console.error("Failed to send OTP verification email:", mailError);
    }

    return res.status(201).json({
      success: true,
      message:
        "OTP sent to email successfully. Please verify to complete registration.",
      ...(process.env.NODE_ENV !== "production" && previewUrl ? { testMailUrl: previewUrl } : {}),
    });
  } catch (error) {
    console.error("registerAdmin error:", error);
    return res.status(500).json({
      success: false,
      message: "Server error during registration",
    });
  }
}

async function verifyAdmin(req, res) {
  try {
    const { email, otpCode } = req.body;
    if (!email || !otpCode) {
      return res
        .status(400)
        .json({ success: false, message: "Email and OTP code are required" });
    }

    const user = await Users.findOne({ where: { email } });
    if (!user) {
      return res
        .status(404)
        .json({ success: false, message: "User not found" });
    }

    if (user.role !== "admin") {
      return res
        .status(400)
        .json({
          success: false,
          message: "Invalid request. User is not an admin.",
        });
    }

    if (user.is_active) {
      return res
        .status(400)
        .json({
          success: false,
          message: "Account is already active and verified.",
        });
    }

    // Timing-safe OTP comparison
    const otpString = String(otpCode);
    const storedOtpString = String(user.otpCode);
    if (otpString.length !== storedOtpString.length ||
        !crypto.timingSafeEqual(Buffer.from(otpString), Buffer.from(storedOtpString))) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid OTP code" });
    }

    if (new Date() > new Date(user.otpExpiresAt)) {
      return res
        .status(400)
        .json({ success: false, message: "OTP code has expired" });
    }

    // Set active, clear OTP code, create notification, and profile transactionally
    await withTransaction(async (t) => {
      user.is_active = true;
      user.otpCode = null;
      user.otpExpiresAt = null;
      await user.save({ transaction: t });

      // HANDLE NOTIFICATION
      await Notifications.create({
        user_id: user.id,
        type: "account",
        notification: `Welcome to RentULO ${user.full_name}! Your Admin account has been successfully verified and created.`,
        is_read: false,
      }, { transaction: t });

      // HANDLE PROFILE CREATION
      const country = "Nigeria";
      let location = `${user.state}, ${country}`;
      await Profile.create({
        user_id: user.id,
        bio: "Hey i'm a verified admin at RentULO",
        phone: user.phone_no,
        address: user.address,
        location: location,
        verified: true,
      }, { transaction: t });

      await createWalletForUser(user, t);
    }, { context: 'verifyAdmin', email });

    // SEND WELCOME EMAIL
    try {
      const adminWelcomeHtml = buildEmailShell({
        eyebrow: 'Account verified',
        heading: 'Welcome to the RentULO Admin Panel',
        bodyHtml: `
          <p style="margin:0 0 16px;">Hello <strong>${user.full_name}</strong>,</p>
          <p style="margin:0 0 12px;">Your Admin account has been successfully verified. Welcome to our administration team!</p>
          <p style="margin:0;">You can now access the admin panel, manage listings, user profiles, reports, and oversee platform activity.</p>
          ${buildActionButton('Go to Admin Dashboard', 'https://rentulo.ng/admin/dashboard')}
          <p style="margin:0;color:#5f6368;">If you have any questions, feel free to contact the super admin or our internal support team.</p>
        `,
      });

      await sendEmail(
        email,
        "Welcome to the RentULO Admin Panel",
        `Hi ${user.full_name},\n\nYour Admin account has been successfully verified. Welcome to our team!\n\nBest regards,\nThe RentULO Team`,
        adminWelcomeHtml,
      );
    } catch (mailError) {
      console.error("Failed to send welcome email:", mailError);
    }

    // Broadcast notification to Super Admins
    await notifySuperAdmins(
      `New admin registered: ${user.full_name} (${user.email})`,
      "system",
    );

    return res.status(200).json({
      success: true,
      message: "Admin account verified and profile created successfully.",
    });
  } catch (error) {
    console.error("verifyAdmin error:", error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
}

module.exports = {
  register,
  verifyRegistration,
  login,
  searchUsers,
  forgotPassword,
  confirmOtp,
  resetPassword,
  googleAuth,
  getMe,
  logout,
  registerAdmin,
  verifyAdmin,
};
