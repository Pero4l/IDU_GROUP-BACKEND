'use strict';
const {
  Model
} = require('sequelize');
module.exports = (sequelize, DataTypes) => {
  class Notification extends Model {
    /**
     * Helper method for defining associations.
     * This method is not a part of Sequelize lifecycle.
     * The `models/index` file will call this method automatically.
     */
    static associate(models) {
      // define association here
      Notification.belongsTo(models.Users, {
        foreignKey: "user_id",
        // as: "user"
      });
    }
  }
  Notification.init({
    user_id: DataTypes.UUID,
    type: DataTypes.STRING,
    notification: DataTypes.STRING,
    is_read: DataTypes.BOOLEAN
  }, {
    sequelize,
    modelName: 'Notifications',
    tableName: "notifications"
  });
  return Notification;
};