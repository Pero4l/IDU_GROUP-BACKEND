const jwt = require("jsonwebtoken");
const db = require("../models");

function getTokenFromReq(req) {
  const authHeader = req.headers["authorization"];
  if (authHeader) {
    const parts = authHeader.split(" ");
    if (parts.length === 2 && parts[0] === "Bearer") {
      return parts[1];
    }
  }
  if (req.cookies && req.cookies.token) {
    return req.cookies.token;
  }
  return null;
}

function authMiddleware(req, res, next) {
  const token = getTokenFromReq(req);

  if (!token) {
    return res.status(401).json({
      success: false,
      message: "Authorization token missing",
    });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;

    // Support both userId and id naming in decoded token
    const userId = String(decoded.userId || decoded.id || '');
    const role = String(decoded.role || 'tenant');

    if (userId) {
      db.sequelize.query(
        `SET app.current_user_id = :userId; SET app.current_user_role = :role;`,
        { replacements: { userId, role }, type: db.sequelize.QueryTypes.SET }
      ).then(() => {
        next();
      }).catch((err) => {
        // Non-blocking warning if RLS variables aren't defined in DB instance
        console.warn("Notice setting RLS session variables:", err.message);
        next();
      });
    } else {
      next();
    }
  } catch (err) {
    return res.status(401).json({
      success: false,
      message: "Invalid or expired token",
    });
  }
}

function optionalAuth(req, res, next) {
  const token = getTokenFromReq(req);

  if (!token) {
    req.user = null;
    return next();
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
  } catch (err) {
    req.user = null;
  }
  next();
}

module.exports = { authMiddleware, optionalAuth };
