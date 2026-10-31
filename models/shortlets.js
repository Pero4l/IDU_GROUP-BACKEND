'use strict';
const { Model } = require('sequelize');
module.exports = (sequelize, DataTypes) => {
  class Shortlets extends Model {
    /**
     * Helper method for defining associations.
     * This method is not a part of Sequelize lifecycle.
     * The `models/index` file will call this method automatically.
     */
    static associate(models) {
      // Shortlet belongs to ONE User (landlord/agent)
      Shortlets.belongsTo(models.Users, {
        foreignKey: "UserId",
      });
    }
  }

  Shortlets.init({
    rentalModel: {
      type: DataTypes.ENUM('entire_place', 'private_room', 'shared_room', 'hotel'),
      allowNull: false,
      defaultValue: 'entire_place',
    },
    propertyType: {
      type: DataTypes.ENUM('apartment', 'house', 'villa', 'studio', 'condo', 'townhouse', 'bungalow', 'loft'),
      allowNull: false,
      defaultValue: 'house',
    },
    title: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    description: {
      type: DataTypes.TEXT,
      allowNull: false,
    },
    bedrooms: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },
    bathrooms: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },
    livingRooms: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },
    guestCapacity: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 1,
    },
    furnishingStatus: {
      type: DataTypes.ENUM('unfurnished', 'semi_furnished', 'fully_furnished'),
      allowNull: false,
      defaultValue: 'unfurnished',
    },
    address: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    city: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    area: {
      type: DataTypes.STRING,
      allowNull: false,
      defaultValue: '',
    },
    landmark: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    amenities: {
      type: DataTypes.JSON,
      allowNull: false,
      defaultValue: [],
    },
    images: {
      type: DataTypes.JSON,
      allowNull: false,
      defaultValue: [],
    },
    videos: {
      type: DataTypes.JSON,
      allowNull: true,
      defaultValue: [],
    },
    coverImage: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    pricePerNight: {
      type: DataTypes.DECIMAL(12, 2),
      allowNull: false,
    },
    cleaningFee: {
      type: DataTypes.DECIMAL(12, 2),
      allowNull: false,
      defaultValue: 0,
    },
    securityDeposit: {
      type: DataTypes.DECIMAL(12, 2),
      allowNull: false,
      defaultValue: 0,
    },
    minimumStay: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 1,
    },
    maximumStay: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 30,
    },
    availableFrom: {
      type: DataTypes.DATEONLY,
      allowNull: false,
    },
    availableTo: {
      type: DataTypes.DATEONLY,
      allowNull: false,
    },
    checkInTime: {
      type: DataTypes.TIME,
      allowNull: false,
      defaultValue: '14:00:00',
    },
    checkOutTime: {
      type: DataTypes.TIME,
      allowNull: false,
      defaultValue: '11:00:00',
    },
    smokingAllowed: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
    petsAllowed: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
    partiesAllowed: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
    houseRules: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    status: {
      type: DataTypes.ENUM('available', 'rented', 'pending', 'locked'),
      allowNull: false,
      defaultValue: 'available',
    },
    slug: {
      type: DataTypes.STRING,
      unique: true,
    },
    UserId: {
      type: DataTypes.UUID,
      allowNull: false,
      references: {
        model: 'users',
        key: 'id',
      },
      onUpdate: 'CASCADE',
      onDelete: 'RESTRICT',
    },
  }, {
    sequelize,
    modelName: 'Shortlets',
    tableName: 'shortlets',
    timestamps: true,
    hooks: {
      beforeCreate: async (shortlet) => {
        const slugify = require('../utils/slugify');
        if (shortlet.title) {
          let slug = slugify(shortlet.title);
          // Check for collision
          const existing = await shortlet.constructor.findOne({ where: { slug } });
          if (existing) {
            slug = slugify(shortlet.title, shortlet.id ? shortlet.id.split('-')[0] : Math.random().toString(36).substring(2, 6));
          }
          shortlet.slug = slug;
        }
      },
      beforeUpdate: async (shortlet) => {
        const slugify = require('../utils/slugify');
        if (shortlet.changed('title')) {
          let slug = slugify(shortlet.title);
          const existing = await shortlet.constructor.findOne({ where: { slug, id: { [require('sequelize').Op.ne]: shortlet.id } } });
          if (existing) {
            slug = slugify(shortlet.title, shortlet.id.split('-')[0]);
          }
          shortlet.slug = slug;
        }
      },
    },
  });

  return Shortlets;
};
