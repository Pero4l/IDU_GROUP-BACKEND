const NodeGeocoder = require('node-geocoder');
const { Users } = require('../models');

const options = {
  provider: 'openstreetmap',
};

const geocoder = NodeGeocoder(options);

// Express 5's req.query is a getter that re-parses the URL on every read, so
// `req.query.location = x` is silently lost unless req.query has been
// replaced with a plain object (index.js does that). Do it here too, so this
// middleware works on its own.
function setQueryParam(req, key, value) {
  const desc = Object.getOwnPropertyDescriptor(req, 'query');
  if (!desc || !('value' in desc)) {
    Object.defineProperty(req, 'query', { value: { ...req.query }, writable: true, configurable: true, enumerable: true });
  }
  req.query[key] = value;
}

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
          setQueryParam(req, 'location', locationStr);
          return next();
        }
      }
    }

    // 2. No location given: fall back to the user's CURRENT state from the DB.
    //    (The token's "<state>, <country>" is frozen at login — it's
    //    "null, Nigeria" if they filled in their profile afterwards — and the
    //    full string never matches listings stored like "Lekki, Lagos".)
    if (!req.query.location && req.user?.userId) {
      const user = await Users.findByPk(req.user.userId, { attributes: ['state'] });
      const state = user?.state ? String(user.state).trim() : '';
      if (state) setQueryParam(req, 'location', state);
    }
    
    next();
  } catch (error) {
    console.error("Geocoding error:", error);
    // Don't crash the request if geocoding fails, just proceed.
    next();
  }
}

module.exports = { getLocationMiddleware };
