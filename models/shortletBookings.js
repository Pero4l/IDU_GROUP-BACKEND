'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class ShortletBookings extends Model {
    static associate(models) {
      ShortletBookings.belongsTo(models.Users, { foreignKey: 'user_id', as: 'guest' });
      ShortletBookings.belongsTo(models.Shortlets, { foreignKey: 'shortlet_id', as: 'shortlet' });
      ShortletBookings.belongsTo(models.Users, { foreignKey: 'host_id', as: 'host' });
    }
  }

  ShortletBookings.init({
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
      allowNull: false,
    },
    user_id: { type: DataTypes.UUID, allowNull: false },
    shortlet_id: { type: DataTypes.UUID, allowNull: true },
    host_id: { type: DataTypes.UUID, allowNull: true },
    check_in: { type: DataTypes.DATEONLY, allowNull: false },
    check_out: { type: DataTypes.DATEONLY, allowNull: false },
    nights: { type: DataTypes.INTEGER, allowNull: false },
    guests: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
    price_per_night: { type: DataTypes.DECIMAL(12, 2), allowNull: false },
    cleaning_fee: { type: DataTypes.DECIMAL(12, 2), allowNull: false, defaultValue: 0 },
    security_deposit: { type: DataTypes.DECIMAL(12, 2), allowNull: false, defaultValue: 0 },
    total_amount: { type: DataTypes.DECIMAL(12, 2), allowNull: false },
    status: {
      type: DataTypes.ENUM('confirmed', 'cancelled', 'completed'),
      allowNull: false,
      defaultValue: 'confirmed',
    },
    // Snapshots taken at booking time
    check_in_time: { type: DataTypes.TIME, allowNull: false, defaultValue: '14:00:00' },
    check_out_time: { type: DataTypes.TIME, allowNull: false, defaultValue: '11:00:00' },
    commission_percent: { type: DataTypes.DECIMAL(5, 2), allowNull: false, defaultValue: 100 },
    // Held-payment settlement (see utils/shortletSettlement.js)
    payout_status: {
      type: DataTypes.ENUM('pending', 'paid', 'cancelled'),
      allowNull: false,
      defaultValue: 'pending',
    },
    payout_due_at: { type: DataTypes.DATE, allowNull: true },
    paid_out_at: { type: DataTypes.DATE, allowNull: true },
    host_payout: { type: DataTypes.DECIMAL(12, 2), allowNull: false, defaultValue: 0 },
    platform_fee: { type: DataTypes.DECIMAL(12, 2), allowNull: false, defaultValue: 0 },
    // none · held (during stay + 48h claim window) · claimed (host claim
    // awaiting admin) · refunded (all back to guest) · settled (claim decided:
    // deposit_paid_to_host to the host, the rest back to the guest)
    deposit_status: {
      type: DataTypes.ENUM('none', 'held', 'claimed', 'refunded', 'settled'),
      allowNull: false,
      defaultValue: 'none',
    },
    deposit_refund_due_at: { type: DataTypes.DATE, allowNull: true },
    deposit_claim_amount: { type: DataTypes.DECIMAL(12, 2), allowNull: true },
    deposit_claim_reason: { type: DataTypes.TEXT, allowNull: true },
    deposit_claim_photos: { type: DataTypes.JSON, allowNull: false, defaultValue: [] }, // Cloudinary URLs
    deposit_claimed_at: { type: DataTypes.DATE, allowNull: true },
    deposit_claim_decision: { type: DataTypes.ENUM('approved', 'partially_approved', 'rejected'), allowNull: true },
    deposit_claim_note: { type: DataTypes.TEXT, allowNull: true },
    deposit_claim_resolved_at: { type: DataTypes.DATE, allowNull: true },
    deposit_paid_to_host: { type: DataTypes.DECIMAL(12, 2), allowNull: false, defaultValue: 0 },
    cancellation_policy: {
      type: DataTypes.ENUM('flexible', 'moderate', 'firm', 'strict'),
      allowNull: false,
      defaultValue: 'flexible',
    },
    // Set when a stay is ended early: the day the guest actually leaves.
    actual_check_out: { type: DataTypes.DATEONLY, allowNull: true },
    refunded_amount: { type: DataTypes.DECIMAL(12, 2), allowNull: false, defaultValue: 0 },
    cancelled_at: { type: DataTypes.DATE, allowNull: true },
    cancelled_by: { type: DataTypes.ENUM('guest', 'host'), allowNull: true },
    cancellation_reason: { type: DataTypes.TEXT, allowNull: true },
    completed_at: { type: DataTypes.DATE, allowNull: true },
  }, {
    sequelize,
    modelName: 'ShortletBookings',
    tableName: 'shortlet_bookings',
    timestamps: true,
  });

  return ShortletBookings;
};
