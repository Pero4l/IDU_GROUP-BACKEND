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

const getDbConfig = (maxPool = 10) => {
  const baseConfig = {
    dialect: 'postgres',
    dialectOptions: { ssl, connectionTimeoutMillis: 30000 },
    pool: {
      max: maxPool,
      min: 0,
      acquire: 60000,
      idle: 10000
    }
  };

  if (process.env.DATABASE_URL) {
    baseConfig.use_env_variable = 'DATABASE_URL';
  } else {
    baseConfig.username = process.env.DATABASE_USER || process.env.DB_USER;
    baseConfig.password = process.env.DATABASE_PASSWORD || process.env.DB_PASSWORD;
    baseConfig.database = process.env.DATABASE_NAME || process.env.DB_NAME;
    baseConfig.host = process.env.DATABASE_HOST || process.env.DB_HOST;
    baseConfig.port = process.env.DATABASE_PORT || process.env.DB_PORT || 5432;
  }

  return baseConfig;
};

module.exports = {
  development: getDbConfig(5),
  test: getDbConfig(5),
  production: getDbConfig(10),
};

