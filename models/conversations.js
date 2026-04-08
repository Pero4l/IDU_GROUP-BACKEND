'use strict';
const {
  Model
} = require('sequelize');
module.exports = (sequelize, DataTypes) => {
  class Conversations extends Model {
    /**
     * Helper method for defining associations.
     * This method is not a part of Sequelize lifecycle.
     * The `models/index` file will call this method automatically.
     */
    static associate(models) {
      Conversations.belongsTo(models.Users, { foreignKey: 'tenant_id', as: 'tenant' });
      Conversations.belongsTo(models.Users, { foreignKey: 'landlord_id', as: 'landlord' });
      Conversations.hasMany(models.Messages, { foreignKey: 'conversation_id', as: 'messages' });
    }
  }
  Conversations.init({
    tenant_id: DataTypes.UUID,
    landlord_id: DataTypes.UUID
  }, {
    sequelize,
    modelName: 'Conversations',
  });
  return Conversations;
};