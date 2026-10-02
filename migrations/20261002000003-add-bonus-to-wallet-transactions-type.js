'use strict';
/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    // Adds 'bonus' to wallet_transactions.type so coupon credits are visible
    // in history/admin stats as their own ledger type.
    try {
      await queryInterface.sequelize.query(
        `ALTER TYPE "enum_wallet_transactions_type" ADD VALUE IF NOT EXISTS 'bonus';`
      );
    } catch (error) {
      console.log('Enum value might already exist:', error.message);
    }
  },
  async down() {
    // PostgreSQL does not support removing values from an ENUM type easily.
  },
};
