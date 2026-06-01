'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class Waitlist extends Model {
    static associate(models) {
      // No associations needed for Waitlist
    }
  }
  Waitlist.init({
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
      allowNull: false
    },
    email: {
      type: DataTypes.STRING,
      allowNull: false,
      unique: true,
      validate: {
        isEmail: true
      }
    }
  }, {
    sequelize,
    modelName: 'Waitlist',
    tableName: 'waitlists'
  });
  return Waitlist;
};
