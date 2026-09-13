'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class SupportTicket extends Model {
    static associate(models) {
      SupportTicket.belongsTo(models.Users, {
        foreignKey: 'user_id',
        as: 'user',
      });
      SupportTicket.hasMany(models.SupportTicketReply, {
        foreignKey: 'ticket_id',
        as: 'replies',
        onDelete: 'CASCADE',
      });
    }
  }

  SupportTicket.init(
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
        allowNull: false,
      },
      ticket_ref: {
        type: DataTypes.STRING(12),
        allowNull: false,
        unique: true,
      },
      user_id: {
        type: DataTypes.UUID,
        allowNull: false,
      },
      subject: {
        type: DataTypes.STRING(200),
        allowNull: false,
      },
      category: {
        type: DataTypes.ENUM('general', 'billing', 'technical', 'account', 'property', 'other'),
        allowNull: false,
        defaultValue: 'general',
      },
      priority: {
        type: DataTypes.ENUM('low', 'medium', 'high', 'urgent'),
        allowNull: false,
        defaultValue: 'medium',
      },
      status: {
        type: DataTypes.ENUM('open', 'in_progress'),
        allowNull: false,
        defaultValue: 'open',
      },
      description: {
        type: DataTypes.TEXT,
        allowNull: false,
      },
    },
    {
      sequelize,
      modelName: 'SupportTicket',
      tableName: 'support_tickets',
      timestamps: true,
      indexes: [
        { fields: ['user_id'] },
        { fields: ['status'] },
        { fields: ['priority'] },
        { fields: ['category'] },
      ],
    }
  );

  return SupportTicket;
};