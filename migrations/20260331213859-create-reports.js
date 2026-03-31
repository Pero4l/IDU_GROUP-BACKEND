'use strict';
/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('reports', {
      id: {
        allowNull: false,
        primaryKey: true,
        type: Sequelize.UUID,
        defaultValue: Sequelize.UUIDV4
      },
      user_id: {
        type: Sequelize.UUID
      },
      report_user_id: {
        type: Sequelize.UUID
      },
      report_name: {
        type: Sequelize.STRING
      },
      report_number: {
        type: Sequelize.STRING
      },
      report_type: {
        type: Sequelize.ENUM('spam', 'harassment', 'fraud', 'other')
      },
      report_message: {
        type: Sequelize.STRING
      },
      report_status: {
        type: Sequelize.STRING
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
    await queryInterface.dropTable('reports');
  }
};