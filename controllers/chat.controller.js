const { Conversations, Messages, Users } = require("../models");
const { Op } = require("sequelize");
const socketConfig = require('../config/socket');
const { logAndEmailUser } = require('./notification.controller');

exports.initiateChat = async (req, res) => {
  try {
    const { other_user_id } = req.body;
    const current_user_id = req.user.id;
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
      tenant_id = current_user_id;
      landlord_id = other_user_id;
    } else if (current_user_role === "landlord" && otherUser.role === "tenant") {
      landlord_id = current_user_id;
      tenant_id = other_user_id;
    } else {
      tenant_id = current_user_id;
      landlord_id = other_user_id;
    }

    let conversation = await Conversations.findOne({
      where: {
        [Op.or]: [
          { tenant_id, landlord_id },
          { tenant_id: landlord_id, landlord_id: tenant_id }
        ]
      }
    });

    if (!conversation) {
      conversation = await Conversations.create({
        tenant_id,
        landlord_id
      });
    }

    res.status(200).json({ success: true, conversation });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Server Error" });
  }
};

exports.getChats = async (req, res) => {
  try {
    const current_user_id = req.user.id;
    const conversations = await Conversations.findAll({
      where: {
        [Op.or]: [{ tenant_id: current_user_id }, { landlord_id: current_user_id }]
      },
      include: [
        { model: Users, as: "tenant", attributes: ["id", "first_name", "last_name", "role", "email"] },
        { model: Users, as: "landlord", attributes: ["id", "first_name", "last_name", "role", "email"] }
      ],
      order: [["updatedAt", "DESC"]]
    });
    res.status(200).json({ success: true, conversations });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Server Error" });
  }
};

exports.sendMessage = async (req, res) => {
  try {
    const { conversation_id, content } = req.body;
    const current_user_id = req.user.id;

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

    const message = await Messages.create({
      conversation_id,
      sender_id: current_user_id,
      content
    });

    conversation.changed('updatedAt', true);
    await conversation.save();

    // Notification
    const receiver_id = conversation.tenant_id === current_user_id ? conversation.landlord_id : conversation.tenant_id;
    const receiver = await Users.findByPk(receiver_id);
    if (receiver) {
      await logAndEmailUser(receiver_id, receiver.email, "New Chat Message", `You received a new message on RentULO: "${content}"`);
    }

    const io = socketConfig.getIo();
    io.to(`conversation_${conversation_id}`).emit('new_message', {
      success: true,
      data: message
    });

    res.status(201).json({ success: true, message });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Server Error" });
  }
};

exports.getMessages = async (req, res) => {
  try {
    const { conversation_id } = req.params;
    const current_user_id = req.user.id;

    const conversation = await Conversations.findByPk(conversation_id);
    if (!conversation) {
      return res.status(404).json({ success: false, message: "Conversation not found" });
    }

    // Check if user is part of the conversation or is admin
    if (conversation.tenant_id !== current_user_id && conversation.landlord_id !== current_user_id && req.user.role !== 'admin' && !req.user.is_superadmin) {
        return res.status(403).json({ success: false, message: "Not authorized to view messages in this conversation" });
    }

    const messages = await Messages.findAll({
      where: { conversation_id },
      include: [
        { model: Users, as: "sender", attributes: ["id", "first_name", "last_name", "role"] }
      ],
      order: [["createdAt", "ASC"]]
    });

    res.status(200).json({ success: true, messages });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Server Error" });
  }
};
