require('dotenv').config();

// Single source of truth for which browser origins may call the API with
// credentials. Used by CORS (index.js) and by the cookie CSRF check in
// middleware/authUserMiddleware.js, so the two can never disagree.
const allowedOrigins = (process.env.ALLOWED_ORIGINS || "https://rentulo.ng,https://www.rentulo.ng,http://localhost:3000,https://idu-group-backend.onrender.com")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

module.exports = { allowedOrigins };
