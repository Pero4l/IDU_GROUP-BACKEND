'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class Inspections extends Model {
    static associate(models) {
      Inspections.belongsTo(models.Users, { foreignKey: 'user_id', as: 'tenant' });
      Inspections.belongsTo(models.Rentals, { foreignKey: 'rental_id', as: 'rental' });
    }
  }

  Inspections.init(
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
        allowNull: false,
      },
      user_id: {
        type: DataTypes.UUID,
        allowNull: false,
      },
      rental_id: {
        type: DataTypes.UUID,
        allowNull: false,
      },
      date: {
        type: DataTypes.DATEONLY,
        allowNull: false,
      },
      time: {
        type: DataTypes.TIME,
        allowNull: false,
      },
      is_paid: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
      },
    },
    {
      sequelize,
      modelName: 'Inspections',
      tableName: 'inspections',
      timestamps: true,
    }
  );

  return Inspections;
};
