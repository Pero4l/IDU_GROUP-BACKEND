const { Progress, Users, Rentals, Transactions } = require('../models');
const { notifySuperAdmins, logAndEmailUser } = require('./notification.controller');
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

    // Generate Paystack initialization request
    const response = await axios.post(
      'https://api.paystack.co/transaction/initialize',
      {
        email: userEmail,
        amount: amountInKobo,
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

// 2. Get locked houses from database ====> GET
async function getLockedHouses(req, res) {
  try {
    const user_id = req.user.userId;

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

module.exports = {
  // Liked
  likeHouse,
  getLikedHouses,
  unlikeHouse,
  deleteAllLikedHouses,

  // Locked
  initializeLockPayment,
  verifyLockPayment,
  getLockedHouses,
  deleteLockedHouse,
  deleteAllLockedHouses,

  // Booked
  bookHouse,
  getBookedHouses,
  deleteBookedHouse,
  deleteAllBookedHouses
};
