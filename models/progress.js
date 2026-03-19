'use strict';
const {
  Model
} = require('sequelize');
module.exports = (sequelize, DataTypes) => {
  class Progress extends Model {
    /**
     * Helper method for defining associations.
     * This method is not a part of Sequelize lifecycle.
     * The `models/index` file will call this method automatically.
     */
    static associate(models) {
      // define association here
      Progress.belongsTo(models.Users, { foreignKey: 'user_id' });
      Progress.belongsTo(models.Rentals, { foreignKey: 'rental_id' });
    }
  }
  Progress.init({
    user_id: DataTypes.UUID,
    rental_id: DataTypes.UUID,
    booked: DataTypes.BOOLEAN,
    locked: DataTypes.BOOLEAN,
    liked: DataTypes.BOOLEAN,
  }, {
    sequelize,
    modelName: 'Progress',
    tableName: 'progress'
  });
  return Progress;
};