'use strict';
/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    // Idempotent: an earlier partial run may have created the table without
    // recording the migration, so never assume it's missing.
    const [{ exists }] = await queryInterface.sequelize.query(
      `SELECT to_regclass('public.coupons') IS NOT NULL AS exists`,
      { type: Sequelize.QueryTypes.SELECT }
    );

    if (!exists) {
      await queryInterface.createTable('coupons', {
        id: {
          allowNull: false,
          primaryKey: true,
          type: Sequelize.UUID,
          defaultValue: Sequelize.UUIDV4,
        },
        code: {
          type: Sequelize.STRING(32),
          allowNull: false,
          unique: true,
        },
        description: {
          type: Sequelize.STRING,
          allowNull: true,
        },
        bonus_type: {
          type: Sequelize.ENUM('fixed', 'percent'),
          allowNull: false,
          defaultValue: 'fixed',
        },
        bonus_value: {
          type: Sequelize.DECIMAL(18, 2),
          allowNull: false,
        },
        base_amount: {
          type: Sequelize.DECIMAL(18, 2),
          allowNull: true,
        },
        max_bonus: {
          type: Sequelize.DECIMAL(18, 2),
          allowNull: true,
        },
        max_uses: {
          type: Sequelize.INTEGER,
          allowNull: true,
        },
        max_uses_per_user: {
          type: Sequelize.INTEGER,
          allowNull: false,
          defaultValue: 1,
        },
        used_count: {
          type: Sequelize.INTEGER,
          allowNull: false,
          defaultValue: 0,
        },
        starts_at: {
          type: Sequelize.DATE,
          allowNull: true,
        },
        expires_at: {
          type: Sequelize.DATE,
          allowNull: true,
        },
        is_active: {
          type: Sequelize.BOOLEAN,
          allowNull: false,
          defaultValue: true,
        },
        created_by: {
          type: Sequelize.UUID,
          allowNull: true,
          references: { model: 'users', key: 'id' },
          onDelete: 'SET NULL',
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
    }

    await queryInterface.sequelize.query('CREATE INDEX IF NOT EXISTS "coupons_code" ON "coupons" ("code");');
    await queryInterface.sequelize.query('CREATE INDEX IF NOT EXISTS "coupons_is_active" ON "coupons" ("is_active");');
  },
  async down(queryInterface) {
    await queryInterface.sequelize.query('DROP TABLE IF EXISTS "coupon_redemptions" CASCADE;');
    await queryInterface.sequelize.query('DROP TABLE IF EXISTS "coupons" CASCADE;');
  },
};
