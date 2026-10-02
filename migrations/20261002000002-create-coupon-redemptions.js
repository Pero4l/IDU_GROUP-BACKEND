'use strict';
/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const [{ exists }] = await queryInterface.sequelize.query(
      `SELECT to_regclass('public.coupon_redemptions') IS NOT NULL AS exists`,
      { type: Sequelize.QueryTypes.SELECT }
    );
    if (exists) return;

    await queryInterface.createTable('coupon_redemptions', {
      id: {
        allowNull: false,
        primaryKey: true,
        type: Sequelize.UUID,
        defaultValue: Sequelize.UUIDV4,
      },
      coupon_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: 'coupons', key: 'id' },
        onDelete: 'CASCADE',
      },
      user_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: 'users', key: 'id' },
        onDelete: 'CASCADE',
      },
      amount: {
        type: Sequelize.DECIMAL(18, 2),
        allowNull: false,
      },
      tx_ref: {
        type: Sequelize.STRING,
        allowNull: false,
        unique: true,
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

    await queryInterface.sequelize.query('CREATE INDEX IF NOT EXISTS "coupon_redemptions_coupon_id" ON "coupon_redemptions" ("coupon_id");');
    await queryInterface.sequelize.query('CREATE INDEX IF NOT EXISTS "coupon_redemptions_user_id" ON "coupon_redemptions" ("user_id");');
    await queryInterface.sequelize.query('CREATE INDEX IF NOT EXISTS "coupon_redemptions_coupon_id_user_id" ON "coupon_redemptions" ("coupon_id", "user_id");');
  },
  async down(queryInterface) {
    await queryInterface.sequelize.query('DROP TABLE IF EXISTS "coupon_redemptions" CASCADE;');
  },
};
