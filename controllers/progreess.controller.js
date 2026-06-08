const { Progress, Users, Rentals } = require('../models');
const { notifySuperAdmins, logAndEmailUser } = require('./notification.controller');
const { withTransaction } = require('../utils/rollback');
const logger = require('../utils/logger');

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
    await logAndEmailUser(user_id, userObj?.email, "Property Liked", "You have successfully liked a property on RentULO.");
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
async function lockHouse(req, res) {
  try {
    const { rental_id } = req.body;
    const user_id = req.user.userId;

    if (!rental_id) {
      return res.status(400).json({ success: false, message: "rental_id is required" });
    }

    const progressRecord = await withTransaction(async (t) => {
      const record = await Progress.findOne({ where: { user_id, rental_id }, transaction: t });

      if (!record || !record.liked) {
        // Throw so the transaction rolls back and returns the error below
        const err = new Error("MUST_LIKE_FIRST");
        err.statusCode = 400;
        throw err;
      }

      record.locked = true;
      await record.save({ transaction: t });
      return record;
    }, { context: 'lockHouse', user_id, rental_id });

    logger.info('House locked', { user_id, rental_id });

    const userObj = await Users.findByPk(user_id);
    await logAndEmailUser(user_id, userObj?.email, "Property Locked", "You have successfully locked a property. It is now reserved for you.");
    await notifySuperAdmins(`A property has been successfully locked by user ${user_id}.`, 'system');

    return res.status(200).json({ success: true, message: "House locked successfully", data: progressRecord });
  } catch (error) {
    if (error.message === "MUST_LIKE_FIRST") {
      return res.status(400).json({ success: false, message: "You must like the house first before locking it" });
    }
    logger.error('Error locking house', { error: error.message, userId: req.user?.userId });
    return res.status(500).json({ success: false, message: "Server error" });
  }
}

// GET — get locked houses
async function getLockedHouses(req, res) {
  try {
    const user_id = req.user.userId;
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
    await logAndEmailUser(user_id, userObj?.email, "Property Booked", "You have successfully booked a property on RentULO.");
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

module.exports = {
  likeHouse, getLikedHouses, unlikeHouse, deleteAllLikedHouses,
  lockHouse, getLockedHouses, deleteLockedHouse, deleteAllLockedHouses,
  bookHouse, getBookedHouses, deleteBookedHouse, deleteAllBookedHouses
};
