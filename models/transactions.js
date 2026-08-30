"use strict";
const { Model } = require("sequelize");
module.exports = (sequelize, DataTypes) => {
  class Transactions extends Model {
    static associate(models) {
      Transactions.belongsTo(models.Users, { foreignKey: "user_id" });
      Transactions.belongsTo(models.Rentals, { foreignKey: "rental_id" });
    }
  }
  Transactions.init(
    {
      user_id: DataTypes.UUID,
      rental_id: DataTypes.UUID,
      reference: DataTypes.STRING,
      amount: DataTypes.INTEGER,
      status: DataTypes.STRING,
      payment_type: DataTypes.STRING,
    },
    {
      sequelize,
      modelName: "Transactions",
      tableName: "transactions",
    },
  );
  return Transactions;
};
