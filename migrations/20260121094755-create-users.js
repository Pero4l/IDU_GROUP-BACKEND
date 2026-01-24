'use strict';

const { DataTypes } = require('sequelize');

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('users', {
      id: {
        allowNull: false,
        primaryKey: true,
        type: Sequelize.UUID,
        defaultValue: Sequelize.UUIDV4
      },
      first_name: {
        type: Sequelize.STRING,
       allowNull: false
      },
      last_name: {
        type: Sequelize.STRING,
       allowNull: false
      },
      gender: {
        type: Sequelize.STRING,
        defaultValue: "Unknown",
        allowNull: false
      },
      email: {
        type: Sequelize.STRING,
       allowNull: false
      },
      phone_no: {
        type: Sequelize.STRING,
       allowNull: false
      },
      address: {
        type: Sequelize.STRING,
       allowNull: false
      },
      state: {
        type: Sequelize.STRING,
       allowNull: false
      },
      country: {
       type: DataTypes.STRING,
       allowNull: false
      },
       password: {
        type: Sequelize.STRING,
        allowNull: false
      },
       otpCode: {
        type: Sequelize.INTEGER,
        allowNull: true
      },
      otpExpiresAt: {
        type: DataTypes.DATE,
        allowNull: true
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
    await queryInterface.dropTable('users');
  }
};