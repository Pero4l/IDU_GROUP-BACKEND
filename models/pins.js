'use strict';
const {
  Model
} = require('sequelize');
module.exports = (sequelize, DataTypes) => {
  class Pins extends Model {
    /**
     * Helper method for defining associations.
     * This method is not a part of Sequelize lifecycle.
     * The `models/index` file will call this method automatically.
     */
    static associate(models) {
      // define association here
    }
  }
  Pins.init({
    user_id: DataTypes.UUID,
    pin: DataTypes.STRING
  }, {
    sequelize,
    modelName: 'Pins',
    tableName: 'pins',
  });
  return Pins;
};