'use strict';

const { DataTypes } = require("sequelize");
/** @type {import('sequelize-cli').Migration} */

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('rentals', {
      id: {
  allowNull: false,
  primaryKey: true,
  type: Sequelize.UUID,
  defaultValue: Sequelize.literal('gen_random_uuid()'), 
},
      title: {
        type: Sequelize.STRING,
        allowNull: false
      },
      description: {
        type: Sequelize.TEXT,
        allowNull: false
      },
      UserId: {
        type: Sequelize.UUID,
        allowNull: false,
        references: {
          model: 'users',
          key: 'id'
        },
        onUpdate: 'CASCADE',
        onDelete: 'RESTRICT'
      },
      likesCount: {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 0
      },
      propertyType: {
        type: Sequelize.ENUM('apartment', 'house', 'office', 'commercial', 'land'),
        defaultValue: 'apartment',
        allowNull: false
      },
      location: {
        type: Sequelize.STRING,
        allowNull: false
      },
      price: {
        type: Sequelize.DECIMAL(12, 2),
        allowNull: false
      },
      priceType: {
        type: Sequelize.ENUM('monthly', 'yearly', 'one-time'),
        defaultValue: 'monthly',
        allowNull: false
      },
      images: {
        type: Sequelize.JSON
      },
      videos: {
        type: Sequelize.JSON
      },
      status: {
        type: Sequelize.ENUM('available', 'rented', 'pending'),
        allowNull: false,
        defaultValue: 'available'
      },
      createdAt: {
        allowNull: false,
        type: Sequelize.DATE
      },
      updatedAt: {
        allowNull: false,
        type: Sequelize.DATE
      }
    });
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.dropTable('rentals');
  }
};
