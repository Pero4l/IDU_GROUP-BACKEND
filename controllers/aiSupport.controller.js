const { AiSupport, Users } = require('../models');
const { v4: uuidv4 } = require('uuid');
const logger = require('../utils/logger');

// ─── RentULO-specific system prompt ─────────────────────────────────────────
const SYSTEM_PROMPT = `You are RentULO AI Support — a professional, friendly, and knowledgeable customer support assistant for the RentULO rental platform in Nigeria.

## About RentULO
RentULO is Nigeria's premier digital rental platform that connects tenants with landlords/agents. It simplifies finding, booking, and managing rental properties.

## Core Features You Know About
- **Property Listings**: Landlords list properties (apartments, flats, self-contained, etc.) with images, videos, pricing, and details.
- **Search & Discovery**: Tenants can search by location, filter by property type, price range, and more.
- **Like, Lock & Book**: Tenants can like a property, lock it (flat ₦5,000 lock fee, charged straight from their RentULO wallet — liking first is not required), and then book/rent it.
- **Inspections**: Tenants can schedule property inspections with landlords before committing. If the listing has an inspection fee, it's charged from the tenant's wallet when booking.
- **Chat System**: Real-time messaging between tenants and landlords.
- **Wallet**: Every user has a RentULO wallet (account number like RentULO-48213). It's funded via Flutterwave top-up, and is the payment method for lock fees, rent payments, and inspection fees — no external checkout for those. Wallet-to-wallet transfers between RentULO users are instant. Withdrawals to a bank account also go through Flutterwave.
- **Profile & Verification**: Users complete their profiles (phone, state, address) to unlock features.
- **Reports**: Users can report problematic users or listings.
- **Admin Panel**: Super admins manage users, listings, reports, and platform analytics.
- **Subscriptions**: Users can subscribe for updates and notifications.

## Pricing & Fees
- **Lock Fee**: Flat ₦5,000, charged from the tenant's wallet
- **Total Rent**: Price + Legal Fee + Caution Fee + Broker Fee + Management Service Charge, charged from the tenant's wallet
- **Inspection Fee**: Set per listing by the landlord/agent (₦0 means free), charged from the tenant's wallet when set
- All in-app payments (lock, rent, inspection) are paid from the RentULO wallet. Only wallet top-up and withdrawal go through Flutterwave — RentULO no longer uses Paystack anywhere.

## User Roles
- **Tenant**: Can search, like, lock, book properties; schedule inspections; chat with landlords.
- **Landlord/Agent**: Can list properties, manage listings, respond to inspections and messages.
- **Admin**: Manages platform operations, users, reports.

## Your Personality
- Be warm, professional, and helpful — like a knowledgeable customer service agent.
- Use clear, simple language. Avoid jargon.
- Be proactive: if a user seems confused, guide them step by step.
- Always protect user privacy — never ask for passwords, OTPs, or payment details.
- If you don't know something specific, honestly say so and suggest contacting support@rentulo.ng.

## Response Guidelines
- Keep responses concise but thorough (2-4 sentences typically).
- Use emojis sparingly and naturally (not excessive).
- Format responses for readability.
- Always be respectful and patient.
- If the user is frustrated, acknowledge their frustration and offer solutions.
- For technical issues, suggest practical troubleshooting steps.
- For account issues, guide them to the appropriate self-service options.

## What You CANNOT Do
- Access user accounts, transactions, or personal data.
- Process payments or issue refunds.
- Override platform rules or policies.
- Share other users' information.

## Fallback
For complex issues beyond your knowledge, direct users to:
- Email: support@rentulo.ng
- In-app support (if available)
- FAQ/Help Center on rentulo.ng`;

