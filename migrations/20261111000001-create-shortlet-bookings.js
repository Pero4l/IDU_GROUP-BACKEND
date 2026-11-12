'use strict';
/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('shortlet_bookings', {
      id: {
        allowNull: false,
        primaryKey: true,
        type: Sequelize.UUID,
        defaultValue: Sequelize.literal('gen_random_uuid()'),
      },
      user_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: 'users', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      shortlet_id: {
        type: Sequelize.UUID,
        // Nullable so a booking (a record of money paid) survives if its
        // listing is later deleted. deleteShortlet refuses to delete a
        // listing that still has upcoming confirmed stays.
        allowNull: true,
        references: { model: 'shortlets', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      },
      check_in: { type: Sequelize.DATEONLY, allowNull: false },
      check_out: { type: Sequelize.DATEONLY, allowNull: false },
      nights: { type: Sequelize.INTEGER, allowNull: false },
      guests: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 1 },
      price_per_night: { type: Sequelize.DECIMAL(12, 2), allowNull: false },
      cleaning_fee: { type: Sequelize.DECIMAL(12, 2), allowNull: false, defaultValue: 0 },
      security_deposit: { type: Sequelize.DECIMAL(12, 2), allowNull: false, defaultValue: 0 },
      total_amount: { type: Sequelize.DECIMAL(12, 2), allowNull: false },
      status: {
        type: Sequelize.ENUM('confirmed', 'cancelled', 'completed'),
        allowNull: false,
        defaultValue: 'confirmed',
      },
      createdAt: { allowNull: false, type: Sequelize.DATE },
      updatedAt: { allowNull: false, type: Sequelize.DATE },
    });

    await queryInterface.addIndex('shortlet_bookings', ['user_id']);
    await queryInterface.addIndex('shortlet_bookings', ['shortlet_id', 'status', 'check_in', 'check_out']);
  },

  async down(queryInterface) {
    await queryInterface.dropTable('shortlet_bookings');
    await queryInterface.sequelize.query('DROP TYPE IF EXISTS "enum_shortlet_bookings_status";');
  },
};
