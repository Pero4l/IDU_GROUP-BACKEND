'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class SupportTicketReply extends Model {
    static associate(models) {
      SupportTicketReply.belongsTo(models.SupportTicket, {
        foreignKey: 'ticket_id',
        as: 'ticket',
        onDelete: 'CASCADE',
      });
      SupportTicketReply.belongsTo(models.Users, {
        foreignKey: 'sender_id',
        as: 'sender',
      });
    }
  }

  SupportTicketReply.init(
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
        allowNull: false,
      },
      ticket_id: {
        type: DataTypes.UUID,
        allowNull: false,
      },
      sender_id: {
        type: DataTypes.UUID,
        allowNull: false,
      },
      sender_role: {
        type: DataTypes.ENUM('user', 'admin'),
        allowNull: false,
      },
      message: {
        type: DataTypes.TEXT,
        allowNull: false,
      },
    },
    {
      sequelize,
      modelName: 'SupportTicketReply',
      tableName: 'support_ticket_replies',
      timestamps: true,
      indexes: [{ fields: ['ticket_id'] }, { fields: ['sender_id'] }],
    }
  );

  return SupportTicketReply;
};