// ─── POST /ai-support/chat ──────────────────────────────────────────────────
// Send a message and get an AI response. Creates a new session if session_id is not provided.
async function chat(req, res) {
  try {
    const { message, session_id } = req.body;
    const user_id = req.user.userId;

    if (!message || !message.trim()) {
      return res.status(400).json({
        success: false,
        message: 'Message is required',
      });
    }

    // Limit message length
    if (message.length > 2000) {
      return res.status(400).json({
        success: false,
        message: 'Message is too long. Please keep it under 2000 characters.',
      });
    }

    const sessionId = session_id || uuidv4();

    // Save user message
    await AiSupport.create({
      user_id,
      session_id: sessionId,
      role: 'user',
      content: message.trim(),
    });

    // Fetch recent conversation history for context (last 20 messages)
    const history = await AiSupport.findAll({
      where: { user_id, session_id: sessionId },
      order: [['createdAt', 'ASC']],
      limit: 20,
      attributes: ['role', 'content'],
    });

    // Build OpenAI messages array
    const messages = [
      { role: 'system', content: SYSTEM_PROMPT },
      ...history.map((msg) => ({
        role: msg.role,
        content: msg.content,
      })),
    ];

    // Call OpenAI API
    const axios = require('axios');
    const openaiResponse = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: 'gpt-4o-mini',
        messages,
        max_tokens: 800,
        temperature: 0.7,
        top_p: 0.9,
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          'Content-Type': 'application/json',
        },
        timeout: 30000,
      }
    );

    const aiReply =
      openaiResponse.data.choices?.[0]?.message?.content ||
      "I'm sorry, I couldn't generate a response. Please try again.";

    // Save AI response
    await AiSupport.create({
      user_id,
      session_id: sessionId,
      role: 'assistant',
      content: aiReply,
    });

    logger.info('AI Support chat', { user_id, session_id: sessionId });

    return res.status(200).json({
      success: true,
      data: {
        session_id: sessionId,
        reply: aiReply,
      },
    });
  } catch (error) {
    // Handle OpenAI-specific errors gracefully
    if (error.response?.status === 429) {
      return res.status(429).json({
        success: false,
        message: 'AI service is busy. Please try again in a moment.',
      });
    }

    if (error.response?.status === 401) {
      logger.error('AI Support: Invalid OpenAI API key', { error: error.message });
      return res.status(500).json({
        success: false,
        message: 'AI support is temporarily unavailable. Please contact support@rentulo.ng',
      });
    }

    logger.error('AI Support chat error', { error: error.message, user_id: req.user?.userId });
    return res.status(500).json({
      success: false,
      message: 'AI support is temporarily unavailable. Please try again later.',
    });
  }
}

// ─── GET /ai-support/history ────────────────────────────────────────────────
// Get chat history for the current user (optionally filtered by session)
async function getHistory(req, res) {
  try {
    const user_id = req.user.userId;
    const { session_id, limit: queryLimit } = req.query;

    const where = { user_id };
    if (session_id) where.session_id = session_id;

    const limit = Math.min(parseInt(queryLimit, 10) || 50, 200);

    const messages = await AiSupport.findAll({
      where,
      order: [['createdAt', 'ASC']],
      limit,
      attributes: ['id', 'session_id', 'role', 'content', 'createdAt'],
    });

    // If no session_id filter, group by session (show latest messages per session)
    let sessions;
    if (!session_id) {
      const sessionMap = new Map();
      for (const msg of messages) {
        const sid = msg.session_id;
        if (!sessionMap.has(sid)) {
          sessionMap.set(sid, {
            session_id: sid,
            last_message: msg.content,
            last_role: msg.role,
            updated_at: msg.createdAt,
          });
        } else {
          const s = sessionMap.get(sid);
          s.last_message = msg.content;
          s.last_role = msg.role;
          s.updated_at = msg.createdAt;
        }
      }
      sessions = Array.from(sessionMap.values()).sort(
        (a, b) => new Date(b.updated_at) - new Date(a.updated_at)
      );
    }

    return res.status(200).json({
      success: true,
      data: session_id ? messages : sessions || [],
    });
  } catch (error) {
    logger.error('AI Support history error', { error: error.message, user_id: req.user?.userId });
    return res.status(500).json({
      success: false,
      message: 'Failed to retrieve chat history',
    });
  }
}

// ─── DELETE /ai-support/session/:session_id ─────────────────────────────────
// Delete a specific chat session
async function deleteSession(req, res) {
  try {
    const user_id = req.user.userId;
    const { session_id } = req.params;

    const deleted = await AiSupport.destroy({
      where: { user_id, session_id },
    });

    if (deleted === 0) {
      return res.status(404).json({
        success: false,
        message: 'Session not found',
      });
    }

    return res.status(200).json({
      success: true,
      message: 'Chat session deleted successfully',
    });
  } catch (error) {
    logger.error('AI Support delete session error', { error: error.message, user_id: req.user?.userId });
    return res.status(500).json({
      success: false,
      message: 'Failed to delete session',
    });
  }
}

// ─── GET /ai-support/sessions ──────────────────────────────────────────────
// List all chat sessions for the current user
async function getSessions(req, res) {
  try {
    const user_id = req.user.userId;

    // Use raw query to get distinct sessions with counts
    const { sequelize } = require('../models');
    const sessions = await sequelize.query(
      `SELECT
        session_id,
        COUNT(*) as message_count,
        MAX("createdAt") as last_active,
        MIN("createdAt") as created_at
       FROM ai_support
       WHERE user_id = :user_id
       GROUP BY session_id
       ORDER BY last_active DESC
       LIMIT 50`,
      {
        replacements: { user_id },
        type: sequelize.QueryTypes.SELECT,
      }
    );

    return res.status(200).json({
      success: true,
      data: sessions,
    });
  } catch (error) {
    logger.error('AI Support sessions error', { error: error.message, user_id: req.user?.userId });
    return res.status(500).json({
      success: false,
      message: 'Failed to retrieve sessions',
    });
  }
}

module.exports = { chat, getHistory, deleteSession, getSessions };
