'use strict';
/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const q = queryInterface.sequelize;
    const POLICIES = ['flexible', 'moderate', 'firm', 'strict'];

    // ── 9. Per-listing cancellation policy (snapshotted on each booking) ──
    await queryInterface.addColumn('shortlets', 'cancellationPolicy', {
      type: Sequelize.ENUM(...POLICIES), allowNull: false, defaultValue: 'flexible',
    });
    await queryInterface.addColumn('shortlet_bookings', 'cancellation_policy', {
      type: Sequelize.ENUM(...POLICIES), allowNull: false, defaultValue: 'flexible',
    });

    // ── 7. Stays ended early: the day the guest actually leaves ──
    // Nights before this stay blocked; nights after it become bookable again.
    await queryInterface.addColumn('shortlet_bookings', 'actual_check_out', { type: Sequelize.DATEONLY, allowNull: true });

    // ── 8. Security deposit hold + host claims ──
    await q.query(`ALTER TYPE "enum_shortlet_bookings_deposit_status" ADD VALUE IF NOT EXISTS 'claimed';`);
    await q.query(`ALTER TYPE "enum_shortlet_bookings_deposit_status" ADD VALUE IF NOT EXISTS 'settled';`);
    await queryInterface.addColumn('shortlet_bookings', 'deposit_refund_due_at', { type: Sequelize.DATE, allowNull: true });
    await queryInterface.addColumn('shortlet_bookings', 'deposit_claim_amount', { type: Sequelize.DECIMAL(12, 2), allowNull: true });
    await queryInterface.addColumn('shortlet_bookings', 'deposit_claim_reason', { type: Sequelize.TEXT, allowNull: true });
    await queryInterface.addColumn('shortlet_bookings', 'deposit_claimed_at', { type: Sequelize.DATE, allowNull: true });
    await queryInterface.addColumn('shortlet_bookings', 'deposit_claim_decision', {
      type: Sequelize.ENUM('approved', 'partially_approved', 'rejected'), allowNull: true,
    });
    await queryInterface.addColumn('shortlet_bookings', 'deposit_claim_note', { type: Sequelize.TEXT, allowNull: true });
    await queryInterface.addColumn('shortlet_bookings', 'deposit_claim_resolved_at', { type: Sequelize.DATE, allowNull: true });
    await queryInterface.addColumn('shortlet_bookings', 'deposit_paid_to_host', {
      type: Sequelize.DECIMAL(12, 2), allowNull: false, defaultValue: 0,
    });

    // Existing held deposits: refundable 48h after check-out (Lagos time).
    await q.query(`
      UPDATE "shortlet_bookings"
         SET deposit_refund_due_at = ((check_out + check_out_time) AT TIME ZONE 'Africa/Lagos') + INTERVAL '48 hours'
       WHERE deposit_status = 'held' AND deposit_refund_due_at IS NULL;
    `);
    await queryInterface.addIndex('shortlet_bookings', ['deposit_status', 'deposit_refund_due_at']);
  },

  async down(queryInterface) {
    for (const col of [
      'cancellation_policy', 'actual_check_out', 'deposit_refund_due_at', 'deposit_claim_amount',
      'deposit_claim_reason', 'deposit_claimed_at', 'deposit_claim_decision', 'deposit_claim_note',
      'deposit_claim_resolved_at', 'deposit_paid_to_host',
    ]) {
      await queryInterface.removeColumn('shortlet_bookings', col);
    }
    await queryInterface.removeColumn('shortlets', 'cancellationPolicy');
    for (const type of ['enum_shortlets_cancellationPolicy', 'enum_shortlet_bookings_cancellation_policy', 'enum_shortlet_bookings_deposit_claim_decision']) {
      await queryInterface.sequelize.query(`DROP TYPE IF EXISTS "${type}";`);
    }
    // 'claimed' / 'settled' stay in the deposit_status enum (Postgres can't drop enum values).
  },
};
