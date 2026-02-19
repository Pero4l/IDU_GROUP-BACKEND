'use strict';
const { Model } = require('sequelize');
module.exports = (sequelize, DataTypes) => {
  class Rentals extends Model {
    /**
     * Helper method for defining associations.
     * This method is not a part of Sequelize lifecycle.
     * The `models/index` file will call this method automatically.
     */
    static associate(models) {
      // Rental belongs to ONE User (agent/owner)
      Rentals.belongsTo(models.Users, {
        foreignKey: "UserId",
        as: 'agent'
      });
    }
  }
  
  Rentals.init({
    title: DataTypes.STRING,
    description: DataTypes.TEXT,
    UserId: DataTypes.UUID,
    likesCount: DataTypes.INTEGER,
    propertyType: DataTypes.ENUM('apartment', 'house', 'office', 'commercial', 'land'),
    location: DataTypes.STRING,
    price: DataTypes.DECIMAL(12, 2),
    priceType: DataTypes.ENUM('monthly', 'yearly', 'one-time'),
    images: DataTypes.JSON,
    videos: DataTypes.JSON,
    status: DataTypes.ENUM('available', 'rented', 'pending')
  }, {
    sequelize,
    modelName: 'Rentals',
    tableName: 'rentals',
    timestamps: true
  });
  
  return Rentals;
};