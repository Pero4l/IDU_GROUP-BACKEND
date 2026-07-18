'use strict';
/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('profiles', 'withdrawalBankName', {
      type: Sequelize.STRING,
      allowNull: true,
    });
    await queryInterface.addColumn('profiles', 'withdrawalAccountNumber', {
      type: Sequelize.STRING,
      allowNull: true,
    });
    await queryInterface.addColumn('profiles', 'withdrawalAccountName', {
      type: Sequelize.STRING,
      allowNull: true,
    });
  },
  async down(queryInterface) {
    await queryInterface.removeColumn('profiles', 'withdrawalBankName');
    await queryInterface.removeColumn('profiles', 'withdrawalAccountNumber');
    await queryInterface.removeColumn('profiles', 'withdrawalAccountName');
  }
};
