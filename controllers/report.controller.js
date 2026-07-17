const { Reports, Users } = require('../models');
const { Op } = require('sequelize');
const { notifySuperAdmins, logAndEmailUser } = require('./notification.controller');
const { withTransaction } = require('../utils/rollback');
const logger = require('../utils/logger');

// POST /report/create
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
      return res.status(400).json({ success: false, message: "Please provide either report_user_id OR search_name, not both." });
    }

    // Resolve the reported user before starting any transaction
    let report_user = null;
    if (report_user_id) {
      report_user = await Users.findByPk(report_user_id);
    } else {
      report_user = await Users.findOne({
        where: {
          [Op.or]: [
            { full_name: { [Op.iLike]: `%${search_name}%` } },
            { email:      { [Op.iLike]: `%${search_name}%` } },
          ]
        }
      });
    }

    if (!report_user) {
      return res.status(404).json({ success: false, message: "User to report not found." });
    }

    // Single write — wrapped in a transaction so a failure leaves no
    // orphaned report row in the database
    const report = await withTransaction(async (t) => {
      return Reports.create(
        {
          user_id,
          report_user_id: report_user.id,
          report_name: report_user.full_name || '',
          report_number: report_user.phone_no || '',
          report_type,
          report_message,
          report_status: 'pending',
        },
        { transaction: t }
      );
    }, { context: 'createReport', user_id, reportedUserId: report_user.id });

    logger.info('Report created', { reportId: report.id, user_id, reportedUserId: report_user.id });

    // Non-critical side-effects
    const reporter = await Users.findByPk(user_id);
    await logAndEmailUser(user_id, reporter?.email, "Report Submitted",
      `Your report against ${report_user.full_name || ''} has been submitted and is being reviewed.`
    );
    await notifySuperAdmins(`New report filed against ${report_user.full_name || ''}`, 'warning');

    return res.status(201).json({ success: true, message: "Report submitted successfully.", data: report });
  } catch (error) {
    logger.error('Error creating report', { error: error.message, userId: req.user?.userId });
    return res.status(500).json({ success: false, message: "Server error" });
  }
}

module.exports = { createReport };
