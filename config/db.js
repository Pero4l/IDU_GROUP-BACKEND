require("dotenv").config();
const { Sequelize } = require("sequelize");

const connection = new Sequelize(process.env.DB_URL, {
  dialect: "postgres",
  dialectOptions: {
    ssl: {
      require: true,
      rejectUnauthorized: false
    }
  },
  logging: console.log,
});

module.exports = connection;