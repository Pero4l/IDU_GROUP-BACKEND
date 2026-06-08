const {
  Users,
  Notifications,
  Profile,
  PendingRegistrations,
} = require("../models");
const { Op } = require("sequelize");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
require("dotenv").config();
const { OAuth2Client } = require("google-auth-library");
const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);
const { notifySuperAdmins, logAndEmailUser } = require('./notification.controller');
const { withTransaction } = require('../utils/rollback');
const logger = require('../utils/logger');

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

// ── Welcome email helper ──────────────────────────────────────────────────────
// Intentionally fire-and-forget from the register flow so a mail failure never
// rolls back a successful registration.
async function sendWelcomeEmail(email, first_name, last_name) {
  const mailer = await getTransporter();
  const mailOptions = {
    from: '"RentULO Team" <no-reply@rentulo.com>',
    to: email,
    subject: 'Welcome to RentULO 🎉',
    text: `Hi ${first_name}, welcome to RentULO! Your account has been successfully created.`,
    html: `
    <div style="font-family: Arial, sans-serif; background-color: #f9fafb; padding: 20px;">
      <div style="max-width: 600px; margin: auto; background: #ffffff; border-radius: 10px; padding: 30px; box-shadow: 0 4px 10px rgba(0,0,0,0.05);">
        <h2 style="color: #111827;">Welcome to RentULO, ${first_name} ${last_name} 👋</h2>
        <p style="color: #4b5563; font-size: 15px; line-height: 1.6;">
          Your account has been successfully created. We're excited to have you on board.
        </p>
        <div style="text-align: center; margin: 30px 0;">
          <a href="https://rentulo.com/dashboard"
             style="background-color: #111827; color: #ffffff; padding: 12px 20px; text-decoration: none; border-radius: 6px; font-size: 14px;">
            Go to Dashboard
          </a>
        </div>
        <hr style="margin: 30px 0; border: none; border-top: 1px solid #e5e7eb;" />
        <p style="color: #9ca3af; font-size: 12px; text-align: center;">
          © ${new Date().getFullYear()} RentULO. All rights reserved.
        </p>
      </div>
    </div>`,
  };
  const info = await mailer.sendMail(mailOptions);
  console.log("Welcome email sent: %s", info.messageId);
  const previewUrl = nodemailer.getTestMessageUrl(info);
  if (previewUrl) console.log("Welcome email preview: %s", previewUrl);
}

