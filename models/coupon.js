'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class Coupon extends Model {
    static associate(models) {
      Coupon.belongsTo(models.Users, { foreignKey: 'created_by' });
      Coupon.hasMany(models.CouponRedemption, { foreignKey: 'coupon_id', as: 'redemptions' });
    }
  }

  Coupon.init({
    id: {
      primaryKey: true,
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
    },
    // Stored UPPERCASE so 'WELCOME10' and 'welcome10' are the same coupon.
    code: {
      type: DataTypes.STRING(32),
      allowNull: false,
      unique: true,
    },
    description: DataTypes.STRING,
    // 'fixed' → bonus_value is a flat naira amount.
    // 'percent' → bonus_value is a percentage of base_amount (capped by max_bonus).
    bonus_type: {
      type: DataTypes.ENUM('fixed', 'percent'),
      allowNull: false,
      defaultValue: 'fixed',
    },
    bonus_value: {
      type: DataTypes.DECIMAL(18, 2),
      allowNull: false,
    },
    // Required when bonus_type = 'percent': the amount the percentage is taken from.
    base_amount: {
      type: DataTypes.DECIMAL(18, 2),
      allowNull: true,
    },
    // Optional ceiling on a percent bonus.
    max_bonus: {
      type: DataTypes.DECIMAL(18, 2),
      allowNull: true,
    },
    // null = unlimited redemptions across all users.
    max_uses: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    max_uses_per_user: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 1,
    },
    used_count: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },
    starts_at: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    expires_at: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    is_active: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: true,
    },
    created_by: {
      type: DataTypes.UUID,
      allowNull: true,
    },
  }, {
    sequelize,
    modelName: 'Coupon',
    tableName: 'coupons',
  });

  return Coupon;
};
