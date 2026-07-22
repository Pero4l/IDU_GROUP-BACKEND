const { Subscriptions, Users } = require("../models");
const { sendEmail } = require("../utils/mailer");
const { buildEmailShell } = require("../utils/emailTemplates");

// SUBSCRIBE

async function subscribe(req, res) {
  try {
    const userId = req.user.userId;

    const user = await Users.findOne({ where: { id: userId } });

    if (!user) {
      return res
        .status(404)
        .json({ success: false, message: "User not found" });
    }

    const existing = await Subscriptions.findOne({
      where: { user_id: userId },
    });
    if (existing) {
      return res
        .status(400)
        .json({ success: false, message: "You are already a subscriber" });
    }

    const subscription = await Subscriptions.create({
      user_id: userId,
      email: user.email,
    });

    // SEND CONFIRMATION EMAIL
    try {
      const userName = user.full_name || "there";

      const emailHtml = buildEmailShell({
        eyebrow: 'Subscription confirmed',
        heading: "You're subscribed!",
        bodyHtml: `
          <p style="margin:0;">Hi ${userName}, thanks for subscribing to RentULO updates. You'll now receive news, listings, and offers straight to your inbox.</p>
        `,
      });
      const emailText = `Hi ${userName},\n\nThanks for subscribing to RentULO updates!\n\nBest regards,\nThe RentULO Team`;

      await sendEmail(
        user.email,
        "Welcome to RentULO Updates 🎉",
        emailText,
        emailHtml,
      );
    } catch (mailError) {
      console.error("Failed to send subscription email:", mailError);
    }

    return res.status(201).json({
      success: true,
      message: "Subscribed successfully",
      data: subscription,
    });
  } catch (error) {
    console.error("subscribe error:", error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
}

module.exports = { subscribe };
