'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('rentals', 'legalFee', {
      type: Sequelize.DECIMAL(12, 2),
      allowNull: true,
      defaultValue: 0.00
    });
    await queryInterface.addColumn('rentals', 'cautionFee', {
      type: Sequelize.DECIMAL(12, 2),
      allowNull: true,
      defaultValue: 0.00
    });
    await queryInterface.addColumn('rentals', 'brokeFee', {
      type: Sequelize.DECIMAL(12, 2),
      allowNull: true,
      defaultValue: 0.00
    });
    await queryInterface.addColumn('rentals', 'mgtServiceCharge', {
      type: Sequelize.DECIMAL(12, 2),
      allowNull: true,
      defaultValue: 0.00
    });
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.removeColumn('rentals', 'legalFee');
    await queryInterface.removeColumn('rentals', 'cautionFee');
    await queryInterface.removeColumn('rentals', 'brokeFee');
    await queryInterface.removeColumn('rentals', 'mgtServiceCharge');
  }
};
