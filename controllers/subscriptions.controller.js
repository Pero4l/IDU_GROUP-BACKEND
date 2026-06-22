const { Subscriptions, Users } = require("../models");
const { sendEmail } = require("../utils/mailer");

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

      const emailHtml = `
    <div style="font-family: Arial, sans-serif; background-color: #f9fafb; padding: 20px;">
      <div style="max-width: 600px; margin: auto; background: #ffffff; border-radius: 10px; padding: 30px; box-shadow: 0 4px 10px rgba(0,0,0,0.05);">
        <h2 style="color: #111827;">You're subscribed! 🎉</h2>
        <p style="color: #4b5563; font-size: 15px; line-height: 1.6;">
          Hi ${userName}, thanks for subscribing to RentULO updates. You'll now receive news, listings, and offers straight to your inbox.
        </p>
        <hr style="margin: 30px 0; border: none; border-top: 1px solid #e5e7eb;" />
        <p style="color: #9ca3af; font-size: 12px; text-align: center;">
          © ${new Date().getFullYear()} RentULO. All rights reserved.
        </p>
      </div>
    </div>
  `;
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
