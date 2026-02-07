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
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true
    },
    title: {
      type: DataTypes.STRING,
      allowNull: false
    },
    description: {
      type: DataTypes.TEXT,
      allowNull: false
    },
    UserId: {
      type: DataTypes.UUID,
      allowNull: false,
      references: {
        model: 'Users',
        key: 'id'
      }
    },
    likesCount: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0
    },
    propertyType: {
      type: DataTypes.ENUM('apartment', 'house', 'office', 'commercial', 'land'),
        defaultValue: 'apartment',
      allowNull: false
    },
    location: {
      type: DataTypes.STRING,
      allowNull: false
    },
    price: {
      type: DataTypes.DECIMAL(12, 2),
      allowNull: false
    },
    priceType: {
      type: DataTypes.ENUM('monthly', 'yearly', 'one-time'),
        defaultValue: 'monthly',
      allowNull: false
    },
    images: {
        type: DataTypes.TEXT,
        allowNull: true,
        defaultValue: null,
    },
    status: {
        type: DataTypes.ENUM('available', 'rented', 'pending'),
        allowNull: false,
        defaultValue: 'available'
    },
  }, {
    sequelize,
    modelName: 'Rentals',
    tableName: 'rentals',
    timestamps: true
  });
  
  return Rentals;
};