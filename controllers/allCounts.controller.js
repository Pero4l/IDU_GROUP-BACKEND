const {Users, Rentals} = require('../models');

async function getAllCounts(req, res) {
  try {
    const userCount = await Users.count();
    const rentalCount = await Rentals.count();

    
    return res.status(200).json({
      success: true,
      data: {
        totalUsers: userCount,
        totalListings: rentalCount
      },
      message: "Counts retrieved successfully",
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({
      success: false,
      message: "Server error",
      error: error.message,
    });
  }
}


module.exports = {
  getAllCounts
};