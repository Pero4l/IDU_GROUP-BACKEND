const { Progress, Users, Rentals } = require('../models');
const { notifySuperAdmins, logAndEmailUser } = require('./notification.controller');
const { withTransaction } = require('../utils/rollback');
const { chargeMarketplacePayment, InsufficientBalanceError } = require('../utils/wallet');
const { buildPropertyEmailHtml } = require('../utils/emailTemplates');
const logger = require('../utils/logger');
const { Op } = require('sequelize');

// ═══════════════════════════════════════
// LIKED HOUSE CONTROLLERS
// ═══════════════════════════════════════

// POST — like a house
async function likeHouse(req, res) {
  try {
    const { rental_id } = req.body;
    const user_id = req.user.userId;

    if (!rental_id) {
      return res.status(400).json({ success: false, message: "rental_id is required" });
    }

    // Wrap the progress write in a transaction so a partial save never
    // leaves the record in an inconsistent state
    const progressRecord = await withTransaction(async (t) => {
      let record = await Progress.findOne({ where: { user_id, rental_id }, transaction: t });
      if (record) {
        record.liked = true;
        await record.save({ transaction: t });
      } else {
        record = await Progress.create(
          { user_id, rental_id, liked: true, locked: false, booked: false },
          { transaction: t }
        );
      }
      return record;
    }, { context: 'likeHouse', user_id, rental_id });

    logger.info('House liked', { user_id, rental_id });

    // Non-critical side-effects
    const userObj = await Users.findByPk(user_id);
    const rental = await Rentals.findByPk(rental_id);
    const landlord = rental?.UserId ? await Users.findByPk(rental.UserId) : null;

    const likeHtml = buildPropertyEmailHtml({
      heading: "Added to Your Favorites",
      subheading: "You liked a property on RentULO",
      bodyText: "You have successfully added a property to your liked list. Here are the details of the property you liked:",
      recipientName: userObj?.full_name,
      rental,
      landlord
    });
    await logAndEmailUser(user_id, userObj?.email, "Property Liked", likeHtml);

    await notifySuperAdmins(
      `A property has been liked by ${userObj?.full_name ?? user_id}.`,
      'system',
      { heading: 'Property Liked', rental, tenant: userObj, landlord }
    );

    return res.status(200).json({ success: true, message: "House liked successfully", data: progressRecord });
  } catch (error) {
    logger.error('Error liking house', { error: error.message, userId: req.user?.userId });
    return res.status(500).json({ success: false, message: "Server error" });
  }
}

// GET — get liked houses
async function getLikedHouses(req, res) {
  try {
    const user_id = req.user.userId;
    const likedHouses = await Progress.findAll({
      where: { user_id, liked: true },
      include: [{ model: Rentals }]
    });
    return res.status(200).json({ success: true, message: "Liked houses retrieved successfully", data: likedHouses });
  } catch (error) {
    logger.error('Error getting liked houses', { error: error.message, userId: req.user?.userId });
    return res.status(500).json({ success: false, message: "Server error" });
  }
}

// DELETE — unlike a house
async function unlikeHouse(req, res) {
  try {
    const { id } = req.params;
    const user_id = req.user.userId;

    const progressRecord = await Progress.findOne({ where: { rental_id: id, user_id } });
    if (!progressRecord) {
      return res.status(404).json({ success: false, message: "Liked house not found" });
    }

    progressRecord.liked = false;
    await progressRecord.save();

    return res.status(200).json({ success: true, message: "House removed from liked list" });
  } catch (error) {
    logger.error('Error unliking house', { error: error.message, userId: req.user?.userId });
    return res.status(500).json({ success: false, message: "Server error" });
  }
}

// DELETE — unlike all houses
async function deleteAllLikedHouses(req, res) {
  try {
    const user_id = req.user.userId;
    await Progress.update({ liked: false }, { where: { user_id, liked: true } });
    return res.status(200).json({ success: true, message: "All liked houses cleared successfully" });
  } catch (error) {
    logger.error('Error clearing liked houses', { error: error.message, userId: req.user?.userId });
    return res.status(500).json({ success: false, message: "Server error" });
  }
}

// ═══════════════════════════════════════
// LOCKED HOUSE CONTROLLERS
// ═══════════════════════════════════════

const LOCK_FEE_NGN = 5000;

