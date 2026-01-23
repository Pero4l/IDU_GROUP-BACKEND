'use strict';
const {
  Model
} = require('sequelize');
module.exports = (sequelize, DataTypes) => {
  class Users extends Model {
    /**
     * Helper method for defining associations.
     * This method is not a part of Sequelize lifecycle.
     * The `models/index` file will call this method automatically.
     */
    static associate(models) {
      // define association here
    }
  }
  Users.init({
    firstName: DataTypes.STRING,
    lastName: DataTypes.STRING,
    gender: DataTypes.ENUM,
    email: DataTypes.STRING,
    phone_no: DataTypes.STRING,
    address: DataTypes.STRING,
    state: DataTypes.STRING,
    country: DataTypes.STRING,
    password: DataTypes.STRING,
    otp: DataTypes.INTEGER,
    otpExpiresAt: DataTypes.DATE
  }, {
    sequelize,
    modelName: 'Users',
    tableName: "users"
  });
  return Users;
};