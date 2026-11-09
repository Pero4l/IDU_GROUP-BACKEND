const { Users, Rentals, Shortlets } = require('../models');

async function getAllCounts(req, res) {
  
  
  try {
    const [userCount, rentalCount, shortletCount, totalLandlords, totalTenants] = await Promise.all([
      Users.count(),
      Rentals.count(),
      Shortlets.count(),
      Users.count({ where: { role: 'landlord' } }),
      Users.count({ where: { role: 'tenant' } })
    ]);
    

    
    return res.status(200).json({
      success: true,
      data: {
        totalUsers: userCount,
        // Total listings = long-term rentals + shortlets
        totalListings: rentalCount + shortletCount,
        totalRentals: rentalCount,
        totalShortlets: shortletCount,
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