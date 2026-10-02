'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class CouponRedemption extends Model {
    static associate(models) {
      CouponRedemption.belongsTo(models.Coupon, { foreignKey: 'coupon_id', as: 'coupon' });
      CouponRedemption.belongsTo(models.Users, { foreignKey: 'user_id' });
      CouponRedemption.belongsTo(models.WalletTransactions, { foreignKey: 'tx_ref', targetKey: 'tx_ref' });
    }
  }

  CouponRedemption.init({
    id: {
      primaryKey: true,
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
    },
    coupon_id: {
      type: DataTypes.UUID,
      allowNull: false,
    },
    user_id: {
      type: DataTypes.UUID,
      allowNull: false,
    },
    // Bonus actually credited, in naira.
    amount: {
      type: DataTypes.DECIMAL(18, 2),
      allowNull: false,
    },
    // Links this redemption to the wallet_transactions row it created.
    tx_ref: {
      type: DataTypes.STRING,
      allowNull: false,
      unique: true,
    },
  }, {
    sequelize,
    modelName: 'CouponRedemption',
    tableName: 'coupon_redemptions',
  });

  return CouponRedemption;
};