// POST — lock a house (charges the wallet directly, no external gateway)
async function lockHouse(req, res) {
  try {
    const { rental_id } = req.body;
    const user_id = req.user.userId;

    if (!rental_id) {
      return res.status(400).json({ success: false, message: "rental_id is required" });
    }

    const rental = await Rentals.findByPk(rental_id);
    if (!rental) {
      return res.status(404).json({ success: false, message: "Rental not found" });
    }

    // Auto-release expired locks (older than 24 hours)
    const expiryTime = new Date(Date.now() - 24 * 60 * 60 * 1000);
    await Progress.update(
      { locked: false, locked_at: null },
      {
        where: {
          locked: true,
          locked_at: { [Op.lt]: expiryTime }
        }
      }
    );

    // Check concurrent active locks in parallel
    const [userActiveLock, alreadyLocked] = await Promise.all([
      Progress.findOne({
        where: {
          user_id,
          locked: true
        }
      }),
      Progress.findOne({
        where: {
          rental_id,
          locked: true
        }
      })
    ]);

    if (userActiveLock) {
      return res.status(400).json({
        success: false,
        message: "You can only lock one house at a time. You already have an active locked property."
      });
    }

    if (alreadyLocked) {
      return res.status(400).json({
        success: false,
        message: "This property is already locked by another user"
      });
    }

    // Find if a progress record exists for this user and rental — create one
    // if not, since liking first is no longer required before locking.
    let progressRecord = await Progress.findOne({ where: { user_id, rental_id } });
    if (!progressRecord) {
      progressRecord = await Progress.create({ user_id, rental_id, liked: false, locked: false, booked: false });
    }

    let chargeResult;
    try {
      chargeResult = await chargeMarketplacePayment({
        payerUserId: user_id,
        landlordUserId: rental.UserId,
        amount: LOCK_FEE_NGN,
        commissionPercent: Number(process.env.PLATFORM_LOCK_COMMISSION_PERCENT ?? 100),
        type: 'lock house',
        narration: `Lock fee for "${rental.title}"`,
        // Runs inside the same DB transaction as the charge — if locking
        // fails, the charge rolls back too, so the tenant is never charged
        // without the house actually being locked.
        applyEffects: async (t) => {
          progressRecord.locked = true;
          progressRecord.locked_at = new Date();
          await progressRecord.save({ transaction: t });
        },
      });
    } catch (error) {
      if (error instanceof InsufficientBalanceError) {
        return res.status(400).json({
          success: false,
          message: "Insufficient wallet balance. Please top up your wallet to lock this house."
        });
      }
      throw error;
    }

    const userObj = await Users.findByPk(user_id);
    const landlord = rental.UserId ? await Users.findByPk(rental.UserId) : null;
    const lockTransaction = { amount: LOCK_FEE_NGN, reference: 'Wallet Payment', payment_type: 'lock_fee' };

    const lockHtml = buildPropertyEmailHtml({
      heading: "Property Locked Successfully",
      subheading: "Receipt & Confirmation",
      bodyText: `We have successfully deducted <strong>₦${LOCK_FEE_NGN.toLocaleString()}</strong> from your wallet. The property has been locked and reserved for you.`,
      recipientName: userObj?.full_name,
      rental,
      transaction: lockTransaction,
      landlord
    });
    await logAndEmailUser(user_id, userObj?.email, "Property Locked", lockHtml);

    await notifySuperAdmins(
      `A property has been successfully locked by ${userObj?.full_name ?? user_id} after wallet payment.`,
      'system',
      { heading: 'Property Locked', rental, transaction: lockTransaction, tenant: userObj, landlord }
    );

    return res.status(200).json({
      success: true,
      message: "House locked successfully",
      data: progressRecord,
      walletBalance: chargeResult.payerBalance
    });

  } catch (error) {
    logger.error('Error locking house', { error: error.message, userId: req.user?.userId });
    return res.status(500).json({ success: false, message: "Server error" });
  }
}

// GET — get locked houses
async function getLockedHouses(req, res) {
  try {
    const user_id = req.user.userId;

    // Auto-release expired locks (older than 24 hours)
    const expiryTime = new Date(Date.now() - 24 * 60 * 60 * 1000);
    await Progress.update(
      { locked: false, locked_at: null },
      {
        where: {
          locked: true,
          locked_at: { [Op.lt]: expiryTime }
        }
      }
    );

    const lockedHouses = await Progress.findAll({
      where: { user_id, locked: true },
      include: [{ model: Rentals }]
    });
    return res.status(200).json({ success: true, message: "Locked houses retrieved successfully", data: lockedHouses });
  } catch (error) {
    logger.error('Error getting locked houses', { error: error.message, userId: req.user?.userId });
    return res.status(500).json({ success: false, message: "Server error" });
  }
}

// DELETE — unlock a house
async function deleteLockedHouse(req, res) {
  try {
    const { id } = req.params;
    const user_id = req.user.userId;

    const progressRecord = await Progress.findOne({ where: { rental_id: id, user_id } });
    if (!progressRecord) {
      return res.status(404).json({ success: false, message: "Locked house not found" });
    }

    progressRecord.locked = false;
    progressRecord.locked_at = null;
    await progressRecord.save();

    return res.status(200).json({ success: true, message: "House removed from locked list" });
  } catch (error) {
    logger.error('Error unlocking house', { error: error.message, userId: req.user?.userId });
    return res.status(500).json({ success: false, message: "Server error" });
  }
}

