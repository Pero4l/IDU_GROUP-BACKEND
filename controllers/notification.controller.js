const {Notifications, Users} = require("../models");

async function getNotifications(req, res) {

    const userId = req.user.userId;

  try {
    const notifications = await Notifications.findAll({
      where: { user_id: userId },
    //   include: [{ model: Users, attributes: ['first_name', 'last_name'] }],
      order: [['createdAt', 'DESC']]
    });

    res.status(200).json({ success: true, notifications });
  } catch (error) {
    console.error("Error fetching notifications:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
}



// Notification count
async function notificationCount(req, res) {

    const userId = req.user.userId;

  try {
    const count = await Notifications.count({
      where: { user_id: userId, is_read: false }
    });

    res.status(200).json({ success: true, count });
  } catch (error) {
    console.error("Error fetching notification count:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
}

module.exports = {
  getNotifications, notificationCount,
};