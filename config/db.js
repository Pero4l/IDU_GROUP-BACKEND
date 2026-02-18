require("dotenv").config();
const { Sequelize } = require("sequelize");

// 1. Explicitly force the password to be a string. 
// This makes the "must be a string" SASL error impossible.
const dbPassword = String(process.env.DB_PASSWORD || "");

// 2. Use the individual variables from your .env file
const connection = new Sequelize(
  process.env.DB_NAME,      // 'defaultdb'
  process.env.DB_USER,      // 'avnadmin'
  dbPassword,               // Your forced-string password
  {
    host: process.env.DB_HOST, 
    port: process.env.DB_PORT, 
    dialect: "postgres",
    dialectOptions: {
      ssl: {
        require: true,
        rejectUnauthorized: false
      }
    },
    logging: console.log, // Keep this on to see if it connects
  }
);


connection.authenticate()
  .then(() => {
    console.log("✅ Database connection established successfully.");
  })
  .catch((err) => {
    console.error("❌ Unable to connect to the database:", err.message);
  });

module.exports = connection;