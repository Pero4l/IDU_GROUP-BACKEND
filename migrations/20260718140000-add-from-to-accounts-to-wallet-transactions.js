'use strict';
/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('wallet_transactions', 'from_account_number', {
      type: Sequelize.STRING,
      allowNull: true,
    });
    await queryInterface.addColumn('wallet_transactions', 'from_account_name', {
      type: Sequelize.STRING,
      allowNull: true,
    });
    await queryInterface.addColumn('wallet_transactions', 'to_account_number', {
      type: Sequelize.STRING,
      allowNull: true,
    });
    await queryInterface.addColumn('wallet_transactions', 'to_account_name', {
      type: Sequelize.STRING,
      allowNull: true,
    });
  },
  async down(queryInterface) {
    await queryInterface.removeColumn('wallet_transactions', 'from_account_number');
    await queryInterface.removeColumn('wallet_transactions', 'from_account_name');
    await queryInterface.removeColumn('wallet_transactions', 'to_account_number');
    await queryInterface.removeColumn('wallet_transactions', 'to_account_name');
  },
};
