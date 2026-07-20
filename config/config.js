// require('dotenv').config();

// module.exports = {
//   development: {
//     username: process.env.DATABASE_USER,
//     password: process.env.DATABASE_PASSWORD,
//     database: process.env.DATABASE_NAME,
//     host: process.env.DATABASE_HOST,
//     port: process.env.DATABASE_PORT,
//     dialect: "postgres",
//     dialectOptions: {
//       ssl: {
//         require: true,
//         rejectUnauthorized: false
//       }
//     }
//   },
//   production: {
//     username: process.env.DATABASE_USER,
//     password: process.env.DATABASE_PASSWORD,
//     database: process.env.DATABASE_NAME,
//     host: process.env.DATABASE_HOST,
//     port: process.env.DATABASE_PORT,
//     dialect: "postgres",
//     dialectOptions: {
//       ssl: {
//         require: true,
//         rejectUnauthorized: false
//       }
//     }
//   }
// }


require('dotenv').config();
const fs = require('fs');
const net = require('net');
const dns = require('dns');

// Node races IPv4/IPv6 connection attempts (Happy Eyeballs) with a short
// default per-candidate timeout. Against this host that timeout is too
// short — one family hangs rather than failing cleanly — which was causing
// intermittent ETIMEDOUT on otherwise-healthy connections. Widening the
// attempt timeout and preferring IPv4 fixes it. This file is loaded
// directly by sequelize-cli too, not just index.js, so the fix has to live
// here rather than only at the app's entry point.
dns.setDefaultResultOrder('ipv4first');
if (net.setDefaultAutoSelectFamilyAttemptTimeout) {
  net.setDefaultAutoSelectFamilyAttemptTimeout(10000);
}

// Aiven (and most managed Postgres providers) sign their certs with their
// own CA, so verification needs that CA loaded explicitly. Point
// DB_SSL_CA_PATH at the downloaded ca.pem to enable full verification;
// without it we fall back to rejectUnauthorized: false so local/dev setups
// that haven't downloaded the cert yet don't lose DB connectivity.
const caPath = process.env.DB_SSL_CA_PATH;
const ssl = caPath && fs.existsSync(caPath)
  ? { require: true, rejectUnauthorized: true, ca: fs.readFileSync(caPath).toString() }
  : { require: true, rejectUnauthorized: false };

if (!caPath || !fs.existsSync(caPath)) {
  console.warn(
    '[db] DB_SSL_CA_PATH not set or file missing — connecting with rejectUnauthorized: false. ' +
    'Download the CA cert from your Aiven console and set DB_SSL_CA_PATH to enable full TLS verification.'
  );
}

module.exports = {
  development: {
    use_env_variable: 'DATABASE_URL',
    dialect: 'postgres',
    // The TLS handshake to this host has been observed taking up to ~14s;
    // the default connect timeout is shorter than that and was causing
    // intermittent ETIMEDOUT failures on otherwise-healthy connections.
    dialectOptions: { ssl, connectionTimeoutMillis: 30000 },
    pool: {
      max: 5,
      min: 0,
      acquire: 60000,
      idle: 10000
    }
  },
  test: {
    use_env_variable: 'DATABASE_URL',
    dialect: 'postgres',
  },
  production: {
    use_env_variable: 'DATABASE_URL',
    dialect: 'postgres',
    // The TLS handshake to this host has been observed taking up to ~14s;
    // the default connect timeout is shorter than that and was causing
    // intermittent ETIMEDOUT failures on otherwise-healthy connections.
    dialectOptions: { ssl, connectionTimeoutMillis: 30000 },
    pool: {
      max: 10,
      min: 0,
      acquire: 60000,
      idle: 10000
    }
  },
};

