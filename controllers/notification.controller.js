const {Notifications, Users} = require("../models");

async function getNotifications(req, res) {
  try {
    const notifications = await Notifications.findAll({
      where: { user_id: req.user.id },
      include: [{ model: Users, attributes: ['first_name', 'last_name'] }],
      order: [['createdAt', 'DESC']]
    });

    res.status(200).json({ success: true, notifications });
  } catch (error) {
    console.error("Error fetching notifications:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
}

module.exports = {
  getNotifications
};