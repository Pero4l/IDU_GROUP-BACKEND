'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class HostDebts extends Model {
    static associate(models) {
      HostDebts.belongsTo(models.Users, { foreignKey: 'host_id', as: 'host' });
      HostDebts.belongsTo(models.ShortletBookings, { foreignKey: 'booking_id', as: 'booking' });
    }
  }
  HostDebts.init({
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, allowNull: false },
    host_id: { type: DataTypes.UUID, allowNull: false },
    booking_id: { type: DataTypes.UUID, allowNull: true },
    amount: { type: DataTypes.DECIMAL(12, 2), allowNull: false },
    recovered_amount: { type: DataTypes.DECIMAL(12, 2), allowNull: false, defaultValue: 0 },
    status: { type: DataTypes.ENUM('open', 'settled'), allowNull: false, defaultValue: 'open' },
    reason: { type: DataTypes.STRING, allowNull: true },
    settled_at: { type: DataTypes.DATE, allowNull: true },
  }, { sequelize, modelName: 'HostDebts', tableName: 'host_debts', timestamps: true });
  return HostDebts;
};
