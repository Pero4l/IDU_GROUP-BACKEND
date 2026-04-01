const NodeGeocoder = require('node-geocoder');

const options = {
  provider: 'openstreetmap',
};

const geocoder = NodeGeocoder(options);

async function getLocationMiddleware(req, res, next) {
  try {
    const { lat, lng } = req.query;

    // 1. If GPS coordinates were sent, decode them into a city/state string.
    if (lat && lng) {
      const gRes = await geocoder.reverse({ lat: parseFloat(lat), lon: parseFloat(lng) });
      if (gRes && gRes.length > 0) {
        // Fallback sequentially: city -> state -> country
        const locationStr = gRes[0].city || gRes[0].state || gRes[0].country;
        if (locationStr) {
          req.query.location = locationStr;
          return next();
        }
      }
    }

    // 2. Fallback to the user's stored profile location if no search parameters are given
    if (!req.query.location && req.user && req.user.location) {
      req.query.location = req.user.location;
    }
    
    next();
  } catch (error) {
    console.error("Geocoding error:", error);
    // Don't crash the request if geocoding fails, just proceed.
    next();
  }
}

module.exports = { getLocationMiddleware };
