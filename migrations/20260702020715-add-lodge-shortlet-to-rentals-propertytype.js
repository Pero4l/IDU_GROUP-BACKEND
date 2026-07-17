'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(
      `ALTER TYPE "enum_rentals_propertyType" ADD VALUE IF NOT EXISTS 'lodge';`
    );
    await queryInterface.sequelize.query(
      `ALTER TYPE "enum_rentals_propertyType" ADD VALUE IF NOT EXISTS 'shortlet';`
    );
  },

  async down() {
    // Postgres doesn't support removing enum values directly. Rolling back
    // would require rebuilding the type (rename, create, migrate column,
    // drop old type) and would fail if any row already uses these values.
    // Left as a no-op; revert manually if this migration is undone.
  }
};
