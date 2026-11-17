'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class Tenancies extends Model {
    static associate(models) {
      Tenancies.belongsTo(models.Rentals, { foreignKey: 'rental_id' });
      Tenancies.belongsTo(models.Users, { foreignKey: 'tenant_id', as: 'tenant' });
    }
  }
  Tenancies.init({
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, allowNull: false },
    rental_id: { type: DataTypes.UUID, allowNull: false },
    tenant_id: { type: DataTypes.UUID, allowNull: false },
    start_date: { type: DataTypes.DATE, allowNull: false },
    end_date: { type: DataTypes.DATE, allowNull: true },
    status: { type: DataTypes.ENUM('active', 'ended'), allowNull: false, defaultValue: 'active' },
  }, { sequelize, modelName: 'Tenancies', tableName: 'tenancies', timestamps: true });
  return Tenancies;
};
