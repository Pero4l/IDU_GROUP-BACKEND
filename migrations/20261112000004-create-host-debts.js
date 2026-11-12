'use strict';
/** @type {import('sequelize-cli').Migration} */
module.exports = {
  // Money a host owes the platform: when a guest ends a stay early after the
  // host was paid, and the host's wallet can't cover the refund for the
  // unused nights, the guest is refunded in full anyway and the shortfall is
  // recorded here, then recovered automatically from the host's wallet.
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('host_debts', {
      id: { allowNull: false, primaryKey: true, type: Sequelize.UUID, defaultValue: Sequelize.literal('gen_random_uuid()') },
      host_id: {
        type: Sequelize.UUID, allowNull: false,
        references: { model: 'users', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'CASCADE',
      },
      booking_id: {
        type: Sequelize.UUID, allowNull: true,
        references: { model: 'shortlet_bookings', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'SET NULL',
      },
      amount: { type: Sequelize.DECIMAL(12, 2), allowNull: false },
      recovered_amount: { type: Sequelize.DECIMAL(12, 2), allowNull: false, defaultValue: 0 },
      status: { type: Sequelize.ENUM('open', 'settled'), allowNull: false, defaultValue: 'open' },
      reason: { type: Sequelize.STRING, allowNull: true },
      settled_at: { type: Sequelize.DATE, allowNull: true },
      createdAt: { allowNull: false, type: Sequelize.DATE },
      updatedAt: { allowNull: false, type: Sequelize.DATE },
    });
    await queryInterface.addIndex('host_debts', ['host_id', 'status']);
  },
  async down(queryInterface) {
    await queryInterface.dropTable('host_debts');
    await queryInterface.sequelize.query('DROP TYPE IF EXISTS "enum_host_debts_status";');
  },
};
