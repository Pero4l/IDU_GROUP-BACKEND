'use strict';
const { Model } = require('sequelize');

// Versioned RentULO cancellation policy. Never updated in place: each admin
// change inserts a new version, so the table is its own audit trail.
module.exports = (sequelize, DataTypes) => {
  class ShortletCancellationPolicies extends Model {
    static associate(models) {
      ShortletCancellationPolicies.belongsTo(models.Users, { foreignKey: 'changed_by', as: 'changedBy' });
    }
  }
  ShortletCancellationPolicies.init({
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, allowNull: false },
    version: { type: DataTypes.INTEGER, allowNull: false, unique: true },
    rules: { type: DataTypes.JSON, allowNull: false },
    changed_by: { type: DataTypes.UUID, allowNull: true },
    note: { type: DataTypes.TEXT, allowNull: true },
  }, { sequelize, modelName: 'ShortletCancellationPolicies', tableName: 'shortlet_cancellation_policies', timestamps: true });
  return ShortletCancellationPolicies;
};
