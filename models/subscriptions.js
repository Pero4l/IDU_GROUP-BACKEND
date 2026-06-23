"use strict";
const { Model } = require("sequelize");
module.exports = (sequelize, DataTypes) => {
  class Subscriptions extends Model {
    static associate(models) {
      Subscriptions.belongsTo(models.Users, { foreignKey: "user_id" });
    }
  }
  Subscriptions.init(
    {
      user_id: DataTypes.UUID,
      email: DataTypes.STRING,
    },
    {
      sequelize,
      modelName: "Subscriptions",
      tableName: "subscriptions",
    },
  );
  return Subscriptions;
};
