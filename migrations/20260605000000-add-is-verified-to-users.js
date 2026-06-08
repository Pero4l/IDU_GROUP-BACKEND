'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    // Add is_verified column
    await queryInterface.addColumn('users', 'is_verified', {
      type: Sequelize.BOOLEAN,
      defaultValue: false,
      allowNull: false
    });

    // Make phone_no, address, and state nullable
    await queryInterface.changeColumn('users', 'phone_no', {
      type: Sequelize.STRING,
      allowNull: true
    });
    await queryInterface.changeColumn('users', 'address', {
      type: Sequelize.STRING,
      allowNull: true
    });
    await queryInterface.changeColumn('users', 'state', {
      type: Sequelize.STRING,
      allowNull: true
    });
  },

  async down(queryInterface, Sequelize) {
    // Revert nullable columns back to allowNull: false (Note: if any null values exist in the database, this might fail unless cleaned up, but that is standard behavior)
    await queryInterface.changeColumn('users', 'phone_no', {
      type: Sequelize.STRING,
      allowNull: false
    });
    await queryInterface.changeColumn('users', 'address', {
      type: Sequelize.STRING,
      allowNull: false
    });
    await queryInterface.changeColumn('users', 'state', {
      type: Sequelize.STRING,
      allowNull: false
    });

    // Remove is_verified column
    await queryInterface.removeColumn('users', 'is_verified');
  }
};
