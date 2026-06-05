const { Users } = require("../models");

async function isVerifiedMiddleware(req, res, next) {
    try {
        if (!req.user || !req.user.userId) {
            return res.status(401).json({
                success: false,
                message: "Authentication required",
            });
        }

        const user = await Users.findByPk(req.user.userId);

        if (!user) {
            return res.status(404).json({
                success: false,
                message: "User not found",
            });
        }

        if (!user.is_verified) {
            return res.status(403).json({
                success: false,
                message: "Account is not verified. Please complete your profile details (phone number, state, and address) to perform this action.",
            });
        }

        next();
    } catch (error) {
        console.error("Verification middleware error:", error);
        return res.status(500).json({
            success: false,
            message: "Server error during verification check",
        });
    }
}

module.exports = { isVerifiedMiddleware };
