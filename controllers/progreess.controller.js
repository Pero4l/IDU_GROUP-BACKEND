const { Progress, Users, Rentals, Transactions } = require('../models');
const { notifySuperAdmins, logAndEmailUser } = require('./notification.controller');
const { Op } = require('sequelize');
require('dotenv').config();
const axios = require('axios');

async function likeHouse(req, res) {
    try {
        const { rental_id } = req.body;
        const user_id = req.user.userId;

        if (!rental_id) {
            return res.status(400).json({ success: false, message: "rental_id is required" });
        }

        // Find if a progress record exists for this user and rental
        let progressRecord = await Progress.findOne({ where: { user_id, rental_id } });

        if (progressRecord) {
            progressRecord.liked = true;
            await progressRecord.save();
        } else {
            progressRecord = await Progress.create({
                user_id,
                rental_id,
                liked: true,
                locked: false,
                booked: false,
            });
        }

        const userObj = await Users.findByPk(user_id);
        await logAndEmailUser(user_id, userObj?.email, "Property Liked", "You have successfully liked a property on RentULO.");
        await notifySuperAdmins(`A property has been liked by user ${user_id}.`, 'system');

        return res.status(200).json({
            success: true,
            message: "House liked successfully",
            data: progressRecord
        });
    } catch (error) {
        console.error("Error liking house:", error);
        return res.status(500).json({ success: false, message: "Server error" });
    }
}

