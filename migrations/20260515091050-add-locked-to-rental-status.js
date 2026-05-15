'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up (queryInterface, Sequelize) {
    try {
      await queryInterface.sequelize.query("ALTER TYPE \"enum_rentals_status\" ADD VALUE IF NOT EXISTS 'locked';");
    } catch (error) {
      console.log('Enum value might already exist or the type name might be different:', error.message);
    }
  },

  async down (queryInterface, Sequelize) {
    // PostgreSQL does not support removing values from an ENUM type easily.
    // So we'll leave this empty.
  }
};
