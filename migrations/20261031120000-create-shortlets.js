'use strict';

const { DataTypes } = require('sequelize');
/** @type {import('sequelize-cli').Migration} */

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('shortlets', {
      id: {
        allowNull: false,
        primaryKey: true,
        type: Sequelize.UUID,
        defaultValue: Sequelize.literal('gen_random_uuid()'),
      },
      rentalModel: {
        type: Sequelize.ENUM('entire_place', 'private_room', 'shared_room', 'hotel'),
        allowNull: false,
        defaultValue: 'entire_place',
      },
      propertyType: {
        type: Sequelize.ENUM('apartment', 'house', 'villa', 'studio', 'condo', 'townhouse', 'bungalow', 'loft'),
        allowNull: false,
        defaultValue: 'house',
      },
      title: {
        type: Sequelize.STRING,
        allowNull: false,
      },
      description: {
        type: Sequelize.TEXT,
        allowNull: false,
      },
      bedrooms: {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 0,
      },
      bathrooms: {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 0,
      },
      livingRooms: {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 0,
      },
      guestCapacity: {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 1,
      },
      furnishingStatus: {
        type: Sequelize.ENUM('unfurnished', 'semi_furnished', 'fully_furnished'),
        allowNull: false,
        defaultValue: 'unfurnished',
      },
      address: {
        type: Sequelize.STRING,
        allowNull: false,
      },
      city: {
        type: Sequelize.STRING,
        allowNull: false,
      },
      area: {
        type: Sequelize.STRING,
        allowNull: false,
        defaultValue: '',
      },
      landmark: {
        type: Sequelize.STRING,
        allowNull: true,
      },
      amenities: {
        type: Sequelize.JSON,
        allowNull: false,
        defaultValue: Sequelize.literal('[]'),
      },
      images: {
        type: Sequelize.JSON,
        allowNull: false,
        defaultValue: Sequelize.literal('[]'),
      },
      videos: {
        type: Sequelize.JSON,
        allowNull: true,
        defaultValue: Sequelize.literal('[]'),
      },
      coverImage: {
        type: Sequelize.STRING,
        allowNull: true,
      },
      pricePerNight: {
        type: Sequelize.DECIMAL(12, 2),
        allowNull: false,
      },
      cleaningFee: {
        type: Sequelize.DECIMAL(12, 2),
        allowNull: false,
        defaultValue: 0,
      },
      securityDeposit: {
        type: Sequelize.DECIMAL(12, 2),
        allowNull: false,
        defaultValue: 0,
      },
      minimumStay: {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 1,
      },
      maximumStay: {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 30,
      },
      availableFrom: {
        type: Sequelize.DATEONLY,
        allowNull: false,
      },
      availableTo: {
        type: Sequelize.DATEONLY,
        allowNull: false,
      },
      checkInTime: {
        type: Sequelize.TIME,
        allowNull: false,
        defaultValue: '14:00:00',
      },
      checkOutTime: {
        type: Sequelize.TIME,
        allowNull: false,
        defaultValue: '11:00:00',
      },
      smokingAllowed: {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: false,
      },
      petsAllowed: {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: false,
      },
      partiesAllowed: {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: false,
      },
      houseRules: {
        type: Sequelize.TEXT,
        allowNull: true,
      },
      status: {
        type: Sequelize.ENUM('available', 'rented', 'pending', 'locked'),
        allowNull: false,
        defaultValue: 'available',
      },
      slug: {
        type: Sequelize.STRING,
        allowNull: true,
        unique: true,
      },
      UserId: {
        allowNull: false,
        type: Sequelize.UUID,
        references: {
          model: 'users',
          key: 'id',
        },
        onUpdate: 'CASCADE',
        onDelete: 'RESTRICT',
      },
      createdAt: {
        allowNull: false,
        type: Sequelize.DATE,
      },
      updatedAt: {
        allowNull: false,
        type: Sequelize.DATE,
      },
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('shortlets');
  },
};
