const {Users} = require("../models");
const { Op } = require("sequelize");
const bcrypt = require("bcrypt");
const logger = require("../utils/logger");

// In-memory failed login tracker (use Redis in production)
const failedAttempts = new Map();
const LOCKOUT_WINDOW = 15 * 60 * 1000; // 15 minutes
const MAX_ATTEMPTS = 5;

function isLockedOut(identifier) {
  const record = failedAttempts.get(identifier);
  if (!record) return false;
  if (Date.now() - record.firstAttempt > LOCKOUT_WINDOW) {
    failedAttempts.delete(identifier);
    return false;
  }
  return record.count >= MAX_ATTEMPTS;
}

function recordFailedAttempt(identifier) {
  const record = failedAttempts.get(identifier) || { count: 0, firstAttempt: Date.now() };
  record.count += 1;
  failedAttempts.set(identifier, record);
}

function clearFailedAttempts(identifier) {
  failedAttempts.delete(identifier);
}

async function loginMiddleware(req, res, next) {
  const { user, password } = req.body;

  if (!user || !password) {
    return res.status(400).json({
      success: false,
      message: "Email or phone number and password is required",
    });
  }

  // Check account lockout
  if (isLockedOut(user)) {
    return res.status(429).json({
      success: false,
      message: "Account temporarily locked due to too many failed attempts. Please try again in 15 minutes.",
    });
  }

  const existingUser = await Users.findOne({
    attributes: [
      "id",
      "password",
      "full_name",
      "state",
      "country",
      "email",
      "role",
      "is_active",
      "is_superadmin"
    ],
    where: { [Op.or]: [{ email: user }, { phone_no: user }] },
  });

  // Use generic message to prevent user enumeration
  if (!existingUser) {
    return res.status(401).json({
      success: false,
      message: "Invalid credentials",
      message: "Invalid email/number or password",
    });
  }

  if (existingUser.is_active === false) {
    return res.status(403).json({
      success: false,
      message: "Account disabled. Please contact support.",
    });
  }

  const passMatch = await bcrypt.compare(password, existingUser.password);
  if (!passMatch) {
    recordFailedAttempt(user);
    logger.warn('Failed login attempt', { userId: existingUser.id, email: existingUser.email });
    return res.status(401).json({
      success: false,
      message: "Invalid credentials",
      message: "Invalid email/number or password",
    });
  }

  clearFailedAttempts(user);
  req.user = passMatch;
  req.data = existingUser;
  next();
}

module.exports = {
  loginMiddleware,
};
