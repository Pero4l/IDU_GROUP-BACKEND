const { Waitlist } = require('../models');
const { sendEmail } = require('../utils/mailer');
const { buildEmailShell } = require('../utils/emailTemplates');

async function addToWaitlist(req, res) {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ success: false, message: "Email is required" });
    }

    const trimmedEmail = email.trim().toLowerCase();

    // Basic email regex check
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(trimmedEmail)) {
      return res.status(400).json({ success: false, message: "Invalid email format" });
    }

    // Check if email already exists
    const existing = await Waitlist.findOne({ where: { email: trimmedEmail } });
    if (existing) {
      return res.status(400).json({ success: false, message: "This email is already registered on our waitlist" });
    }

    // Create entry
    const entry = await Waitlist.create({ email: trimmedEmail });

    // Send confirmation email
    const subject = "You're on the RentULO Waitlist!";
    const text = `Hello,\n\nThank you for joining the RentULO waitlist! We are thrilled to have you with us.\n\nWe will let you know as soon as we launch and share exciting updates and exclusive early-access perks with you.\n\nBest regards,\nThe RentULO Team`;
    
    const html = buildEmailShell({
      eyebrow: 'Waitlist confirmed',
      heading: "You're on the waitlist!",
      bodyHtml: `
        <p style="margin:0 0 12px;">Hello,</p>
        <p style="margin:0 0 12px;">Thank you for signing up for the RentULO waitlist! We're absolutely thrilled to have you on board.</p>
        <p style="margin:0 0 16px;">RentULO is building the future of property rentals — making finding, renting, and managing apartments simple, secure, and stress-free. By securing your spot on the waitlist, you've unlocked:</p>
        <ul style="margin:0 0 16px;padding-left:20px;">
          <li style="margin-bottom:8px;"><strong>First priority access</strong> — be the first to try the platform at launch.</li>
          <li style="margin-bottom:8px;"><strong>Exclusive offers</strong> — special discount rates on locking and booking your next home.</li>
          <li style="margin-bottom:0;"><strong>Community updates</strong> — behind-the-scenes progress and sneak peeks at upcoming features.</li>
        </ul>
        <p style="margin:0 0 16px;">We're working hard to prepare for launch and will keep you updated along the way. If you have any questions, feedback, or suggestions, feel free to reply directly to this email.</p>
        <p style="margin:0;">Warm regards,<br><strong style="color:#202124;">The RentULO Team</strong></p>
      `,
      footerNote: 'You received this email because you signed up for the RentULO waitlist.',
    });

    try {
      await sendEmail(trimmedEmail, subject, text, html);
    } catch (mailError) {
      console.error("Waitlist signup confirmation email failed to send:", mailError);
    }

    return res.status(201).json({
      success: true,
      message: "Successfully joined the waitlist! A confirmation email has been sent.",
      data: {
        id: entry.id,
        email: entry.email,
        createdAt: entry.createdAt
      }
    });
  } catch (error) {
    console.error("Waitlist Controller Error:", error);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

module.exports = {
  addToWaitlist
};
