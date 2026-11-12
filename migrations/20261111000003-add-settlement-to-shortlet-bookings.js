'use strict';
/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const table = 'shortlet_bookings';
    const money = { type: Sequelize.DECIMAL(12, 2), allowNull: false, defaultValue: 0 };

    // The host is recorded on the booking so they can still be paid (and
    // see the booking) if the listing itself is later deleted.
    await queryInterface.addColumn(table, 'host_id', {
      type: Sequelize.UUID,
      allowNull: true,
      references: { model: 'users', key: 'id' },
      onUpdate: 'CASCADE',
      onDelete: 'SET NULL',
    });
    await queryInterface.sequelize.query(
      `UPDATE "shortlet_bookings" b SET host_id = s."UserId" FROM "shortlets" s WHERE s.id = b.shortlet_id AND b.host_id IS NULL;`
    );

    // Snapshot of the listing's times and the admin commission at booking
    // time, so later edits by the host or admin don't change an existing stay.
    await queryInterface.addColumn(table, 'check_in_time', { type: Sequelize.TIME, allowNull: false, defaultValue: '14:00:00' });
    await queryInterface.addColumn(table, 'check_out_time', { type: Sequelize.TIME, allowNull: false, defaultValue: '11:00:00' });
    await queryInterface.addColumn(table, 'commission_percent', { type: Sequelize.DECIMAL(5, 2), allowNull: false, defaultValue: 100 });

    // Payment is held by the platform until payout_due_at (24h after check-in).
    await queryInterface.addColumn(table, 'payout_status', {
      type: Sequelize.ENUM('pending', 'paid', 'cancelled'),
      allowNull: false,
      defaultValue: 'pending',
    });
    await queryInterface.addColumn(table, 'payout_due_at', { type: Sequelize.DATE, allowNull: true });
    await queryInterface.addColumn(table, 'paid_out_at', { type: Sequelize.DATE, allowNull: true });
    await queryInterface.addColumn(table, 'host_payout', money);
    await queryInterface.addColumn(table, 'platform_fee', money);

    await queryInterface.addColumn(table, 'deposit_status', {
      type: Sequelize.ENUM('none', 'held', 'refunded'),
      allowNull: false,
      defaultValue: 'none',
    });

    await queryInterface.addColumn(table, 'refunded_amount', money);
    await queryInterface.addColumn(table, 'cancelled_at', { type: Sequelize.DATE, allowNull: true });
    await queryInterface.addColumn(table, 'cancelled_by', { type: Sequelize.ENUM('guest', 'host'), allowNull: true });
    await queryInterface.addColumn(table, 'cancellation_reason', { type: Sequelize.TEXT, allowNull: true });
    await queryInterface.addColumn(table, 'completed_at', { type: Sequelize.DATE, allowNull: true });

    await queryInterface.addIndex(table, ['payout_status', 'payout_due_at']);
    await queryInterface.addIndex(table, ['host_id']);
  },

  async down(queryInterface) {
    const table = 'shortlet_bookings';
    for (const col of [
      'host_id', 'check_in_time', 'check_out_time', 'commission_percent', 'payout_status', 'payout_due_at',
      'paid_out_at', 'host_payout', 'platform_fee', 'deposit_status', 'refunded_amount',
      'cancelled_at', 'cancelled_by', 'cancellation_reason', 'completed_at',
    ]) {
      await queryInterface.removeColumn(table, col);
    }
    for (const type of ['payout_status', 'deposit_status', 'cancelled_by']) {
      await queryInterface.sequelize.query(`DROP TYPE IF EXISTS "enum_shortlet_bookings_${type}";`);
    }
  },
};
