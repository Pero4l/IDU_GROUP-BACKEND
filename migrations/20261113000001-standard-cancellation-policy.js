'use strict';
/** @type {import('sequelize-cli').Migration} */

// RentULO standard cancellation policy:
//  - one platform-wide policy for cancelling BEFORE check-in, edited by super
//    admins and versioned (every change is a new row = audit trail);
//  - the host decides per listing whether unused nights are refundable when a
//    guest checks out early;
//  - each booking stores a snapshot of the rules it was made under, plus a
//    full record of its cancellation.
const DEFAULT_RULES = {
  preCheckIn: {
    tiers: [
      { minHoursBefore: 168, nightsRefundPercent: 100 },
      { minHoursBefore: 72, nightsRefundPercent: 50 },
      { minHoursBefore: 0, nightsRefundPercent: 0 },
    ],
  },
  gracePeriod: { enabled: true, withinHoursOfBooking: 24, minHoursBeforeCheckIn: 72 },
  earlyCheckout: { noticeHours: 24 },
};

module.exports = {
  async up(queryInterface, Sequelize) {
    const q = queryInterface.sequelize;

    await queryInterface.createTable('shortlet_cancellation_policies', {
      id: { allowNull: false, primaryKey: true, type: Sequelize.UUID, defaultValue: Sequelize.literal('gen_random_uuid()') },
      version: { type: Sequelize.INTEGER, allowNull: false, unique: true },
      rules: { type: Sequelize.JSON, allowNull: false },
      changed_by: {
        type: Sequelize.UUID, allowNull: true,
        references: { model: 'users', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'SET NULL',
      },
      note: { type: Sequelize.TEXT, allowNull: true },
      createdAt: { allowNull: false, type: Sequelize.DATE },
      updatedAt: { allowNull: false, type: Sequelize.DATE },
    });
    await queryInterface.bulkInsert('shortlet_cancellation_policies', [{
      version: 1,
      rules: JSON.stringify(DEFAULT_RULES),
      changed_by: null,
      note: 'Default RentULO policy',
      createdAt: new Date(),
      updatedAt: new Date(),
    }]);

    // Host's early check-out choice. Existing listings keep today's behaviour.
    await queryInterface.addColumn('shortlets', 'earlyCheckoutRefundable', {
      type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true,
    });

    await q.query(`ALTER TYPE "enum_shortlet_bookings_cancellation_policy" ADD VALUE IF NOT EXISTS 'standard';`);
    await queryInterface.addColumn('shortlet_bookings', 'cancellation_policy_version', { type: Sequelize.INTEGER, allowNull: true });
    await queryInterface.addColumn('shortlet_bookings', 'cancellation_policy_snapshot', { type: Sequelize.JSON, allowNull: true });
    await queryInterface.addColumn('shortlet_bookings', 'cancellation_details', { type: Sequelize.JSON, allowNull: true });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('shortlet_bookings', 'cancellation_details');
    await queryInterface.removeColumn('shortlet_bookings', 'cancellation_policy_snapshot');
    await queryInterface.removeColumn('shortlet_bookings', 'cancellation_policy_version');
    await queryInterface.removeColumn('shortlets', 'earlyCheckoutRefundable');
    await queryInterface.dropTable('shortlet_cancellation_policies');
    // 'standard' stays in the enum (Postgres can't drop enum values).
  },
};
