const { Users } = require('../models');

async function requireProfileCompletion(req, res, next) {
    try {
        const userId = req.user.userId;
        const user = await Users.findByPk(userId);

        if (!user) {
            return res.status(404).json({ success: false, message: "User not found" });
        }

        // Check if mandatory fields are missing
        if (!user.phone_no || !user.gender || !user.state || !user.address) {
            return res.status(403).json({
                success: false,
                message: "Please complete your profile details (phone, gender, address, state) to interact with rentals.",
                needsProfileCompletion: true
            });
        }

        next();
    } catch (error) {
        console.error("Profile completion middleware error:", error);
        return res.status(500).json({ success: false, message: "Server error checking profile completion" });
    }
}

module.exports = { requireProfileCompletion };
