const { Progress, Users, Rentals } = require('../models');

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

// 1. Add house to locked house database ===> POST
async function lockHouse(req, res) {
  try {
    const { rental_id } = req.body;
    const user_id = req.user.userId;

    if (!rental_id) {
      return res.status(400).json({ success: false, message: "rental_id is required" });
    }

    // Find if a progress record exists for this user and rental
    let progressRecord = await Progress.findOne({ where: { user_id, rental_id } });

    if (!progressRecord || !progressRecord.liked) {
      return res.status(400).json({ success: false, message: "You must like the house first before locking it" });
    }

    progressRecord.locked = true;
    await progressRecord.save();

    return res.status(200).json({
      success: true,
      message: "House locked successfully",
      data: progressRecord
    });
  } catch (error) {
    console.error("Error locking house:", error);
    return res.status(500).json({ success: false, message: "Server error" });
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
  lockHouse,
  getLockedHouses,
  deleteLockedHouse,
  deleteAllLockedHouses,

  // Booked
  bookHouse,
  getBookedHouses,
  deleteBookedHouse,
  deleteAllBookedHouses
};
