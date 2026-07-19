'use strict';
/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('wallet_transactions', {
      id: {
        allowNull: false,
        primaryKey: true,
        type: Sequelize.UUID,
        defaultValue: Sequelize.UUIDV4,
      },
      wallet_id: {
        type: Sequelize.UUID,
        allowNull: false,
      },
      user_id: {
        type: Sequelize.UUID,
        allowNull: false,
      },
      tx_ref: {
        type: Sequelize.STRING,
        allowNull: false,
        unique: true,
      },
      flw_ref: {
        type: Sequelize.STRING,
        allowNull: true,
      },
      type: {
        type: Sequelize.ENUM('topup', 'withdrawal', 'transfer_in', 'transfer_out', 'lock house', 'house rent', 'inspection fee', 'refund_payment'),
        allowNull: false,
      },
      amount: {
        type: Sequelize.DECIMAL(18, 2),
        allowNull: false,
      },
      status: {
        type: Sequelize.ENUM('pending', 'success', 'failed'),
        allowNull: false,
        defaultValue: 'pending',
      },
      narration: {
        type: Sequelize.STRING,
        allowNull: true,
      },
      meta: {
        type: Sequelize.JSONB,
        allowNull: true,
      },
      createdAt: {
        allowNull: false,
        type: Sequelize.DATE,
      },
      updatedAt: {
        allowNull: false,
        type: Sequelize.DATE,
      },
    });

    await queryInterface.addIndex('wallet_transactions', ['wallet_id']);
    await queryInterface.addIndex('wallet_transactions', ['user_id']);
  },
  async down(queryInterface) {
    await queryInterface.dropTable('wallet_transactions');
  },
};
