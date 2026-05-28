const { Users, Rentals, Reports, Progress, Conversations, Messages, Transactions } = require('../models');

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


async function getAllConversations(req, res) {
  try {
    const conversations = await Conversations.findAll({
      include: [
        { model: Users, as: 'tenant', attributes: ['first_name', 'last_name', 'email'] },
        { model: Users, as: 'landlord', attributes: ['first_name', 'last_name', 'email'] }
      ],
      order: [['updatedAt', 'DESC']]
    });
    return res.status(200).json({ success: true, count: conversations.length, data: conversations });
  } catch (error) {
    console.error("Super Admin - getAllConversations error:", error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
}

async function getConversationMessages(req, res) {
  try {
    const { id } = req.params;
    const messages = await Messages.findAll({
      where: { conversation_id: id },
      include: [
        { model: Users, as: 'sender', attributes: ['first_name', 'last_name', 'email'] }
      ],
      order: [['createdAt', 'ASC']]
    });
    return res.status(200).json({ success: true, count: messages.length, data: messages });
  } catch (error) {
    console.error("Super Admin - getConversationMessages error:", error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
}

async function getAnalytics(req, res) {
  try {
    // 1. User metrics
    const totalUsers = await Users.count();
    const activeUsers = await Users.count({ where: { is_active: true } });
    const suspendedUsers = await Users.count({ where: { is_active: false } });
    const tenantsCount = await Users.count({ where: { role: 'tenant' } });
    const landlordsCount = await Users.count({ where: { role: 'landlord' } });
    const adminsCount = await Users.count({ where: { role: 'admin' } });

    // 2. Rental metrics
    const totalRentals = await Rentals.count();
    
    // 3. User interaction progress metrics
    const totalLikes = await Progress.count({ where: { liked: true } });
    const totalLocks = await Progress.count({ where: { locked: true } });
    const totalBookings = await Progress.count({ where: { booked: true } });

    // 4. Incident reports metrics
    const totalReports = await Reports.count();
    const pendingReports = await Reports.count({ where: { report_status: 'pending' } });
    const resolvedReports = await Reports.count({ where: { report_status: 'resolved' } });
    const rejectedReports = await Reports.count({ where: { report_status: 'rejected' } });

    // 5. Total transactions/revenue (lock fees)
    const successfulTransactions = await Transactions.findAll({
      where: { status: 'success', payment_type: 'lock_fee' },
      attributes: ['amount']
    });
    const totalRevenue = successfulTransactions.reduce((acc, t) => acc + (t.amount || 0), 0);

    return res.status(200).json({
      success: true,
      data: {
        users: {
          total: totalUsers,
          active: activeUsers,
          suspended: suspendedUsers,
          roles: {
            tenant: tenantsCount,
            landlord: landlordsCount,
            admin: adminsCount
          }
        },
        rentals: {
          total: totalRentals
        },
        interactions: {
          likes: totalLikes,
          locks: totalLocks,
          bookings: totalBookings
        },
        reports: {
          total: totalReports,
          pending: pendingReports,
          resolved: resolvedReports,
          rejected: rejectedReports
        },
        financials: {
          totalRevenueNGN: totalRevenue,
          successfulLockPaymentsCount: successfulTransactions.length
        }
      }
    });
  } catch (error) {
    console.error("Super Admin - getAnalytics error:", error);
    return res.status(500).json({ success: false, message: "Server error getting analytics" });
  }
}

async function suspendUser(req, res) {
  try {
    const { id } = req.params;
    const user = await Users.findByPk(id);
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    if (user.id === req.user.userId) {
      return res.status(400).json({ success: false, message: "You cannot suspend your own account." });
    }

    user.is_active = false;
    await user.save();

    return res.status(200).json({
      success: true,
      message: "User suspended successfully",
      data: user
    });
  } catch (error) {
    console.error("Super Admin - suspendUser error:", error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
}

async function unsuspendUser(req, res) {
  try {
    const { id } = req.params;
    const user = await Users.findByPk(id);
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    if (user.id === req.user.userId) {
      return res.status(400).json({ success: false, message: "You cannot unsuspend your own account." });
    }

    user.is_active = true;
    await user.save();

    return res.status(200).json({
      success: true,
      message: "User unsuspended successfully",
      data: user
    });
  } catch (error) {
    console.error("Super Admin - unsuspendUser error:", error);
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
  updateReportStatus,
  getAllConversations,
  getConversationMessages,
  getAnalytics,
  suspendUser,
  unsuspendUser
};
