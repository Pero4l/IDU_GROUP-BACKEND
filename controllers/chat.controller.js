const { Conversations, Messages, Users } = require("../models");
const { Op } = require("sequelize");
const socketConfig = require('../config/socket');
const { logAndEmailUser } = require('./notification.controller');
const { withTransaction } = require('../utils/rollback');
const logger = require('../utils/logger');

// POST /chat/initiate
exports.initiateChat = async (req, res) => {
  try {
    const { other_user_id } = req.body;
    const current_user_id = req.user.userId;
    const current_user_role = req.user.role;

    if (!other_user_id) {
      return res.status(400).json({ success: false, message: "other_user_id is required" });
    }

    const otherUser = await Users.findByPk(other_user_id);
    if (!otherUser) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    let tenant_id, landlord_id;
    if (current_user_role === "tenant" && otherUser.role === "landlord") {
      tenant_id = current_user_id; landlord_id = other_user_id;
    } else if (current_user_role === "landlord" && otherUser.role === "tenant") {
      landlord_id = current_user_id; tenant_id = other_user_id;
    } else {
      tenant_id = current_user_id; landlord_id = other_user_id;
    }

    // findOrCreate inside transaction so a duplicate conversation is never
    // created if two requests race at the same time
    const conversation = await withTransaction(async (t) => {
      const existing = await Conversations.findOne({
        where: {
          [Op.or]: [
            { tenant_id, landlord_id },
            { tenant_id: landlord_id, landlord_id: tenant_id }
          ]
        },
        transaction: t,
      });

      if (existing) return existing;

      return Conversations.create({ tenant_id, landlord_id }, { transaction: t });
    }, { context: 'initiateChat', current_user_id, other_user_id });

    return res.status(200).json({ success: true, conversation });
  } catch (err) {
    logger.error('Error initiating chat', { error: err.message, userId: req.user?.userId });
    return res.status(500).json({ success: false, message: "Server Error" });
  }
};

// GET /chat/all
exports.getChats = async (req, res) => {
  try {
    const current_user_id = req.user.userId;
    const conversations = await Conversations.findAll({
      where: { [Op.or]: [{ tenant_id: current_user_id }, { landlord_id: current_user_id }] },
      include: [
        { model: Users, as: "tenant",   attributes: ["id", "full_name", "role", "email"] },
        { model: Users, as: "landlord", attributes: ["id", "full_name", "role", "email"] }
      ],
      order: [["updatedAt", "DESC"]]
    });
    const dataJson = conversations.map(c => {
      const item = c.toJSON();
      if (item.tenant) {
        const parts = (item.tenant.full_name || '').split(' ');
        item.tenant.first_name = parts[0] || '';
        item.tenant.last_name = parts.slice(1).join(' ') || '';
      }
      if (item.landlord) {
        const parts = (item.landlord.full_name || '').split(' ');
        item.landlord.first_name = parts[0] || '';
        item.landlord.last_name = parts.slice(1).join(' ') || '';
      }
      return item;
    });
    return res.status(200).json({ success: true, conversations: dataJson });
  } catch (err) {
    logger.error('Error getting chats', { error: err.message, userId: req.user?.userId });
    return res.status(500).json({ success: false, message: "Server Error" });
  }
};

// POST /chat/send
exports.sendMessage = async (req, res) => {
  try {
    const { conversation_id, content } = req.body;
    const current_user_id = req.user.userId;

    if (!conversation_id || !content) {
      return res.status(400).json({ success: false, message: "conversation_id and content are required" });
    }

    const conversation = await Conversations.findByPk(conversation_id);
    if (!conversation) {
      return res.status(404).json({ success: false, message: "Conversation not found" });
    }
    if (conversation.tenant_id !== current_user_id && conversation.landlord_id !== current_user_id) {
      return res.status(403).json({ success: false, message: "Not authorized to send messages in this conversation" });
    }

    // Wrap message creation + conversation timestamp update in one transaction.
    // If the conversation.save() fails, the message is rolled back too —
    // no orphaned message rows with a stale conversation timestamp.
    const message = await withTransaction(async (t) => {
      const msg = await Messages.create(
        { conversation_id, sender_id: current_user_id, content },
        { transaction: t }
      );

      conversation.changed('updatedAt', true);
      await conversation.save({ transaction: t });

      return msg;
    }, { context: 'sendMessage', current_user_id, conversation_id });

    logger.info('Message sent', { messageId: message.id, conversation_id, current_user_id });

    // Emit via socket (non-transactional — best effort)
    try {
      const io = socketConfig.getIo();
      io.to(`conversation_${conversation_id}`).emit('new_message', { success: true, data: message });
    } catch (socketErr) {
      logger.warn('Socket emit failed (non-critical)', { error: socketErr.message });
    }

    // Non-critical email notification
    const receiver_id = conversation.tenant_id === current_user_id ? conversation.landlord_id : conversation.tenant_id;
    const receiver = await Users.findByPk(receiver_id);
    if (receiver) {
      await logAndEmailUser(receiver_id, receiver.email, "New Chat Message", `You received a new message on RentULO: "${content}"`);
    }

    return res.status(201).json({ success: true, message });
  } catch (err) {
    logger.error('Error sending message', { error: err.message, userId: req.user?.userId });
    return res.status(500).json({ success: false, message: "Server Error" });
  }
};

// GET /chat/:conversation_id/messages
exports.getMessages = async (req, res) => {
  try {
    const { conversation_id } = req.params;
    const current_user_id = req.user.userId;

    const conversation = await Conversations.findByPk(conversation_id);
    if (!conversation) {
      return res.status(404).json({ success: false, message: "Conversation not found" });
    }

    if (
      conversation.tenant_id !== current_user_id &&
      conversation.landlord_id !== current_user_id &&
      req.user.role !== 'admin' &&
      !req.user.is_superadmin
    ) {
      return res.status(403).json({ success: false, message: "Not authorized to view messages in this conversation" });
    }

    const messages = await Messages.findAll({
      where: { conversation_id },
      include: [{ model: Users, as: "sender", attributes: ["id", "full_name", "role"] }],
      order: [["createdAt", "ASC"]]
    });

    const dataJson = messages.map(m => {
      const item = m.toJSON();
      if (item.sender) {
        const parts = (item.sender.full_name || '').split(' ');
        item.sender.first_name = parts[0] || '';
        item.sender.last_name = parts.slice(1).join(' ') || '';
      }
      return item;
    });

    return res.status(200).json({ success: true, messages: dataJson });
  } catch (err) {
    logger.error('Error getting messages', { error: err.message, userId: req.user?.userId });
    return res.status(500).json({ success: false, message: "Server Error" });
  }
};