// DELETE — unlock all houses
async function deleteAllLockedHouses(req, res) {
  try {
    const user_id = req.user.userId;
    await Progress.update({ locked: false }, { where: { user_id, locked: true } });
    return res.status(200).json({ success: true, message: "All locked houses cleared successfully" });
  } catch (error) {
    logger.error('Error clearing locked houses', { error: error.message, userId: req.user?.userId });
    return res.status(500).json({ success: false, message: "Server error" });
  }
}

// ═══════════════════════════════════════
// BOOKED HOUSE CONTROLLERS
// ═══════════════════════════════════════

// POST — book a house
async function bookHouse(req, res) {
  try {
    const { rental_id } = req.body;
    const user_id = req.user.userId;

    if (!rental_id) {
      return res.status(400).json({ success: false, message: "rental_id is required" });
    }

    const progressRecord = await withTransaction(async (t) => {
      let record = await Progress.findOne({ where: { user_id, rental_id }, transaction: t });

      if (!record) {
        record = await Progress.create({ user_id, rental_id, liked: false, locked: false, booked: true }, { transaction: t });
      } else {
        record.booked = true;
        await record.save({ transaction: t });
      }
      return record;
    }, { context: 'bookHouse', user_id, rental_id });

    logger.info('House booked', { user_id, rental_id });

    const userObj = await Users.findByPk(user_id);
    const rental = await Rentals.findByPk(rental_id);
    const landlord = rental?.UserId ? await Users.findByPk(rental.UserId) : null;

    const bookHtml = buildPropertyEmailHtml({
      heading: "Property Booked Successfully",
      subheading: "Booking Confirmation",
      bodyText: "You have successfully booked a property on RentULO. Here are the details of your booking:",
      recipientName: userObj?.full_name,
      rental,
      landlord
    });
    await logAndEmailUser(user_id, userObj?.email, "Property Booked", bookHtml);

    await notifySuperAdmins(
      `A property has been successfully booked by ${userObj?.full_name ?? user_id}.`,
      'system',
      { heading: 'Property Booked', rental, tenant: userObj, landlord }
    );

    return res.status(200).json({ success: true, message: "House booked successfully", data: progressRecord });
  } catch (error) {
    logger.error('Error booking house', { error: error.message, userId: req.user?.userId });
    return res.status(500).json({ success: false, message: "Server error" });
  }
}

// GET — get booked houses
async function getBookedHouses(req, res) {
  try {
    const user_id = req.user.userId;
    const bookedHouses = await Progress.findAll({
      where: { user_id, booked: true },
      include: [{ model: Rentals }]
    });
    return res.status(200).json({ success: true, message: "Booked houses retrieved successfully", data: bookedHouses });
  } catch (error) {
    logger.error('Error getting booked houses', { error: error.message, userId: req.user?.userId });
    return res.status(500).json({ success: false, message: "Server error" });
  }
}

// DELETE — unbook a house
async function deleteBookedHouse(req, res) {
  try {
    const { id } = req.params;
    const user_id = req.user.userId;

    const progressRecord = await Progress.findOne({ where: { rental_id: id, user_id } });
    if (!progressRecord) {
      return res.status(404).json({ success: false, message: "Booked house not found" });
    }

    progressRecord.booked = false;
    await progressRecord.save();

    return res.status(200).json({ success: true, message: "House removed from booked list" });
  } catch (error) {
    logger.error('Error unbooking house', { error: error.message, userId: req.user?.userId });
    return res.status(500).json({ success: false, message: "Server error" });
  }
}

// DELETE — unbook all houses
async function deleteAllBookedHouses(req, res) {
  try {
    const user_id = req.user.userId;
    await Progress.update({ booked: false }, { where: { user_id, booked: true } });
    return res.status(200).json({ success: true, message: "All booked houses cleared successfully" });
  } catch (error) {
    logger.error('Error clearing booked houses', { error: error.message, userId: req.user?.userId });
    return res.status(500).json({ success: false, message: "Server error" });
  }
}

// ==========================
// RENT PAYMENT CONTROLLERS
// ==========================

