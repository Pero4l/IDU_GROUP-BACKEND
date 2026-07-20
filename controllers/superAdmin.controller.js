const { Users, Rentals, Reports, Progress, Conversations, Messages, Transactions, Waitlist } = require('../models');

async function getAllUsers(req, res) {
  try {
    const users = await Users.findAll({
      attributes: { exclude: ['password', 'otpCode', 'otpExpiresAt'] }
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
    
    const { password, otpCode, otpExpiresAt, ...safeUser } = user.toJSON();
    return res.status(200).json({ 
      success: true, 
      message: `User status updated to ${user.is_active ? 'active' : 'blocked'}`, 
      data: safeUser 
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
      include: [{ model: Users, attributes: ['full_name', 'email'] }]
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
        { model: Users, attributes: ['full_name', 'email'] }
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
        { model: Users, as: 'user', attributes: ['full_name', 'email'] },
        { model: Users, as: 'report_user', attributes: ['full_name', 'email'] }
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
        { model: Users, as: 'tenant', attributes: ['full_name', 'email'] },
        { model: Users, as: 'landlord', attributes: ['full_name', 'email'] }
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
        { model: Users, as: 'sender', attributes: ['full_name', 'email'] }
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
    // Run all database calls in parallel to maximize performance
    const [
      totalUsers,
      activeUsers,
      suspendedUsers,
      tenantsCount,
      landlordsCount,
      adminsCount,
      totalRentals,
      totalLikes,
      totalLocks,
      totalBookings,
      totalReports,
      pendingReports,
      resolvedReports,
      rejectedReports,
      successfulTransactions
    ] = await Promise.all([
      Users.count(),
      Users.count({ where: { is_active: true } }),
      Users.count({ where: { is_active: false } }),
      Users.count({ where: { role: 'tenant' } }),
      Users.count({ where: { role: 'landlord' } }),
      Users.count({ where: { role: 'admin' } }),
      Rentals.count(),
      Progress.count({ where: { liked: true } }),
      Progress.count({ where: { locked: true } }),
      Progress.count({ where: { booked: true } }),
      Reports.count(),
      Reports.count({ where: { report_status: 'pending' } }),
      Reports.count({ where: { report_status: 'resolved' } }),
      Reports.count({ where: { report_status: 'rejected' } }),
      Transactions.findAll({
        where: { status: 'success', payment_type: 'lock_fee' },
        attributes: ['amount']
      })
    ]);

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

    const { password, otpCode, otpExpiresAt, ...safeUser } = user.toJSON();
    return res.status(200).json({
      success: true,
      message: "User suspended successfully",
      data: safeUser
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

    const { password, otpCode, otpExpiresAt, ...safeUser } = user.toJSON();
    return res.status(200).json({
      success: true,
      message: "User unsuspended successfully",
      data: safeUser
    });
  } catch (error) {
    console.error("Super Admin - unsuspendUser error:", error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
}

async function getWaitlist(req, res) {
  try {
    const list = await Waitlist.findAll({
      order: [['createdAt', 'DESC']]
    });
    return res.status(200).json({ success: true, count: list.length, data: list });
  } catch (error) {
    console.error("Super Admin - getWaitlist error:", error);
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
  unsuspendUser,
  getWaitlist
};
