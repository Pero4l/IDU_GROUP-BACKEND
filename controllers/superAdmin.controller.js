const { Users, Rentals, Reports, Progress } = require('../models');

async function getAllUsers(req, res) {
  try {
    const users = await Users.findAll({
      attributes: { exclude: ['password'] }
    });
    return res.status(200).json({ success: true, count: users.length, data: users });
  } catch (error) {
    console.error("Super Admin - getAllUsers error:", error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
}

async function toggleUserStatus(req, res) {
  try {
    const { id } = req.params;
    const user = await Users.findByPk(id);
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }
    
    // Safety check so admins do not block themselves accidentally
    if (user.id === req.user.userId) {
      return res.status(400).json({ success: false, message: "You cannot change your own status." });
    }

    user.is_active = !user.is_active;
    await user.save();
    
    return res.status(200).json({ 
      success: true, 
      message: `User status updated to ${user.is_active ? 'active' : 'blocked'}`, 
      data: user 
    });
  } catch (error) {
    console.error("Super Admin - toggleUserStatus error:", error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
}

async function deleteUser(req, res) {
  try {
    const { id } = req.params;
    const user = await Users.findByPk(id);
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    if (user.id === req.user.userId) {
      return res.status(400).json({ success: false, message: "You cannot delete your own account here." });
    }

    await Users.destroy({ where: { id } });
    return res.status(200).json({ success: true, message: "User deleted successfully" });
  } catch (error) {
    console.error("Super Admin - deleteUser error:", error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
}


async function getAllRentals(req, res) {
  try {
    const rentals = await Rentals.findAll({
      include: [{ model: Users, attributes: ['first_name', 'last_name', 'email'] }]
    });
    return res.status(200).json({ success: true, count: rentals.length, data: rentals });
  } catch (error) {
    console.error("Super Admin - getAllRentals error:", error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
}

async function deleteRental(req, res) {
  try {
    const { id } = req.params;
    const rental = await Rentals.findByPk(id);
    if (!rental) {
      return res.status(404).json({ success: false, message: "Rental not found" });
    }
    await Rentals.destroy({ where: { id } });
    return res.status(200).json({ success: true, message: "Rental deleted successfully" });
  } catch (error) {
    console.error("Super Admin - deleteRental error:", error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
}

async function getLockedHouses(req, res) {
  try {
    const lockedProgress = await Progress.findAll({
      where: { locked: true },
      include: [
        { model: Rentals },
        { model: Users, attributes: ['first_name', 'last_name', 'email'] }
      ]
    });
    return res.status(200).json({ success: true, count: lockedProgress.length, data: lockedProgress });
  } catch (error) {
    console.error("Super Admin - getLockedHouses error:", error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
}

async function getAllReports(req, res) {
  try {
    const reports = await Reports.findAll({
      include: [
        { model: Users, as: 'user', attributes: ['first_name', 'last_name', 'email'] },
        { model: Users, as: 'report_user', attributes: ['first_name', 'last_name', 'email'] }
      ]
    });
    return res.status(200).json({ success: true, count: reports.length, data: reports });
  } catch (error) {
    console.error("Super Admin - getAllReports error:", error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
}

async function updateReportStatus(req, res) {
  try {
    const { id } = req.params;
    const { status } = req.body;
    const report = await Reports.findByPk(id);
    if (!report) {
      return res.status(404).json({ success: false, message: "Report not found" });
    }
    if (status) {
      report.report_status = status;
      await report.save();
    }
    return res.status(200).json({ success: true, message: `Report status updated to ${status}`, data: report });
  } catch (error) {
    console.error("Super Admin - updateReportStatus error:", error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
}


module.exports = { 
  getAllUsers, 
  toggleUserStatus, 
  deleteUser, 
  getAllRentals,
  deleteRental,
  getLockedHouses,
  getAllReports,
  updateReportStatus
};