// Pay rent — charges the wallet for the total package (price + fees) directly ===> POST
async function payRent(req, res) {
  try {
    const { rental_id } = req.body;
    const user_id = req.user.userId;

    if (!rental_id) {
      return res.status(400).json({ success: false, message: "rental_id is required" });
    }

    const rental = await Rentals.findByPk(rental_id);
    if (!rental) {
      return res.status(404).json({ success: false, message: "Rental property not found" });
    }

    if (rental.status === 'rented') {
      return res.status(400).json({ success: false, message: "This property has already been rented" });
    }

    // Check if property is locked by someone else
    const activeLock = await Progress.findOne({
      where: {
        rental_id,
        locked: true
      }
    });

    if (activeLock && activeLock.user_id !== user_id) {
      return res.status(400).json({ success: false, message: "This property is currently locked by another user" });
    }

    // Calculate total pricing (Price + Legal + Caution + Broker + Service Charge)
    const price = parseFloat(rental.price) || 0;
    const legalFee = parseFloat(rental.legalFee) || 0;
    const cautionFee = parseFloat(rental.cautionFee) || 0;
    const brokeFee = parseFloat(rental.brokeFee) || 0;
    const mgtServiceCharge = parseFloat(rental.mgtServiceCharge) || 0;

    const totalAmount = price + legalFee + cautionFee + brokeFee + mgtServiceCharge;

    let chargeResult;
    try {
      chargeResult = await chargeMarketplacePayment({
        payerUserId: user_id,
        landlordUserId: rental.UserId,
        amount: totalAmount,
        commissionPercent: Number(process.env.PLATFORM_RENT_COMMISSION_PERCENT ?? 100),
        type: 'house rent',
        narration: `Rent payment for "${rental.title}"`,
        // Runs inside the same DB transaction as the charge — if marking the
        // rental rented fails, the charge rolls back too.
        applyEffects: async (t) => {
          rental.status = 'rented';
          await rental.save({ transaction: t });

          let record = await Progress.findOne({ where: { user_id, rental_id }, transaction: t, lock: t.LOCK.UPDATE });
          if (record) {
            record.locked = false;
            record.locked_at = null;
            record.booked = true;
            await record.save({ transaction: t });
          } else {
            record = await Progress.create({
              user_id,
              rental_id,
              liked: false,
              locked: false,
              booked: true
            }, { transaction: t });
          }
          return record;
        },
      });
    } catch (error) {
      if (error instanceof InsufficientBalanceError) {
        return res.status(400).json({
          success: false,
          message: "Insufficient wallet balance. Please top up your wallet to pay for this rental."
        });
      }
      throw error;
    }

    const progressRecord = chargeResult.effects;
    const userObj = await Users.findByPk(user_id);
    const rentTransaction = { amount: totalAmount, reference: 'Wallet Payment', payment_type: 'rent_payment' };
    let landlord = null;

    if (rental.UserId) {
      landlord = await Users.findByPk(rental.UserId);
    }

    const tenantHtml = buildPropertyEmailHtml({
      heading: "Rent Paid Successfully",
      subheading: "Payment Receipt Confirmation",
      bodyText: `You have successfully paid the rent of <strong>₦${totalAmount.toLocaleString()}</strong> for the property: <strong>${rental.title}</strong> from your wallet.`,
      recipientName: userObj?.full_name,
      rental,
      transaction: rentTransaction,
      landlord
    });
    await logAndEmailUser(user_id, userObj?.email, "Rent Paid Successfully", tenantHtml);

    if (landlord) {
      const landlordHtml = buildPropertyEmailHtml({
        heading: "Property Rented",
        subheading: "Congratulations! Your property has a new tenant",
        bodyText: `Your property <strong>"${rental.title}"</strong> has been successfully rented by <strong>${userObj.full_name}</strong>. Your share of <strong>₦${chargeResult.landlordShare.toLocaleString()}</strong> has been credited to your wallet.`,
        recipientName: landlord.full_name,
        rental,
        transaction: rentTransaction,
        tenant: userObj
      });
      await logAndEmailUser(rental.UserId, landlord.email, "Property Rented", landlordHtml);
    }

    await notifySuperAdmins(
      `Property "${rental.title}" has been successfully rented by ${userObj?.full_name ?? user_id} after wallet payment.`,
      'system',
      { heading: 'Property Rented', rental, transaction: rentTransaction, tenant: userObj, landlord }
    );

    return res.status(200).json({
      success: true,
      message: "Rent paid and property rented successfully",
      data: progressRecord,
      walletBalance: chargeResult.payerBalance
    });

  } catch (error) {
    logger.error('Error paying rent', { error: error.message, userId: req.user?.userId });
    return res.status(500).json({ success: false, message: "Server error" });
  }
}

module.exports = {
  // Liked
  likeHouse, getLikedHouses, unlikeHouse, deleteAllLikedHouses,
  // Locked
  lockHouse, getLockedHouses, deleteLockedHouse, deleteAllLockedHouses,
  // Booked
  bookHouse, getBookedHouses, deleteBookedHouse, deleteAllBookedHouses,
  // Rent Payment
  payRent
};
