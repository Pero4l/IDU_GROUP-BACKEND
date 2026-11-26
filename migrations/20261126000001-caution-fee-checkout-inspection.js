'use strict';
/** @type {import('sequelize-cli').Migration} */
module.exports = {
  // Refundable caution fee = the existing security deposit (same columns, same
  // held money). This adds the host's post-checkout inspection answer and
  // video evidence for damage reports. The damage amount is now decided by an
  // admin, so deposit_claim_amount (already nullable) may be left empty.
  async up(queryInterface, Sequelize) {
    const table = 'shortlet_bookings';
    await queryInterface.addColumn(table, 'deposit_inspection_outcome', {
      type: Sequelize.ENUM('no_damage', 'damage'), allowNull: true,
    });
    await queryInterface.addColumn(table, 'deposit_inspected_at', { type: Sequelize.DATE, allowNull: true });
    await queryInterface.addColumn(table, 'deposit_claim_videos', {
      type: Sequelize.JSON, allowNull: false, defaultValue: [],
    });
    // Older claims were filed through the same flow, so they count as "damage".
    await queryInterface.sequelize.query(`
      UPDATE "shortlet_bookings"
         SET deposit_inspection_outcome = 'damage', deposit_inspected_at = deposit_claimed_at
       WHERE deposit_claimed_at IS NOT NULL AND deposit_inspection_outcome IS NULL;
    `);
  },

  async down(queryInterface) {
    const table = 'shortlet_bookings';
    for (const col of ['deposit_inspection_outcome', 'deposit_inspected_at', 'deposit_claim_videos']) {
      await queryInterface.removeColumn(table, col);
    }
    await queryInterface.sequelize.query('DROP TYPE IF EXISTS "enum_shortlet_bookings_deposit_inspection_outcome";');
  },
};
