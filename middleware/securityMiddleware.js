/**
 * Additional security headers and protections.
 * Applied after helmet() for extra layers.
 */
function securityMiddleware(req, res, next) {
  // Prevent MIME type sniffing
  res.setHeader("X-Content-Type-Options", "nosniff");

  // Prevent page from being embedded in an iframe (clickjacking)
  res.setHeader("X-Frame-Options", "DENY");

  // Control referrer information
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");

  // Permissions policy — disable unnecessary browser features
  res.setHeader(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=(self), payment=(self)"
  );

  // Strict Transport Security (HSTS) — force HTTPS for 1 year
  if (process.env.NODE_ENV === "production") {
    res.setHeader(
      "Strict-Transport-Security",
      "max-age=31536000; includeSubDomains; preload"
    );
  }

  // Remove X-Powered-By (belt-and-suspenders with helmet)
  res.removeHeader("X-Powered-By");

  next();
}

module.exports = { securityMiddleware };
