'use strict';
const {
  Model
} = require('sequelize');
module.exports = (sequelize, DataTypes) => {
  class progress extends Model {
    /**
     * Helper method for defining associations.
     * This method is not a part of Sequelize lifecycle.
     * The `models/index` file will call this method automatically.
     */
    static associate(models) {
      // define association here
      progress.belongsTo(models.Users, { foreignKey: 'user_id' });
      progress.belongsTo(models.Rentals, { foreignKey: 'rental_id' });
    }
  }
  progress.init({
    user_id: DataTypes.UUID,
    rental_id: DataTypes.UUID,
    booked: DataTypes.BOOLEAN,
    locked: DataTypes.BOOLEAN,
    liked: DataTypes.BOOLEAN,
    applied: DataTypes.BOOLEAN,
  }, {
    sequelize,
    modelName: 'progress',
  });
  return progress;
};