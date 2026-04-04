'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up (queryInterface, Sequelize) {
    try {
      await queryInterface.addColumn('profiles', 'location', {
        type: Sequelize.STRING
      });
    } catch (error) {
      if (!error.message.includes('already exists')) {
        throw error;
      }
    }
  },

  async down (queryInterface, Sequelize) {
    await queryInterface.removeColumn('profiles', 'location');
  }
};
