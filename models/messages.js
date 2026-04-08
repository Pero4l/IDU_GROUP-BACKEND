'use strict';
const {
  Model
} = require('sequelize');
module.exports = (sequelize, DataTypes) => {
  class Messages extends Model {
    /**
     * Helper method for defining associations.
     * This method is not a part of Sequelize lifecycle.
     * The `models/index` file will call this method automatically.
     */
    static associate(models) {
      Messages.belongsTo(models.Conversations, { foreignKey: 'conversation_id', as: 'conversation' });
      Messages.belongsTo(models.Users, { foreignKey: 'sender_id', as: 'sender' });
    }
  }
  Messages.init({
    conversation_id: DataTypes.INTEGER,
    sender_id: DataTypes.UUID,
    content: DataTypes.TEXT
  }, {
    sequelize,
    modelName: 'Messages',
  });
  return Messages;
};