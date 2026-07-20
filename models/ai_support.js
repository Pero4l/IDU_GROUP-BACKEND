'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class AiSupport extends Model {
    static associate(models) {
      AiSupport.belongsTo(models.Users, { foreignKey: 'user_id', as: 'user' });
    }
  }

  AiSupport.init(
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
      session_id: {
        type: DataTypes.STRING,
        allowNull: false,
        comment: 'Groups messages belonging to one chat session',
      },
      role: {
        type: DataTypes.ENUM('user', 'assistant'),
        allowNull: false,
      },
      content: {
        type: DataTypes.TEXT,
        allowNull: false,
      },
    },
    {
      sequelize,
      modelName: 'AiSupport',
      tableName: 'ai_support',
      timestamps: true,
      indexes: [
        { fields: ['user_id'] },
        { fields: ['session_id'] },
        { fields: ['user_id', 'session_id'] },
      ],
    }
  );

  return AiSupport;
};