// 2. Get Liked houses from database ====> GET
async function getLikedHouses(req, res) {
  try {
    const user_id = req.user.userId;

    const likedHouses = await Progress.findAll({
      where: { user_id, liked: true },
      include: [{ model: Rentals }]
    });

    return res.status(200).json({
      success: true,
      message: "Liked houses retrieved successfully",
      data: likedHouses
    });
  } catch (error) {
    console.error("Error getting liked houses:", error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
}

// 3. Unlike a particular house in the database ====> DELETE
async function unlikeHouse(req, res) {
  try {
    const { id } = req.params; // This is the rental_id
    const user_id = req.user.userId;

    const progressRecord = await Progress.findOne({ where: { rental_id: id, user_id } });

    if (!progressRecord) {
      return res.status(404).json({ success: false, message: "Liked house not found" });
    }

    progressRecord.liked = false;
    await progressRecord.save();

    return res.status(200).json({
      success: true,
      message: "House removed from liked list"
    });
  } catch (error) {
    console.error("Error unliking house:", error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
}

// 4. Delete all liked houses ====> DELETE
async function deleteAllLikedHouses(req, res) {
  try {
    const user_id = req.user.userId;

    await Progress.update(
      { liked: false },
      { where: { user_id, liked: true } }
    );

    return res.status(200).json({
      success: true,
      message: "All liked houses cleared successfully"
    });
  } catch (error) {
    console.error("Error deleting all liked houses:", error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
}


// ==========================
// LOCKED HOUSE CONTROLLERS
// ==========================

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
      { locked: false },
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

    if (!progressRecord) {
      progressRecord = await Progress.create({
        user_id,
        rental_id,
        liked: false,
        locked: false,
        booked: false,
      });
    }

    // Amount to lock house in kobo (e.g., 10000 NGN = 1000000 kobo)
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

// 1.5. Verify lock payment and successfully lock the house ===> POST
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
      }

      const userObj = await Users.findByPk(user_id);
      await logAndEmailUser(user_id, userObj?.email, "Property Locked", "You have successfully paid the lock fee and locked a property. It is now reserved for you.");
      await notifySuperAdmins(`A property has been successfully locked by user ${user_id} after successful payment.`, 'system');

      return res.status(200).json({
        success: true,
        message: "Payment verified and house locked successfully",
        data: progressRecord,
        redirectUrl: process.env.PAYSTACK_REDIRECT_URL || "https://idu-group-backend.onrender.com/progress/lock"
        // If you prefer direct server-side HTTP redirection, uncomment the line below and comment out the res.status(...).json(...) above:
        // return res.redirect(process.env.PAYSTACK_REDIRECT_URL || "https://idu-group-backend.onrender.com/progress/lock");
      });
    } else {
      transaction.status = 'failed';
      await transaction.save();
      return res.status(400).json({
        success: false,
        message: `Payment verification failed. Status: ${paymentStatus}`,
        redirectUrl: process.env.PAYSTACK_FAILURE_URL || "https://idu-group-backend.onrender.com/progress/lock"
        // If you prefer direct server-side HTTP redirection, uncomment the line below and comment out the res.status(...).json(...) above:
        // return res.redirect(process.env.PAYSTACK_FAILURE_URL || "https://idu-group-backend.onrender.com/progress/lock");
      });
    }

  } catch (error) {
    console.error("Error verifying payment:", error.response ? error.response.data : error.message);
    return res.status(500).json({ success: false, message: "Server error during payment verification" });
  }
}

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
      }

      const userObj = await Users.findByPk(transaction.user_id);
      await logAndEmailUser(transaction.user_id, userObj?.email, "Property Locked", "You have successfully paid the lock fee and locked a property. It is now reserved for you.");
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

// 2. Get locked houses from database ====> GET
async function getLockedHouses(req, res) {
  try {
    const user_id = req.user.userId;

    // Auto-release expired locks (older than 24 hours)
    const expiryTime = new Date(Date.now() - 24 * 60 * 60 * 1000);
    await Progress.update(
      { locked: false },
      {
        where: {
          locked: true,
          locked_at: { [Op.lt]: expiryTime }
        }
      }
    );

    const lockedHouses = await Progress.findAll({
      where: { user_id, locked: true },
      include: [{ model: Rentals }] // Include rental details automatically
    });

    return res.status(200).json({
      success: true,
      message: "Locked houses retrieved successfully",
      data: lockedHouses
    });
  } catch (error) {
    console.error("Error getting locked houses:", error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
}

// 3. Delete a particular house in the locked house database ====> DELETE
async function deleteLockedHouse(req, res) {
  try {
    const { id } = req.params; // This is the rental_id
    const user_id = req.user.userId;

    const progressRecord = await Progress.findOne({ where: { rental_id: id, user_id } });

    if (!progressRecord) {
      return res.status(404).json({ success: false, message: "Locked house not found" });
    }

    // Update flag to false instead of deleting the whole row to keep other progress states intact
    progressRecord.locked = false;
    progressRecord.locked_at = null;
    await progressRecord.save();

    return res.status(200).json({
      success: true,
      message: "House removed from locked list"
    });
  } catch (error) {
    console.error("Error deleting locked house:", error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
}

// 4. Delete all house that are in locked house database ====> DELETE 
async function deleteAllLockedHouses(req, res) {
  try {
    const user_id = req.user.userId;

    await Progress.update(
      { locked: false },
      { where: { user_id, locked: true } }
    );

    return res.status(200).json({
      success: true,
      message: "All locked houses cleared successfully"
    });
  } catch (error) {
    console.error("Error deleting all locked houses:", error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
}


// ==========================
// BOOKED HOUSE CONTROLLERS
// ==========================

// 1. Add house to Booked house database ===> POST
async function bookHouse(req, res) {
  try {
    const { rental_id } = req.body;
    const user_id = req.user.userId;

    if (!rental_id) {
      return res.status(400).json({ success: false, message: "rental_id is required" });
    }

    let progressRecord = await Progress.findOne({ where: { user_id, rental_id } });

    if (!progressRecord || !progressRecord.liked) {
      return res.status(400).json({ success: false, message: "You must like the house first before booking it" });
    }

    progressRecord.booked = true;
    await progressRecord.save();

    const userObj = await Users.findByPk(user_id);
    await logAndEmailUser(user_id, userObj?.email, "Property Booked", "You have successfully booked a property on RentULO.");
    await notifySuperAdmins(`A property has been successfully booked by user ${user_id}.`, 'system');

    return res.status(200).json({
      success: true,
      message: "House booked successfully",
      data: progressRecord
    });
  } catch (error) {
    console.error("Error booking house:", error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
}

// 2. Get Booked houses from database ====> GET
async function getBookedHouses(req, res) {
  try {
    const user_id = req.user.userId;

    const bookedHouses = await Progress.findAll({
      where: { user_id, booked: true },
      include: [{ model: Rentals }]
    });

    return res.status(200).json({
      success: true,
      message: "Booked houses retrieved successfully",
      data: bookedHouses
    });
  } catch (error) {
    console.error("Error getting booked houses:", error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
}

// 3. Delete a particular house in the Booked house database ====> DELETE 
async function deleteBookedHouse(req, res) {
  try {
    const { id } = req.params; // This is the rental_id
    const user_id = req.user.userId;

    const progressRecord = await Progress.findOne({ where: { rental_id: id, user_id } });

    if (!progressRecord) {
      return res.status(404).json({ success: false, message: "Booked house not found" });
    }

    progressRecord.booked = false;
    await progressRecord.save();

    return res.status(200).json({
      success: true,
      message: "House removed from booked list"
    });
  } catch (error) {
    console.error("Error deleting booked house:", error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
}

// 4. Delete all house that are in Booked house database ====> DELETE
async function deleteAllBookedHouses(req, res) {
  try {
    const user_id = req.user.userId;

    await Progress.update(
      { booked: false },
      { where: { user_id, booked: true } }
    );

    return res.status(200).json({
      success: true,
      message: "All booked houses cleared successfully"
    });
  } catch (error) {
    console.error("Error deleting all booked houses:", error);
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
      await logAndEmailUser(user_id, userObj?.email, "Rent Paid Successfully", `You have successfully paid the rent of NGN ${transaction.amount} for the property: ${rental?.title || 'Rental'}.`);

      if (rental && rental.UserId) {
        const landlord = await Users.findByPk(rental.UserId);
        if (landlord) {
          await logAndEmailUser(rental.UserId, landlord.email, "Property Rented", `Your property "${rental.title}" has been rented by ${userObj.full_name}. Payment of NGN ${transaction.amount} was received.`);
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
      await logAndEmailUser(transaction.user_id, userObj?.email, "Rent Paid Successfully", `You have successfully paid the rent of NGN ${transaction.amount} for the property: ${rental?.title || 'Rental'}.`);

      if (rental && rental.UserId) {
        const landlord = await Users.findByPk(rental.UserId);
        if (landlord) {
          await logAndEmailUser(rental.UserId, landlord.email, "Property Rented", `Your property "${rental.title}" has been rented by ${userObj.full_name}. Payment of NGN ${transaction.amount} was received.`);
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

module.exports = {
  // Liked
  likeHouse,
  getLikedHouses,
  unlikeHouse,
  deleteAllLikedHouses,

  // Locked
  initializeLockPayment,
  verifyLockPayment,
  verifyLockPaymentCallback,
  getLockedHouses,
  deleteLockedHouse,
  deleteAllLockedHouses,

  // Booked
  bookHouse,
  getBookedHouses,
  deleteBookedHouse,
  deleteAllBookedHouses,

  // Rent Payment
  initializeRentPayment,
  verifyRentPayment,
  verifyRentPaymentCallback
};
