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
      Users.hasMany(models.Rentals, {
        foreignKey: "UserId",
        // as: "stories"
      });

      Users.hasMany(models.Notifications, {
        foreignKey: "user_id",
        // as: "notifications"
      });

      Users.hasMany(models.Progress, {
        foreignKey: "user_id",
        // as: "progress"
      });

      Users.hasOne(models.Profile, { foreignKey: 'user_id' });

      Users.hasMany(models.Reports, {
        foreignKey: "user_id",
        // as: "reports"
      });

      Users.hasMany(models.Reports, {
        foreignKey: "report_user_id",
        // as: "reports"
      });
    }
  }
  Users.init({
    first_name: DataTypes.STRING,
    last_name: DataTypes.STRING,
    gender: DataTypes.ENUM('male', 'female', 'others'),
    email: DataTypes.STRING,
    role: {
      type: DataTypes.ENUM('tenant', 'landlord', 'admin'),
      defaultValue: 'tenant',
    },
    phone_no: DataTypes.STRING,
    address: DataTypes.STRING,
    state: DataTypes.STRING,
    country: DataTypes.STRING,
    password: DataTypes.STRING,
    otpCode: DataTypes.INTEGER,
    otpExpiresAt: DataTypes.DATE,
    is_superadmin: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
    },
    is_active: {
      type: DataTypes.BOOLEAN,
      defaultValue: true,
    }
  }, {
    sequelize,
    modelName: 'Users',
    tableName: "users"
  });
  return Users;
}; 