async function register(req, res) {
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

  // ── Validation (happens before any DB write) ──────────────────────────────
  if (!first_name || !last_name || !gender || !role || !phone_no || !address || !state || !email || !password) {
    return res.status(400).json({ message: "All fields are required" });
  }
  if (password.length < 6) {
    return res.status(400).json({ message: "Password must be at least 6 characters" });
  }
  if (!/[A-Z]/.test(password) || !/[a-z]/.test(password)) {
    return res.status(400).json({ message: "Password must contain both uppercase and lowercase letters" });
  }
  if (!/[0-9]/.test(password)) {
    return res.status(400).json({ message: "Password must contain a number" });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ message: "Invalid email format" });
  }
  if (first_name.length < 3 || last_name.length < 3) {
    return res.status(400).json({ message: "Name must be at least 3 characters" });
  }

  // ── Duplicate check (outside the transaction — fast read, no write) ───────
  const existingUser = await Users.findOne({ where: { email } });
  if (existingUser) {
    return res.status(400).json({ success: false, message: "User already exists" });
  }

  try {
    const hashedPassword = await bcrypt.hash(password, 12);
    const country = "Nigeria";

    // ── All three writes wrapped in ONE transaction ────────────────────────
    // If any of them fail (DB error, network drop, crash …) the transaction
    // is automatically rolled back and the DB is left completely clean —
    // no orphaned user rows, no missing profiles.
    const newUser = await withTransaction(
      async (t) => {
        // 1. Create the user
        const user = await Users.create(
          { first_name, last_name, gender, role, email, phone_no, address, state, country, password: hashedPassword },
          { transaction: t }
        );

        // 2. Create the welcome notification
        await Notifications.create(
          {
            user_id: user.id,
            type: 'account',
            notification: `Welcome to RentULO ${user.first_name} ${user.last_name}! Your account has been successfully created.`,
            is_read: false,
          },
          { transaction: t }
        );

        // 3. Create the profile — if this fails the user row is rolled back too
        await Profile.create(
          {
            user_id: user.id,
            bio: "Hey I'm a verified user at RentULO",
            phone: phone_no,
            address,
            location: `${state}, ${country}`,
            verified: false,
          },
          { transaction: t }
        );

        return user;
      },
      { context: 'register', email }
    );

    // Non-critical side-effects
    sendWelcomeEmail(email, first_name, last_name).catch((err) =>
      logger.warn('Welcome email failed (non-critical)', { email, error: err.message })
    );

    await notifySuperAdmins(`New user registered: ${first_name} ${last_name} (${role})`, 'system');

    logger.info('User registered successfully', { userId: newUser.id, email, role });

    return res.status(201).json({
      success: true,
      message:
        "Account verified and registered successfully. You can now login.",
    });

  } catch (error) {
    // withTransaction already rolled back and logged; just return 500
    logger.error('Registration failed — all DB changes rolled back', { email, error: error.message });
    return res.status(500).json({
      success: false,
      message: "Registration failed. Please try again.",
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
      await logAndEmailUser(
        req.data.id,
        req.data.email,
        "New Login Alert",
        "A successful login to your RentULO account was just detected.",
      );

      const cookieOptions = {
        httpOnly: true,
        secure: true,
        sameSite: "strict",
        path: "/",
        maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days in milliseconds
      };

      res.cookie("token", token, cookieOptions);
      res.cookie("userRole", role, cookieOptions);

      return res.status(200).json({
        success: true,
        message: "Login Successfully",
        token: token,
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
      return res
        .status(404)
        .json({ success: false, message: "User not found" });
    }

    // Generate a 6-digit OTP
    const otpCode = Math.floor(100000 + Math.random() * 900000);
    // Set expiration to 15 minutes from now
    const otpExpiresAt = new Date(Date.now() + 15 * 60 * 1000);

    user.otpCode = otpCode;
    user.otpExpiresAt = otpExpiresAt;
    await user.save();

    // Setup mailer and send OTP
    let previewUrl = null;
    try {
      previewUrl = await sendEmail(
        email,
        "Password Reset OTP",
        `Your password reset OTP is ${otpCode}. It expires in 15 minutes.`,
        `<p>Your password reset OTP is <b>${otpCode}</b>. It expires in 15 minutes.</p>`,
      );
    } catch (mailError) {
      console.error("Forgot password email error:", mailError);
    }

    return res.status(200).json({
      success: true,
      message: "OTP sent to email successfully",
      testMailUrl: previewUrl,
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

    if (user.otpCode !== parseInt(otpCode)) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid OTP code" });
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

    if (newPassword.length < 6) {
      return res
        .status(400)
        .json({
          success: false,
          message: "Password must be at least 6 characters",
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
      return res
        .status(404)
        .json({ success: false, message: "User not found" });
    }

    // Verify OTP
    if (user.otpCode !== parseInt(otpCode)) {
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
    const hashedPassword = await bcrypt.hash(newPassword, 12);
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
      const randomPassword = Math.random().toString(36).slice(-8) + "Aa1@";
      const hashedPassword = await bcrypt.hash(randomPassword, 12);
      
      user = await withTransaction(async (t) => {
        const created = await Users.create(
          {
            first_name: given_name || "Google",
            last_name: family_name || "User",
            email,
            password: hashedPassword,
            gender: null,
            phone_no: null,
            address: null,
            state: null,
            country: "Nigeria",
          },
          { transaction: t }
        );

        await Notifications.create(
          {
            user_id: created.id,
            type: "account",
            notification: `Welcome to RentULO ${created.first_name} ${created.last_name}! Your account has been successfully created via Google.`,
            is_read: false,
          },
          { transaction: t }
        );

        await Profile.create(
          {
            user_id: created.id,
            bio: "Hey I'm a verified user at RentULO",
            verified: false,
          },
          { transaction: t }
        );

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
      secure: true,
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
    secure: true,
    sameSite: "strict",
    path: "/",
  };

  res.clearCookie("token", cookieOptions);
  res.cookie("userRole", cookieOptions); // Wait, no, res.clearCookie('userRole', cookieOptions) in original code:
  // let's match exact original:
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
      adminSecretKey,
    } = req.body;

    const full_name = (
      req.body.full_name ||
      `${req.body.first_name || ""} ${req.body.last_name || ""}`
    ).trim();

    const secretKey = (
      adminSecretKey || req.headers?.["x-admin-secret"]
    )?.trim();
    const systemSecret = (
      process.env.ADMIN_SECRET_KEY || "rentulo_secret_admin_key_2026"
    )?.trim();
    if (secretKey !== systemSecret) {
      return res
        .status(403)
        .json({
          success: false,
          message: "Unauthorized. Invalid admin secret key.",
        });
    }

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

    if (password.length < 6) {
      return res
        .status(400)
        .json({
          success: false,
          message: "Password must be at least 6 characters",
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
        .json({ success: false, message: "Password must contain a number" });
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

    // Generate a 6-digit OTP
    const otpCode = Math.floor(100000 + Math.random() * 900000);
    // Set expiration to 10 minutes from now
    const otpExpiresAt = new Date(Date.now() + 10 * 60 * 1000);
    const hashedPassword = await bcrypt.hash(password, 12);
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
      const adminOtpHtml = `
        <div style="font-family: Arial, sans-serif; background-color: #f9fafb; padding: 20px;">
          <div style="max-width: 600px; margin: auto; background: #ffffff; border-radius: 10px; padding: 30px; box-shadow: 0 4px 10px rgba(0,0,0,0.05);">
            <h2 style="color: #111827;">Verify Your Admin Account 🔑</h2>
            <p style="color: #4b5563; font-size: 15px; line-height: 1.6;">
              Thank you for registering as an Admin on RentULO. To complete your registration, please verify your email address using the 6-digit OTP code below:
            </p>
            <div style="text-align: center; margin: 30px 0;">
              <span style="font-size: 32px; font-weight: bold; letter-spacing: 5px; color: #111827; background-color: #f3f4f6; padding: 15px 30px; border-radius: 8px; display: inline-block;">
                ${otpCode}
              </span>
            </div>
            <p style="color: #ef4444; font-size: 14px; font-weight: 500;">
              Note: This verification code is valid for exactly 10 minutes.
            </p>
            <p style="color: #6b7280; font-size: 13px;">
              If you did not initiate this registration, please ignore this email.
            </p>
            <hr style="margin: 30px 0; border: none; border-top: 1px solid #e5e7eb;" />
            <p style="color: #9ca3af; font-size: 12px; text-align: center;">
              © ${new Date().getFullYear()} RentULO. All rights reserved.
            </p>
          </div>
        </div>
      `;

      previewUrl = await sendEmail(
        email,
        "Admin Account Verification OTP 🔑",
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
      testMailUrl: previewUrl,
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

    if (user.otpCode !== parseInt(otpCode)) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid OTP code" });
    }

    if (new Date() > new Date(user.otpExpiresAt)) {
      return res
        .status(400)
        .json({ success: false, message: "OTP code has expired" });
    }

    // Set active and clear OTP code
    user.is_active = true;
    user.otpCode = null;
    user.otpExpiresAt = null;
    await user.save();

    // HANDLE NOTIFICATION
    await Notifications.create({
      user_id: user.id,
      type: "account",
      notification: `Welcome to RentULO ${user.full_name}! Your Admin account has been successfully verified and created.`,
      is_read: false,
    });

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
    });

    // SEND WELCOME EMAIL
    try {
      const adminWelcomeHtml = `
        <div style="font-family: Arial, sans-serif; background-color: #f9fafb; padding: 20px;">
          <div style="max-width: 600px; margin: auto; background: #ffffff; border-radius: 10px; padding: 30px; box-shadow: 0 4px 10px rgba(0,0,0,0.05);">
            <h2 style="color: #111827;">Welcome to RentULO, ${user.full_name}👋</h2>
            <p style="color: #4b5563; font-size: 15px; line-height: 1.6;">
              Your admin account has been successfully verified and your profile created. We're excited to have you join our administration team!
            </p>
            <p style="color: #4b5563; font-size: 15px; line-height: 1.6;">
              You can now access the admin panel, manage listings, user profiles, reports, and oversee platform activity.
            </p>
            <div style="text-align: center; margin: 30px 0;">
              <a href="https://rentulo.com/admin/dashboard" 
                 style="background-color: #111827; color: #ffffff; padding: 12px 20px; text-decoration: none; border-radius: 6px; font-size: 14px;">
                Go to Admin Dashboard
              </a>
            </div>
            <p style="color: #6b7280; font-size: 13px;">
              If you have any questions, feel free to contact the super admin or our internal support team.
            </p>
            <hr style="margin: 30px 0; border: none; border-top: 1px solid #e5e7eb;" />
            <p style="color: #9ca3af; font-size: 12px; text-align: center;">
              © ${new Date().getFullYear()} RentULO. All rights reserved.
            </p>
          </div>
        </div>
      `;

      await sendEmail(
        email,
        "Welcome to the RentULO Admin Panel 🎉",
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
