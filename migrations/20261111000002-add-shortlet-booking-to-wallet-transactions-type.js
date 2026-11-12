'use strict';
/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    // Shortlet bookings are charged from the wallet and need their own
    // ledger type so they show up correctly in history/admin stats.
    try {
      await queryInterface.sequelize.query(
        `ALTER TYPE "enum_wallet_transactions_type" ADD VALUE IF NOT EXISTS 'shortlet booking';`
      );
    } catch (error) {
      console.log('Enum value might already exist:', error.message);
    }
  },
  async down() {
    // PostgreSQL does not support removing values from an ENUM type easily.
  },
};
