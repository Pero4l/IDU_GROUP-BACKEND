const { Waitlist } = require('../models');
const { sendEmail } = require('../utils/mailer');

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
    
    const html = `
      <div style="font-family: 'Inter', 'Helvetica Neue', Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 40px 20px; background-color: #ffffff; border: 1px solid #f0f0f0; border-radius: 12px; box-shadow: 0 4px 12px rgba(0, 0, 0, 0.05);">
        <div style="text-align: center; margin-bottom: 30px;">
          <h1 style="color: #4F46E5; margin: 0; font-size: 28px; font-weight: 800; letter-spacing: -0.5px;">RentULO</h1>
          <p style="color: #6B7280; margin: 5px 0 0 0; font-size: 14px;">Smart & Seamless Property Rentals</p>
        </div>
        
        <div style="border-top: 3px solid #4F46E5; padding-top: 30px;">
          <h2 style="color: #1F2937; margin-top: 0; font-size: 20px; font-weight: 700;">Welcome to the Waitlist! 🎉</h2>
          <p style="color: #4B5563; font-size: 16px; line-height: 1.6;">Hello,</p>
          <p style="color: #4B5563; font-size: 16px; line-height: 1.6;">Thank you for signing up for the RentULO waitlist! We are absolutely thrilled to have you on board with us.</p>
          <p style="color: #4B5563; font-size: 16px; line-height: 1.6;">RentULO is building the future of property rentals, making finding, renting, and managing apartments simple, secure, and stress-free. By securing your spot on the waitlist, you've unlocked:</p>
          
          <ul style="color: #4B5563; font-size: 15px; line-height: 1.6; padding-left: 20px;">
            <li style="margin-bottom: 10px;"><strong>First Priority Access:</strong> Be the first to try out our platform at launch.</li>
            <li style="margin-bottom: 10px;"><strong>Exclusive Offers:</strong> Special discount rates on locking and booking your next dream home.</li>
            <li style="margin-bottom: 10px;"><strong>Community Updates:</strong> Behind-the-scenes updates on our progress and sneak peeks at upcoming features.</li>
          </ul>

          <div style="text-align: center; margin: 35px 0;">
            <span style="background-color: #4F46E5; color: #ffffff; padding: 12px 30px; border-radius: 8px; font-weight: 600; font-size: 16px; display: inline-block; box-shadow: 0 4px 6px rgba(79, 70, 229, 0.15);">Spot Secured Successfully</span>
          </div>

          <p style="color: #4B5563; font-size: 15px; line-height: 1.6; margin-bottom: 30px;">We're working hard to prepare RentULO for launch, and we'll keep you updated along the way. In the meantime, if you have any questions, feedback, or suggestions, feel free to reply directly to this email.</p>
          
          <p style="color: #4B5563; font-size: 15px; line-height: 1.6; margin-bottom: 0;">Warm regards,<br><strong style="color: #1F2937;">The RentULO Team</strong></p>
        </div>

        <hr style="border: 0; border-top: 1px solid #E5E7EB; margin: 30px 0;" />
        
        <p style="font-size: 12px; color: #9CA3AF; text-align: center; line-height: 1.4; margin: 0;">
          You received this email because you signed up for the RentULO waitlist.<br />
          &copy; 2026 RentULO. All rights reserved.
        </p>
      </div>
    `;

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
