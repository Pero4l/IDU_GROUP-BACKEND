const { Users } = require('../models');

async function requireSuperAdmin(req, res, next) {
    try {
        // req.user is set by authMiddleware
        if (!req.user || !req.user.userId) {
            return res.status(401).json({ success: false, message: "Unauthorized access" });
        }

        const user = await Users.findByPk(req.user.userId);
        
        if (!user) {
            return res.status(404).json({ success: false, message: "User not found" });
        }

        if (user.is_superadmin !== true) {
            return res.status(403).json({ success: false, message: "Forbidden. Super Admin privileges required." });
        }

        req.adminUser = user;
        next();
    } catch (error) {
        console.error("Super Admin check error:", error);
        return res.status(500).json({ success: false, message: "Server error during authorization" });
    }
}

module.exports = { requireSuperAdmin };
