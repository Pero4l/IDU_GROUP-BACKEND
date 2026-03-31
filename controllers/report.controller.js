const { Reports, Users } = require('../models');

async function createReport(req, res) {
  try {
    const { report_user_id, report_name, report_number, report_type, report_message } = req.body;
    const user_id = req.user.userId;

    if (!report_user_id || !report_message) {
      return res.status(400).json({ success: false, message: "report_user_id and report_message are required." });
    }

    const report = await Reports.create({
      user_id,
      report_user_id,
      report_name,
      report_number,
      report_type,
      report_message,
      report_status: 'pending'
    });

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
