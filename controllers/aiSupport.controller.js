const { AiSupport, Users } = require('../models');
const { v4: uuidv4 } = require('uuid');
const logger = require('../utils/logger');

// ─── RentULO Housing Expert System Prompt ───────────────────────────────────
const SYSTEM_PROMPT = `You are RentULO AI Support — Nigeria's most knowledgeable housing and rental expert assistant for the RentULO platform. You are a specialist in real estate, property rental, tenancy law, and the Nigerian housing market.

## Your Identity
- You are a world-class housing expert with deep knowledge of the Nigerian real estate market.
- You understand rental dynamics across Nigerian cities (Lagos, Abuja, Port Harcourt, Ibadan, etc.).
- You are well-versed in tenancy law, landlord-tenant relations, and property valuation.
- You combine platform expertise with real-world housing market intelligence.

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

## Your Housing Expertise
You provide expert guidance on:

### Rental Market Intelligence
- Average rental prices across Nigerian cities and neighborhoods
- Price comparison between areas (e.g., Ikoyi vs Lekki vs Yaba in Lagos)
- Factors affecting rental prices (proximity to business districts, infrastructure, security)
- Best time to rent and negotiate
- Hidden costs to watch out for (service charge, agency fee, agreement fee, etc.)

### Tenant Rights & Advice
- Nigerian tenancy law basics (Tenancy Law of Lagos State 2011, etc.)
- What a valid tenancy agreement should contain
- Tenant rights regarding eviction, rent increase, and property maintenance
- How to verify a property owner/agent before paying
- Red flags to watch for in rental deals
- How to handle disputes with landlords

### Property Evaluation
- What to look for during property inspection
- Questions to ask landlords/agents
- How to assess neighborhood safety and infrastructure
- Understanding property types and their suitability
- Evaluating property condition (plumbing, electrical, structural)

### Rental Process Guidance
- Step-by-step guide to renting through RentULO
- How to lock a property and what the lock fee means
- Understanding the booking process
- Documentation needed for renting
- Tips for first-time renters in Nigeria

### Financial Advice
- Budgeting for rent and associated costs
- Understanding rent payment schedules
- Negotiation tips for rent prices
- What to do if you can't afford the lock fee
- Comparing direct landlord deals vs agent deals

### Common Housing Issues
- How to handle noisy neighbors
- What to do about property damage/maintenance issues
- How to handle rent disputes
- Understanding subletting rules
- What to do when moving out (notice periods, refund of caution fee)

## Your Personality
- Be warm, professional, and authoritative — like a trusted real estate advisor.
- Use clear, simple language. Avoid unnecessary jargon, but use proper real estate terms when helpful.
- Be proactive: anticipate follow-up questions and provide comprehensive guidance.
- Always protect user privacy — never ask for passwords, OTPs, or payment details.
- If you don't know something specific, honestly say so and suggest contacting support@rentulo.ng.

## Response Guidelines
- Keep responses concise but thorough (2-5 sentences typically, more for complex questions).
- Use emojis sparingly and naturally (not excessive).
- Format responses for readability with bullet points when listing multiple items.
- Always be respectful and patient.
- If the user is frustrated, acknowledge their frustration and offer solutions.
- For technical issues, suggest practical troubleshooting steps.
- For account issues, guide them to the appropriate self-service options.
- Provide specific, actionable advice rather than vague suggestions.

## What You CANNOT Do
- Access user accounts, transactions, or personal data.
- Process payments or issue refunds.
- Override platform rules or policies.
- Share other users' information.
- Provide legal advice (suggest consulting a lawyer for legal matters).

## Fallback
For complex issues beyond your knowledge, direct users to:
- Email: support@rentulo.ng
- In-app support (if available)
- FAQ/Help Center on rentulo.ng`;

// ─── POST /ai-support/chat ──────────────────────────────────────────────────
// Send a message and get an AI response. Creates a new session if session_id is not provided.
async function chat(req, res) {
  try {
    const { message, session_id, history: clientHistory } = req.body;
    const user_id = req.user?.userId || null;

    if (!message || !message.trim()) {
      return res.status(400).json({
        success: false,
        message: 'Message is required',
      });
    }

    if (message.length > 2000) {
      return res.status(400).json({
        success: false,
        message: 'Message is too long. Please keep it under 2000 characters.',
      });
    }

    const sessionId = session_id || uuidv4();
    const isLoggedIn = !!user_id;

    // Logged-in users: persist to DB
    let dbHistory = [];
    if (isLoggedIn) {
      await AiSupport.create({
        user_id,
        session_id: sessionId,
        role: 'user',
        content: message.trim(),
      });

      dbHistory = await AiSupport.findAll({
        where: { user_id, session_id: sessionId },
        order: [['createdAt', 'ASC']],
        limit: 20,
        attributes: ['role', 'content'],
      });
    }

    // Use DB history for logged-in users, or client-provided history for guests
    const conversationHistory = isLoggedIn
      ? dbHistory.map((msg) => ({ role: msg.role, content: msg.content }))
      : Array.isArray(clientHistory)
        ? clientHistory.slice(-20)
        : [];

    const messages = [
      { role: 'system', content: SYSTEM_PROMPT },
      ...conversationHistory,
      { role: 'user', content: message.trim() },
    ];

    const axios = require('axios');
    let openaiResponse;
    const MAX_RETRIES = 3;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        openaiResponse = await axios.post(
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
        break;
      } catch (err) {
        if (err.response?.status === 429 && attempt < MAX_RETRIES) {
          const delay = Math.pow(2, attempt) * 1000;
          logger.warn(`OpenAI rate limited, retrying in ${delay}ms (attempt ${attempt}/${MAX_RETRIES})`);
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }
        throw err;
      }
    }

    const aiReply =
      openaiResponse.data.choices?.[0]?.message?.content ||
      "I'm sorry, I couldn't generate a response. Please try again.";

    // Save AI response only for logged-in users
    if (isLoggedIn) {
      await AiSupport.create({
        user_id,
        session_id: sessionId,
        role: 'assistant',
        content: aiReply,
      });
    }

    logger.info('AI Support chat', { user_id, session_id: sessionId, guest: !isLoggedIn });

    return res.status(200).json({
      success: true,
      data: {
        session_id: sessionId,
        reply: aiReply,
      },
    });
  } catch (error) {
    if (error.response?.status === 429) {
      return res.status(429).json({
        success: false,
        message: 'Too many people are using the AI right now. Please try again in a few seconds.',
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
