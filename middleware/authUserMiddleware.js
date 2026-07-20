const jwt = require("jsonwebtoken");
const db = require("../models");

function authMiddleware(req, res, next) {
    const authHeader = req.headers["authorization"];

    if (!authHeader) {
        return res.status(401).json({
            success: false,
            message: "Authorization header missing",
        });
    }

    const parts = authHeader.split(" ");
    if (parts.length !== 2 || parts[0] !== "Bearer") {
        return res.status(401).json({
            success: false,
            message: "Invalid authorization format",
        });
    }

    const token = parts[1];

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        req.user = decoded;

        // Set PostgreSQL session variables for Row-Level Security (RLS)
        const userId = String(decoded.userId || '');
        const role = String(decoded.role || 'tenant');
        db.sequelize.query(
            `SET LOCAL app.current_user_id = :userId;`,
            { replacements: { userId }, type: db.sequelize.QueryTypes.SET }
        ).then(() =>
            db.sequelize.query(
                `SET LOCAL app.current_user_role = :role;`,
                { replacements: { role }, type: db.sequelize.QueryTypes.SET }
            )
        ).then(() => {
            next();
        }).catch((err) => {
            // RLS session variable failure — deny access as a safety fallback
            console.error("Failed to set RLS session variables:", err);
            return res.status(500).json({
                success: false,
                message: "Server security configuration error",
            });
        });
    } catch (err) {
        return res.status(401).json({
            success: false,
            message: "Invalid or expired token",
        });
    }
}

module.exports = { authMiddleware };
