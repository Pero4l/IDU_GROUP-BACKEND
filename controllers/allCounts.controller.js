const {Users, Rentals} = require('../models');

async function getAllCounts(req, res) {
  
  
  try {
    const [userCount, rentalCount, totalLandlords, totalTenants] = await Promise.all([
      Users.count(),
      Rentals.count(),
      Users.count({ where: { role: 'landlord' } }),
      Users.count({ where: { role: 'tenant' } })
    ]);
    

    
    return res.status(200).json({
      success: true,
      data: {
        totalUsers: userCount,
        totalListings: rentalCount,
        totalLandlords: totalLandlords,
        totalTenants: totalTenants
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