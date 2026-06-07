'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class PendingRegistrations extends Model {
    static associate(models) {
      // No associations needed for temporary pending signups
    }
  }
  PendingRegistrations.init({
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
      allowNull: false
    },
    full_name: {
      type: DataTypes.STRING,
      allowNull: false
    },
    gender: {
      type: DataTypes.STRING,
      allowNull: false
    },
    email: {
      type: DataTypes.STRING,
      allowNull: false
    },
    role: {
      type: DataTypes.STRING,
      allowNull: false
    },
    password: {
      type: DataTypes.STRING,
      allowNull: false
    },
    otpCode: {
      type: DataTypes.INTEGER,
      allowNull: false
    },
    otpExpiresAt: {
      type: DataTypes.DATE,
      allowNull: false
    }
  }, {
    sequelize,
    modelName: 'PendingRegistrations',
    tableName: 'pending_registrations'
  });
  return PendingRegistrations;
};

