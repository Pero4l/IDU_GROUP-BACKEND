const jwt = require("jsonwebtoken");
const db = require("../models");
const { allowedOrigins } = require("../config/allowedOrigins");

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

// Where the browser says the request came from: Origin, or Referer's origin.
function requestOrigin(req) {
  if (req.headers.origin) return req.headers.origin;
  if (req.headers.referer) {
    try { return new URL(req.headers.referer).origin; } catch (_) { /* ignore */ }
  }
  return null;
}

// CSRF guard. Auth cookies are SameSite=None in production (so they work from
// rentulo.ng → onrender.com), which means a browser will also attach them to
// requests other websites trigger. So a cookie is only trusted on
// data-changing requests coming from an allow-listed origin. Bearer tokens
// can't be attached by another site, so they're always fine.
function cookieAllowed(req) {
  if (SAFE_METHODS.has(req.method)) return true;
  const origin = requestOrigin(req);
  return !!origin && allowedOrigins.includes(origin);
}

// Returns { token, fromCookie, blocked }.
function getTokenFromReq(req) {
  const authHeader = req.headers["authorization"];
  if (authHeader) {
    const parts = authHeader.split(" ");
    if (parts.length === 2 && parts[0] === "Bearer") {
      return { token: parts[1], fromCookie: false, blocked: false };
    }
  }
  if (req.cookies && req.cookies.token) {
    return { token: req.cookies.token, fromCookie: true, blocked: !cookieAllowed(req) };
  }
  return { token: null, fromCookie: false, blocked: false };
}

function authMiddleware(req, res, next) {
  const { token, blocked } = getTokenFromReq(req);

  if (blocked) {
    return res.status(403).json({
      success: false,
      message: "Request origin not allowed. Send the token in the Authorization header.",
    });
  }

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
  const { token, blocked } = getTokenFromReq(req);

  // A cookie from a non-allowed origin is ignored: treat as anonymous.
  if (!token || blocked) {
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
