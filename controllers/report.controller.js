const { Reports, Users, Notifications } = require('../models');
const { Op } = require('sequelize');
const { notifySuperAdmins, logAndEmailUser } = require('./notification.controller');

async function createReport(req, res) {
  try {
    
    const { report_user_id, search_name, report_type, report_message } = req.body;

    const user_id = req.user.userId;

    if (!report_message) {
      return res.status(400).json({ success: false, message: "Report message is required." });
    }

    if (!report_user_id && !search_name) {
      return res.status(400).json({ success: false, message: "Please provide either report_user_id or search_name to identify the user." });
    }

    if (report_user_id && search_name) {
      return res.status(400).json({ success: false, message: "Please provide either report_user_id OR search_name, not both at the same time." });
    }

    let report_user = null;

    if (report_user_id) {
        report_user = await Users.findByPk(report_user_id);
    } else if (search_name) {
        report_user = await Users.findOne({
            where: {
                [Op.or]: [
                    { first_name: { [Op.iLike]: `%${search_name}%` } },
                    { last_name: { [Op.iLike]: `%${search_name}%` } },
                    { email: { [Op.iLike]: `%${search_name}%` } }
                ]
            }
        });
    }

    if (!report_user) {
        return res.status(404).json({ success: false, message: "User to report not found based on the provided criteria." });
    }

    const report = await Reports.create({
      user_id,
      report_user_id: report_user.id,
      report_name: `${report_user.first_name} ${report_user.last_name}`,
      report_number: report_user.phone_no || '',
      report_type,
      report_message,
      report_status: 'pending'
    });

    const reporter = await Users.findByPk(user_id);
    await logAndEmailUser(user_id, reporter?.email, "Report Submitted", `Your report against ${report_user.first_name} ${report_user.last_name} has been submitted successfully and is being reviewed.`);

    // Notify Super Admins
    await notifySuperAdmins(`New system report filed against ${report_user.first_name} ${report_user.last_name}`, 'warning');

    return res.status(201).json({
      success: true,
      message: "Report submitted successfully.",
      data: report
    });
  } catch (error) {
    console.error("Error creating report:", error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
}

module.exports = { createReport };
