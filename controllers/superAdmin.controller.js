const axios = require('axios');
const { Users, Rentals, Shortlets, ShortletBookings, Reports, Progress, Conversations, Messages, WalletTransactions, Waitlist } = require('../models');

// Shortlet bookings are NOT in this list: the platform holds their payment
// until the host payout, so their wallet rows don't show the final split.
// Their figures come from the shortlet_bookings table instead (see getAnalytics).
const MARKETPLACE_PAYMENT_TYPES = ['lock house', 'house rent', 'inspection fee'];

// Flutterwave's Transfers API rejects calls from IPs not on its whitelist.
// This surfaces the exact outbound IP this server is calling out with, so
// it can be pasted into the Flutterwave dashboard's IP whitelist setting.
async function getOutboundIp(req, res) {
  try {
    const response = await axios.get('https://api.ipify.org?format=json', { timeout: 5000 });
    return res.status(200).json({ success: true, ip: response.data.ip });
  } catch (error) {
    console.error("Super Admin - getOutboundIp error:", error);
    return res.status(500).json({ success: false, message: "Could not determine outbound IP" });
  }
}

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
      totalShortlets,
      totalLikes,
      totalLocks,
      totalBookings,
      totalReports,
      pendingReports,
      resolvedReports,
      rejectedReports,
      successfulTransactions,
      shortletBookings
    ] = await Promise.all([
      Users.count(),
      Users.count({ where: { is_active: true } }),
      Users.count({ where: { is_active: false } }),
      Users.count({ where: { role: 'tenant' } }),
      Users.count({ where: { role: 'landlord' } }),
      Users.count({ where: { role: 'admin' } }),
      Rentals.count(),
      Shortlets.count(),
      Progress.count({ where: { liked: true } }),
      Progress.count({ where: { locked: true } }),
      Progress.count({ where: { booked: true } }),
      Reports.count(),
      Reports.count({ where: { report_status: 'pending' } }),
      Reports.count({ where: { report_status: 'resolved' } }),
      Reports.count({ where: { report_status: 'rejected' } }),
      // Only the payer-side row per payment — the paired landlord-share row
      // carries the same underlying payment and would double-count amounts.
      WalletTransactions.findAll({
        where: { status: 'success', role: 'payer', type: MARKETPLACE_PAYMENT_TYPES },
        attributes: ['type', 'amount', 'meta']
      }),
      ShortletBookings.findAll({
        attributes: ['status', 'payout_status', 'total_amount', 'refunded_amount', 'host_payout', 'platform_fee', 'security_deposit', 'deposit_status', 'deposit_paid_to_host']
      })
    ]);

    // Gross = everything tenants paid. Platform revenue = what we actually
    // keep after the landlord's commission-split share. Both matter: gross
    // moved through the wallet system, but platform revenue is the real number.
    let grossPaymentsNGN = 0;
    let platformRevenueNGN = 0;
    let landlordPayoutsNGN = 0;
    const countsByType = { 'lock house': 0, 'house rent': 0, 'inspection fee': 0 };

    for (const tx of successfulTransactions) {
      const amount = Number(tx.amount) || 0;
      const platformShare = Number(tx.meta?.platformShare ?? amount);
      const landlordShare = Number(tx.meta?.landlordShare ?? 0);
      grossPaymentsNGN += amount;
      platformRevenueNGN += platformShare;
      landlordPayoutsNGN += landlordShare;
      countsByType[tx.type] = (countsByType[tx.type] || 0) + 1;
    }

    // Shortlets: gross is what guests paid minus refunds. Revenue and host
    // payouts only count once a booking is settled; until then it's held.
    // Deposits waiting out the claim window (or a claim decision) are tracked
    // separately; a deposit awarded to a host counts as a host payout.
    const shortletStats = { confirmed: 0, completed: 0, cancelled: 0, heldNGN: 0, depositsHeldNGN: 0, openDepositClaims: 0 };
    for (const b of shortletBookings) {
      const net = (Number(b.total_amount) || 0) - (Number(b.refunded_amount) || 0);
      const depositHeld = ['held', 'claimed'].includes(b.deposit_status) ? Number(b.security_deposit) || 0 : 0;
      shortletStats[b.status] = (shortletStats[b.status] || 0) + 1;
      if (b.deposit_status === 'claimed') shortletStats.openDepositClaims++;
      grossPaymentsNGN += net;
      landlordPayoutsNGN += Number(b.deposit_paid_to_host) || 0;
      if (b.payout_status === 'pending') {
        shortletStats.heldNGN += net;
      } else {
        platformRevenueNGN += Number(b.platform_fee) || 0;
        landlordPayoutsNGN += Number(b.host_payout) || 0;
        shortletStats.depositsHeldNGN += depositHeld;
      }
    }

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
        shortlets: {
          total: totalShortlets
        },
        listings: {
          total: totalRentals + totalShortlets,
          rentals: totalRentals,
          shortlets: totalShortlets
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
          // totalRevenueNGN = what the platform actually keeps (gross minus
          // landlord payouts) — the accurate revenue figure now that lock
          // fees, rent, and inspection fees all split with the landlord.
          totalRevenueNGN: platformRevenueNGN,
          grossPaymentsCollectedNGN: grossPaymentsNGN,
          landlordPayoutsNGN,
          successfulLockPaymentsCount: countsByType['lock house'],
          successfulRentPaymentsCount: countsByType['house rent'],
          successfulInspectionPaymentsCount: countsByType['inspection fee'],
          shortletBookings: {
            confirmed: shortletStats.confirmed,
            completed: shortletStats.completed,
            cancelled: shortletStats.cancelled,
            // Paid by guests but not yet settled (host payout pending)
            heldNGN: Math.round(shortletStats.heldNGN * 100) / 100,
            // Deposits after payout, still in the claim window or under review
            depositsHeldNGN: Math.round(shortletStats.depositsHeldNGN * 100) / 100,
            openDepositClaims: shortletStats.openDepositClaims
          }
        }
      }
    });
  } catch (error) {
    console.error("Super Admin - getAnalytics error:", error);
    return res.status(500).json({ success: false, message: "Server error getting analytics" });
  }
}

// Sets a landlord's SHORTLET commission only (used by utils/shortletSettlement.js).
// Lock / rent / inspection commissions come from .env and are never per-landlord.
async function updateLandlordCommission(req, res) {
  try {
    const { id } = req.params;
    const { commission_percent } = req.body;

    if (commission_percent === undefined || commission_percent === null) {
      return res.status(400).json({ success: false, message: "commission_percent is required" });
    }

    const pct = Number(commission_percent);
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
      return res.status(400).json({ success: false, message: "commission_percent must be between 0 and 100" });
    }

    const user = await Users.findByPk(id);
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    if (user.role !== 'landlord') {
      return res.status(400).json({ success: false, message: "Only landlords can have commission percentages assigned" });
    }

    user.commission_percent = pct;
    await user.save();

    const { password, otpCode, otpExpiresAt, ...safeUser } = user.toJSON();
    return res.status(200).json({ 
      success: true, 
      message: "Landlord shortlet commission percentage updated successfully", 
      data: { full_name: safeUser.full_name, commission_percent: safeUser.commission_percent } 
    });
  } catch (error) {
    console.error("Super Admin - updateLandlordCommission error:", error);
    return res.status(500).json({ success: false, message: "Server error" });
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
  getWaitlist,
  getOutboundIp,
  updateLandlordCommission
};
