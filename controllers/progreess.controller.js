const { Progress, Users, Rentals, Transactions } = require('../models');
const { notifySuperAdmins, logAndEmailUser } = require('./notification.controller');
const { withTransaction } = require('../utils/rollback');
const logger = require('../utils/logger');
const axios = require('axios');
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
    const likeHtml = buildPropertyEmailHtml({
      heading: "Added to Your Favorites",
      subheading: "You liked a property on RentULO",
      bodyText: "You have successfully added a property to your liked list. Here are the details of the property you liked:",
      rental,
      userObj
    });
    await logAndEmailUser(user_id, userObj?.email, "Property Liked", likeHtml);
    await notifySuperAdmins(`A property has been liked by user ${user_id}.`, 'system');

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

// POST — lock a house
// 1. Initialize lock payment via Paystack ===> POST
async function initializeLockPayment(req, res) {
  try {
    const { rental_id } = req.body;
    const user_id = req.user.userId;
    const userEmail = req.user.email; // Extracted from JWT token

    if (!rental_id) {
      return res.status(400).json({ success: false, message: "rental_id is required" });
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

    // Find if a progress record exists for this user and rental
    let progressRecord = await Progress.findOne({ where: { user_id, rental_id } });

    if (!progressRecord || !progressRecord.liked) {
      return res.status(400).json({
        success: false,
        message: "You must like the house first before locking it"
      });
    }

    // Amount to lock house in kobo (e.g., 50 NGN = 5000 kobo)
    const amountInKobo = 5000; 

    // Dynamically build default callback url pointing back to our server
    const host = req.get('host');
    const protocol = req.protocol;
    const defaultCallback = `${protocol}://${host}/progress/lock/verify-callback`;
    const callbackUrl = process.env.PAYSTACK_CALLBACK_URL || defaultCallback;

    // Generate Paystack initialization request
    const response = await axios.post(
      'https://api.paystack.co/transaction/initialize',
      {
        email: userEmail,
        amount: amountInKobo,
        callback_url: callbackUrl,
        metadata: {
          user_id,
          rental_id,
          payment_type: 'lock_fee'
        }
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );

    const { authorization_url, reference } = response.data.data;

    // Create a pending transaction record
    await Transactions.create({
      user_id,
      rental_id,
      reference,
      amount: amountInKobo / 100, // store in NGN
      status: 'pending',
      payment_type: 'lock_fee'
    });

    return res.status(200).json({
      success: true,
      message: "Payment initialization successful",
      authorization_url,
      reference
    });

  } catch (error) {
    console.error("Error initializing lock payment:", error.response ? error.response.data : error.message);
    return res.status(500).json({ success: false, message: "Server error during payment initialization" });
  }
}

// 2. Verify lock payment and successfully lock the house ===> POST
async function verifyLockPayment(req, res) {
  try {
    const { reference } = req.body;
    const user_id = req.user.userId;

    if (!reference) {
      return res.status(400).json({ success: false, message: "Transaction reference is required" });
    }

    // Find the pending transaction
    const transaction = await Transactions.findOne({ where: { reference, user_id } });
    if (!transaction) {
      return res.status(404).json({ success: false, message: "Transaction not found" });
    }

    if (transaction.status === 'success') {
      return res.status(400).json({ success: false, message: "Transaction already processed" });
    }

    // Verify with Paystack
    const response = await axios.get(`https://api.paystack.co/transaction/verify/${reference}`, {
      headers: {
        Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`
      }
    });

    const paymentStatus = response.data.data.status;

    if (paymentStatus === 'success') {
      // Update transaction
      transaction.status = 'success';
      await transaction.save();

      // Update progress record
      let progressRecord = await Progress.findOne({ where: { user_id, rental_id: transaction.rental_id } });
      if (progressRecord) {
        progressRecord.locked = true;
        progressRecord.locked_at = new Date();
        await progressRecord.save();
      } else {
        progressRecord = await Progress.create({
          user_id,
          rental_id: transaction.rental_id,
          liked: false,
          locked: true,
          locked_at: new Date()
        });
      }

      const userObj = await Users.findByPk(user_id);
      const rental = await Rentals.findByPk(transaction.rental_id);
      const lockHtml = buildPropertyEmailHtml({
        heading: "Property Locked Successfully",
        subheading: "Receipt & Confirmation",
        bodyText: `We have successfully verified your payment of <strong>₦${transaction.amount.toLocaleString()}</strong>. The property has been locked and reserved for you.`,
        rental,
        transaction,
        userObj
      });
      await logAndEmailUser(user_id, userObj?.email, "Property Locked", lockHtml);
      await notifySuperAdmins(`A property has been successfully locked by user ${user_id} after successful payment.`, 'system');

      return res.status(200).json({
        success: true,
        message: "Payment verified and house locked successfully",
        data: progressRecord,
        redirectUrl: process.env.PAYSTACK_REDIRECT_URL || "https://rentulo.ng/tenant/locked-house"
      });
    } else {
      transaction.status = 'failed';
      await transaction.save();
      return res.status(400).json({
        success: false,
        message: `Payment verification failed. Status: ${paymentStatus}`,
        redirectUrl: process.env.PAYSTACK_FAILURE_URL || "https://rentulo.ng/tenant/locked-house"
      });
    }

  } catch (error) {
    console.error("Error verifying payment:", error.response ? error.response.data : error.message);
    return res.status(500).json({ success: false, message: "Server error during payment verification" });
  }
}

// 3. Callback verification for browser redirects ===> GET
async function verifyLockPaymentCallback(req, res) {
  try {
    const { reference } = req.query;

    if (!reference) {
      return res.redirect(process.env.PAYSTACK_FAILURE_URL || "https://rentulo.com/payment-failed");
    }

    // Find the pending transaction
    const transaction = await Transactions.findOne({ where: { reference } });
    if (!transaction) {
      return res.redirect(process.env.PAYSTACK_FAILURE_URL || "https://rentulo.com/payment-failed");
    }

    if (transaction.status === 'success') {
      return res.redirect(process.env.PAYSTACK_REDIRECT_URL || "https://rentulo.com/payment-success");
    }

    // Verify with Paystack
    const response = await axios.get(`https://api.paystack.co/transaction/verify/${reference}`, {
      headers: {
        Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`
      }
    });

    const paymentStatus = response.data.data.status;

    if (paymentStatus === 'success') {
      // Update transaction
      transaction.status = 'success';
      await transaction.save();

      // Update progress record
      let progressRecord = await Progress.findOne({ where: { user_id: transaction.user_id, rental_id: transaction.rental_id } });
      if (progressRecord) {
        progressRecord.locked = true;
        progressRecord.locked_at = new Date();
        await progressRecord.save();
      } else {
        await Progress.create({
          user_id: transaction.user_id,
          rental_id: transaction.rental_id,
          liked: false,
          locked: true,
          locked_at: new Date()
        });
      }

      const userObj = await Users.findByPk(transaction.user_id);
      const rental = await Rentals.findByPk(transaction.rental_id);
      const lockHtml = buildPropertyEmailHtml({
        heading: "Property Locked Successfully",
        subheading: "Receipt & Confirmation",
        bodyText: `We have successfully verified your payment of <strong>₦${transaction.amount.toLocaleString()}</strong>. The property has been locked and reserved for you.`,
        rental,
        transaction,
        userObj
      });
      await logAndEmailUser(transaction.user_id, userObj?.email, "Property Locked", lockHtml);
      await notifySuperAdmins(`A property has been successfully locked by user ${transaction.user_id} after successful payment.`, 'system');

      return res.redirect(process.env.PAYSTACK_REDIRECT_URL || "https://rentulo.com/payment-success");
    } else {
      transaction.status = 'failed';
      await transaction.save();
      return res.redirect(process.env.PAYSTACK_FAILURE_URL || "https://rentulo.com/payment-failed");
    }

  } catch (error) {
    console.error("Error in verifyLockPaymentCallback:", error.response ? error.response.data : error.message);
    return res.redirect(process.env.PAYSTACK_FAILURE_URL || "https://rentulo.com/payment-failed");
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
      const record = await Progress.findOne({ where: { user_id, rental_id }, transaction: t });

      if (!record || !record.liked) {
        const err = new Error("MUST_LIKE_FIRST");
        err.statusCode = 400;
        throw err;
      }

      record.booked = true;
      await record.save({ transaction: t });
      return record;
    }, { context: 'bookHouse', user_id, rental_id });

    logger.info('House booked', { user_id, rental_id });

    const userObj = await Users.findByPk(user_id);
    const rental = await Rentals.findByPk(rental_id);
    const bookHtml = buildPropertyEmailHtml({
      heading: "Property Booked Successfully",
      subheading: "Booking Confirmation",
      bodyText: "You have successfully booked a property on RentULO. Here are the details of your booking:",
      rental,
      userObj
    });
    await logAndEmailUser(user_id, userObj?.email, "Property Booked", bookHtml);
    await notifySuperAdmins(`A property has been successfully booked by user ${user_id}.`, 'system');

    return res.status(200).json({ success: true, message: "House booked successfully", data: progressRecord });
  } catch (error) {
    if (error.message === "MUST_LIKE_FIRST") {
      return res.status(400).json({ success: false, message: "You must like the house first before booking it" });
    }
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

// 1. Initialize rent payment via Paystack ===> POST
async function initializeRentPayment(req, res) {
  try {
    const { rental_id } = req.body;
    const user_id = req.user.userId;
    const userEmail = req.user.email; // Extracted from JWT token

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
    const amountInKobo = Math.round(totalAmount * 100);

    const host = req.get('host');
    const protocol = req.protocol;
    const defaultCallback = `${protocol}://${host}/progress/rent/verify-callback`;
    const callbackUrl = process.env.PAYSTACK_CALLBACK_URL || defaultCallback;

    // Generate Paystack initialization request
    const response = await axios.post(
      'https://api.paystack.co/transaction/initialize',
      {
        email: userEmail,
        amount: amountInKobo,
        callback_url: callbackUrl,
        metadata: {
          user_id,
          rental_id,
          payment_type: 'rent_payment'
        }
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );

    const { authorization_url, reference } = response.data.data;

    // Create a pending transaction record
    await Transactions.create({
      user_id,
      rental_id,
      reference,
      amount: totalAmount, // store in NGN
      status: 'pending',
      payment_type: 'rent_payment'
    });

    return res.status(200).json({
      success: true,
      message: "Rent payment initialization successful",
      authorization_url,
      reference
    });

  } catch (error) {
    console.error("Error initializing rent payment:", error.response ? error.response.data : error.message);
    return res.status(500).json({ success: false, message: "Server error during payment initialization" });
  }
}

// 2. Verify rent payment via reference ===> POST
async function verifyRentPayment(req, res) {
  try {
    const { reference } = req.body;
    const user_id = req.user.userId;

    if (!reference) {
      return res.status(400).json({ success: false, message: "Transaction reference is required" });
    }

    // Find the pending transaction
    const transaction = await Transactions.findOne({ where: { reference, user_id } });
    if (!transaction) {
      return res.status(404).json({ success: false, message: "Transaction not found" });
    }

    if (transaction.status === 'success') {
      return res.status(400).json({ success: false, message: "Transaction already processed" });
    }

    // Verify with Paystack
    const response = await axios.get(`https://api.paystack.co/transaction/verify/${reference}`, {
      headers: {
        Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`
      }
    });

    const paymentStatus = response.data.data.status;

    if (paymentStatus === 'success') {
      // Update transaction
      transaction.status = 'success';
      await transaction.save();

      // Update rental status to rented
      const rental = await Rentals.findByPk(transaction.rental_id);
      if (rental) {
        rental.status = 'rented';
        await rental.save();
      }

      // Update progress record
      let progressRecord = await Progress.findOne({ where: { user_id, rental_id: transaction.rental_id } });
      if (progressRecord) {
        progressRecord.locked = false;
        progressRecord.locked_at = null;
        progressRecord.booked = true;
        await progressRecord.save();
      } else {
        progressRecord = await Progress.create({
          user_id,
          rental_id: transaction.rental_id,
          liked: false,
          locked: false,
          booked: true
        });
      }

      const userObj = await Users.findByPk(user_id);
      const tenantHtml = buildPropertyEmailHtml({
        heading: "Rent Paid Successfully",
        subheading: "Payment Receipt Confirmation",
        bodyText: `You have successfully paid the rent of <strong>₦${transaction.amount.toLocaleString()}</strong> for the property: <strong>${rental?.title || 'Rental'}</strong>.`,
        rental,
        transaction,
        userObj
      });
      await logAndEmailUser(user_id, userObj?.email, "Rent Paid Successfully", tenantHtml);

      if (rental && rental.UserId) {
        const landlord = await Users.findByPk(rental.UserId);
        if (landlord) {
          const landlordHtml = buildPropertyEmailHtml({
            heading: "Property Rented",
            subheading: "Congratulations! Your property has a new tenant",
            bodyText: `Your property <strong>"${rental.title}"</strong> has been successfully rented by <strong>${userObj.full_name}</strong>. Payment of <strong>₦${transaction.amount.toLocaleString()}</strong> was received.`,
            rental,
            transaction,
            landlord
          });
          await logAndEmailUser(rental.UserId, landlord.email, "Property Rented", landlordHtml);
        }
      }

      await notifySuperAdmins(`Property "${rental?.title || 'Rental'}" has been successfully rented by user ${user_id} after successful rent payment.`, 'system');

      return res.status(200).json({
        success: true,
        message: "Rent payment verified and property rented successfully",
        data: progressRecord,
        redirectUrl: process.env.PAYSTACK_REDIRECT_URL || "https://rentulo.com/payment-success"
      });
    } else {
      transaction.status = 'failed';
      await transaction.save();
      return res.status(400).json({
        success: false,
        message: `Payment verification failed. Status: ${paymentStatus}`,
        redirectUrl: process.env.PAYSTACK_FAILURE_URL || "https://rentulo.com/payment-failed"
      });
    }

  } catch (error) {
    console.error("Error verifying rent payment:", error.response ? error.response.data : error.message);
    return res.status(500).json({ success: false, message: "Server error during payment verification" });
  }
}

// 3. Callback verification for browser redirects ===> GET
async function verifyRentPaymentCallback(req, res) {
  try {
    const { reference } = req.query;

    if (!reference) {
      return res.redirect(process.env.PAYSTACK_FAILURE_URL || "https://rentulo.com/payment-failed");
    }

    // Find the pending transaction
    const transaction = await Transactions.findOne({ where: { reference } });
    if (!transaction) {
      return res.redirect(process.env.PAYSTACK_FAILURE_URL || "https://rentulo.com/payment-failed");
    }

    if (transaction.status === 'success') {
      return res.redirect(process.env.PAYSTACK_REDIRECT_URL || "https://rentulo.com/payment-success");
    }

    // Verify with Paystack
    const response = await axios.get(`https://api.paystack.co/transaction/verify/${reference}`, {
      headers: {
        Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`
      }
    });

    const paymentStatus = response.data.data.status;

    if (paymentStatus === 'success') {
      // Update transaction
      transaction.status = 'success';
      await transaction.save();

      // Update rental status
      const rental = await Rentals.findByPk(transaction.rental_id);
      if (rental) {
        rental.status = 'rented';
        await rental.save();
      }

      // Update progress record
      let progressRecord = await Progress.findOne({ where: { user_id: transaction.user_id, rental_id: transaction.rental_id } });
      if (progressRecord) {
        progressRecord.locked = false;
        progressRecord.locked_at = null;
        progressRecord.booked = true;
        await progressRecord.save();
      } else {
        await Progress.create({
          user_id: transaction.user_id,
          rental_id: transaction.rental_id,
          liked: false,
          locked: false,
          booked: true
        });
      }

      const userObj = await Users.findByPk(transaction.user_id);
      const tenantHtml = buildPropertyEmailHtml({
        heading: "Rent Paid Successfully",
        subheading: "Payment Receipt Confirmation",
        bodyText: `You have successfully paid the rent of <strong>₦${transaction.amount.toLocaleString()}</strong> for the property: <strong>${rental?.title || 'Rental'}</strong>.`,
        rental,
        transaction,
        userObj
      });
      await logAndEmailUser(transaction.user_id, userObj?.email, "Rent Paid Successfully", tenantHtml);

      if (rental && rental.UserId) {
        const landlord = await Users.findByPk(rental.UserId);
        if (landlord) {
          const landlordHtml = buildPropertyEmailHtml({
            heading: "Property Rented",
            subheading: "Congratulations! Your property has a new tenant",
            bodyText: `Your property <strong>"${rental.title}"</strong> has been successfully rented by <strong>${userObj.full_name}</strong>. Payment of <strong>₦${transaction.amount.toLocaleString()}</strong> was received.`,
            rental,
            transaction,
            landlord
          });
          await logAndEmailUser(rental.UserId, landlord.email, "Property Rented", landlordHtml);
        }
      }

      await notifySuperAdmins(`Property "${rental?.title || 'Rental'}" has been successfully rented by user ${transaction.user_id} after successful rent payment.`, 'system');

      return res.redirect(process.env.PAYSTACK_REDIRECT_URL || "https://rentulo.com/payment-success");
    } else {
      transaction.status = 'failed';
      await transaction.save();
      return res.redirect(process.env.PAYSTACK_FAILURE_URL || "https://rentulo.com/payment-failed");
    }

  } catch (error) {
    console.error("Error in verifyRentPaymentCallback:", error.response ? error.response.data : error.message);
    return res.redirect(process.env.PAYSTACK_FAILURE_URL || "https://rentulo.com/payment-failed");
  }
}

/**
 * Helper to build a professional styled email layout with light green color scheme
 */
function buildPropertyEmailHtml({ heading, subheading, bodyText, rental, transaction, userObj, landlord }) {
  let imageUrl = '';
  if (rental && rental.images) {
    if (Array.isArray(rental.images) && rental.images.length > 0) {
      imageUrl = rental.images[0];
    } else if (typeof rental.images === 'string') {
      try {
        const parsed = JSON.parse(rental.images);
        if (Array.isArray(parsed) && parsed.length > 0) {
          imageUrl = parsed[0];
        }
      } catch (_) {
        imageUrl = rental.images;
      }
    }
  }

  const currentYear = new Date().getFullYear();
  
  // Custom card section for property if present
  let propertyCardHtml = '';
  if (rental) {
    const priceText = rental.price ? `₦${rental.price.toLocaleString()}` : '';
    const priceTypeSuffix = rental.priceType ? ` / ${rental.priceType}` : '';
    propertyCardHtml = `
      <div style="border: 1px solid #e5e7eb; border-radius: 10px; overflow: hidden; margin: 20px 0; background-color: #ffffff; box-shadow: 0 2px 8px rgba(0,0,0,0.02);">
        ${imageUrl ? `<img src="${imageUrl}" alt="${rental.title}" style="width: 100%; height: 180px; object-fit: cover; border-bottom: 1px solid #e5e7eb;" />` : ''}
        <div style="padding: 15px;">
          <h4 style="margin: 0 0 5px 0; color: #111827; font-size: 15px; font-weight: 600;">${rental.title}</h4>
          ${priceText ? `<p style="margin: 0 0 5px 0; color: #10b981; font-size: 16px; font-weight: 700;">${priceText}<span style="font-size: 12px; font-weight: normal; color: #6b7280;">${priceTypeSuffix}</span></p>` : ''}
          <p style="margin: 0; color: #6b7280; font-size: 13px;">📍 ${rental.location}</p>
        </div>
      </div>
    `;
  }

  // Custom receipt section if transaction details are present
  let receiptHtml = '';
  if (transaction) {
    receiptHtml = `
      <div style="background-color: #f9fafb; border: 1px solid #e5e7eb; border-radius: 8px; padding: 20px; margin: 20px 0;">
        <h4 style="margin: 0 0 15px 0; color: #111827; font-size: 14px; text-transform: uppercase; letter-spacing: 0.5px; border-bottom: 1px solid #e5e7eb; padding-bottom: 8px;">Transaction Summary</h4>
        <table style="width: 100%; border-collapse: collapse; font-size: 14px;">
          <tr>
            <td style="padding: 5px 0; color: #6b7280;">Payment Type:</td>
            <td style="padding: 5px 0; text-align: right; color: #111827; font-weight: 500;">${transaction.payment_type === 'lock_fee' ? 'Lock Fee' : 'Rent Payment'}</td>
          </tr>
          <tr>
            <td style="padding: 5px 0; color: #6b7280;">Amount Paid:</td>
            <td style="padding: 5px 0; text-align: right; color: #10b981; font-weight: 600;">₦${transaction.amount.toLocaleString()}</td>
          </tr>
          <tr>
            <td style="padding: 5px 0; color: #6b7280;">Reference:</td>
            <td style="padding: 5px 0; text-align: right; color: #111827; font-family: monospace; font-size: 12px;">${transaction.reference}</td>
          </tr>
          <tr>
            <td style="padding: 5px 0; color: #6b7280;">Status:</td>
            <td style="padding: 5px 0; text-align: right; color: #10b981; font-weight: 600;">Success</td>
          </tr>
        </table>
      </div>
    `;
  }

  // Action Button
  let actionButtonHtml = '';
  if (rental) {
    const btnLabel = transaction ? (landlord ? 'Go to Dashboard' : 'View Reservation') : 'View Listing';
    const btnUrl = rental.slug ? `https://rentulo.ng/listings/${rental.slug}` : 'https://rentulo.ng/dashboard';
    actionButtonHtml = `
      <div style="text-align: center; margin: 30px 0 10px 0;">
        <a href="${btnUrl}" 
           style="background-color: #10b981; color: #ffffff; padding: 12px 24px; text-decoration: none; border-radius: 8px; font-size: 14px; font-weight: 600; display: inline-block; box-shadow: 0 4px 6px rgba(16, 185, 129, 0.15);">
          ${btnLabel}
        </a>
      </div>
    `;
  } else {
    actionButtonHtml = `
      <div style="text-align: center; margin: 30px 0 10px 0;">
        <a href="https://rentulo.ng/dashboard" 
           style="background-color: #10b981; color: #ffffff; padding: 12px 24px; text-decoration: none; border-radius: 8px; font-size: 14px; font-weight: 600; display: inline-block; box-shadow: 0 4px 6px rgba(16, 185, 129, 0.15);">
          Go to Dashboard
        </a>
      </div>
    `;
  }

  const recipientName = userObj ? userObj.full_name : (landlord ? landlord.full_name : 'User');

  return `
    <div style="font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; background-color: #f4f7f6; padding: 30px 15px;">
      <div style="max-width: 550px; margin: 0 auto; background-color: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 15px rgba(0,0,0,0.05); border-top: 4px solid #10b981;">
        <div style="padding: 25px; text-align: center; background-color: #f0fdf4;">
          <div style="background-color: #d1fae5; width: 50px; height: 50px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; margin-bottom: 10px; margin-left: auto; margin-right: auto;">
            <span style="font-size: 24px;">${transaction ? '💰' : '❤️'}</span>
          </div>
          <h2 style="margin: 0; color: #064e3b; font-size: 20px; font-weight: 700;">${heading}</h2>
          <p style="margin: 5px 0 0 0; color: #047857; font-size: 14px;">${subheading}</p>
        </div>

        <div style="padding: 30px; color: #374151; font-size: 15px; line-height: 1.6;">
          <p>Hello <strong>${recipientName}</strong>,</p>
          <p>${bodyText}</p>
          
          ${propertyCardHtml}
          ${receiptHtml}
          ${actionButtonHtml}
        </div>

        <div style="background-color: #f9fafb; padding: 20px 30px; text-align: center; border-top: 1px solid #e5e7eb;">
          <p style="margin: 0; color: #9ca3af; font-size: 12px;">
            © ${currentYear} RentULO. All rights reserved.
          </p>
        </div>
      </div>
    </div>
  `;
}

module.exports = {
  // Liked
  likeHouse, getLikedHouses, unlikeHouse, deleteAllLikedHouses,
  // Locked
  initializeLockPayment, verifyLockPayment, verifyLockPaymentCallback, getLockedHouses, deleteLockedHouse, deleteAllLockedHouses,
  // Booked
  bookHouse, getBookedHouses, deleteBookedHouse, deleteAllBookedHouses,
  // Rent Payment
  initializeRentPayment, verifyRentPayment, verifyRentPaymentCallback
};
