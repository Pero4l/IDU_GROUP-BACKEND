const { Notifications, Users } = require("../models");
const { sendEmail } = require('../utils/mailer');
const logger = require('../utils/logger');

/**
 * Creates an in-app notification for a user AND sends them an email.
 *
 * This function NEVER throws. A DB or mail failure is logged and swallowed
 * so a side-effect can never roll back or crash the caller's main operation.
 *
 * @param {string} userId
 * @param {string|null} userEmail
 * @param {string} title   - Short label (also used as email subject)
 * @param {string} html    - Full message body (used as email HTML + notification text)
 */
async function logAndEmailUser(userId, userEmail, title, html) {
  try {
    await Notifications.create({
      user_id: userId,
      type: "system",
      notification: title,
      is_read: false,
    });
  } catch (err) {
    // DB write failed — log it, but don't let it bubble up
    logger.error('logAndEmailUser: failed to create notification', {
      userId,
      title,
      error: err.message,
    });
  }

  // sendEmail already never throws — call it outside the try so a
  // notification DB failure doesn't also skip the email
  if (userEmail) {
    await sendEmail(userEmail, title, title, html);
  }
}

/**
 * Sends an in-app notification to every super admin AND an email to the
 * admin inbox.
 *
 * This function NEVER throws. Failures are logged and swallowed.
 *
 * @param {string} message
 * @param {string} [type]
 */
async function notifySuperAdmins(message, type = "system") {
  try {
    const superAdmins = await Users.findAll({ where: { is_superadmin: true } });
    if (superAdmins.length === 0) return;

    const notifications = superAdmins.map((admin) => ({
      user_id: admin.id,
      type,
      notification: message,
      is_read: false,
    }));

    await Notifications.bulkCreate(notifications);
  } catch (err) {
    logger.error('notifySuperAdmins: failed to create admin notifications', {
      message,
      error: err.message,
    });
  }

  // Email is also fire-and-forget — sendEmail never throws
  await sendEmail("rentulonigeria@gmail.com", "Admin Alert: " + message, message);
}

// ─── Route handlers ───────────────────────────────────────────────────────────

async function getNotifications(req, res) {
  try {
    const userId = req.user.userId;
    const notifications = await Notifications.findAll({
      where: { user_id: userId },
      order: [['createdAt', 'DESC']],
    });
    return res.status(200).json({ success: true, notifications });
  } catch (error) {
    logger.error('Error fetching notifications', { error: error.message, userId: req.user?.userId });
    return res.status(500).json({ success: false, message: "Server error" });
  }
}

async function notificationCount(req, res) {
  try {
    const userId = req.user.userId;
    const count = await Notifications.count({
      where: { user_id: userId, is_read: false },
    });
    return res.status(200).json({ success: true, count });
  } catch (error) {
    logger.error('Error fetching notification count', { error: error.message, userId: req.user?.userId });
    return res.status(500).json({ success: false, message: "Server error" });
  }
}

async function markAsRead(req, res) {
  try {
    const { id } = req.body;
    const userId = req.user.userId;
    await Notifications.update({ is_read: true }, { where: { id, user_id: userId } });
    return res.status(200).json({ success: true, message: "Notification marked as read" });
  } catch (error) {
    logger.error('Error marking notification as read', { error: error.message, userId: req.user?.userId });
    return res.status(500).json({ success: false, message: "Server error" });
  }
}

async function deleteNotification(req, res) {
  try {
    const { id } = req.body;
    const userId = req.user.userId;
    await Notifications.destroy({ where: { id, user_id: userId } });
    return res.status(200).json({ success: true, message: "Notification deleted" });
  } catch (error) {
    logger.error('Error deleting notification', { error: error.message, userId: req.user?.userId });
    return res.status(500).json({ success: false, message: "Server error" });
  }
}

module.exports = {
  getNotifications,
  notificationCount,
  markAsRead,
  deleteNotification,
  notifySuperAdmins,
  logAndEmailUser,
};
