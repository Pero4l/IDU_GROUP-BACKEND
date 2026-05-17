'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    // Modify 'user_id' and 'rental_id' to UUID in Transactions table
    // Using raw SQL is extremely robust in PostgreSQL when converting from INTEGER to UUID
    await queryInterface.sequelize.query('ALTER TABLE "Transactions" ALTER COLUMN "user_id" TYPE UUID USING "user_id"::text::uuid;');
    await queryInterface.sequelize.query('ALTER TABLE "Transactions" ALTER COLUMN "rental_id" TYPE UUID USING "rental_id"::text::uuid;');
  },

  async down(queryInterface, Sequelize) {
    // Revert back to INTEGER if rolled back
    await queryInterface.sequelize.query('ALTER TABLE "Transactions" ALTER COLUMN "user_id" TYPE INTEGER USING NULL;');
    await queryInterface.sequelize.query('ALTER TABLE "Transactions" ALTER COLUMN "rental_id" TYPE INTEGER USING NULL;');
  }
};
