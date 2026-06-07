"use strict";
const { Model } = require("sequelize");
module.exports = (sequelize, DataTypes) => {
  class Testimonials extends Model {
    /**
     * Helper method for defining associations.
     * This method is not a part of Sequelize lifecycle.
     * The `models/index` file will call this method automatically.
     */
    static associate(models) {
      // define association here
      Testimonials.belongsTo(models.Users, {
        foreignKey: "user_id",
      });
    }
  }
  Testimonials.init(
    {
      user_id: DataTypes.UUID,
      user_name: DataTypes.STRING,
      user_image: DataTypes.STRING,
      rating: DataTypes.INTEGER,
      message: DataTypes.STRING,
    },
    {
      sequelize,
      modelName: "Testimonials",
      tableName: "testimonials",
    },
  );
  return Testimonials;
};
