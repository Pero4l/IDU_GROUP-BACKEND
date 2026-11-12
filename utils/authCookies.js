// Auth cookie settings, shared by login, Google sign-in and logout.
//
// The frontend (rentulo.ng) and the API (onrender.com) are different sites.
// Browsers only send cookies cross-site when they are `SameSite=None; Secure`,
// so that's what production uses. Locally (http://localhost:3000 → localhost
// API) everything is same-site, so `Lax` works and doesn't need HTTPS.
//
// Cross-site cookies are what make CSRF possible, so authUserMiddleware only
// accepts a cookie on data-changing requests from an allow-listed Origin.

const isProduction = () => process.env.NODE_ENV === 'production';

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

function authCookieOptions({ withMaxAge = true } = {}) {
  const options = isProduction()
    ? { httpOnly: true, secure: true, sameSite: 'none', path: '/' }
    : { httpOnly: true, secure: false, sameSite: 'lax', path: '/' };
  if (withMaxAge) options.maxAge = SEVEN_DAYS_MS;
  return options;
}

module.exports = { authCookieOptions };
