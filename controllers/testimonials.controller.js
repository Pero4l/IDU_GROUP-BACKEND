const { Testimonials, Users, Profile } = require("../models");
const { sendEmail } = require('../utils/mailer')

// CREATE testimonials
async function createTestimonial(req, res) {
  try {
    const userId = req.user.userId;
    const { rating, message } = req.body;

    if (!rating || !message) {
      return res
        .status(400)
        .json({ success: false, message: "Rating and message are required" });
    }

    if (rating && (rating < 1 || rating > 5)) {
      return res
        .status(400)
        .json({ success: false, message: "Rating must be between 1 and 5" });
    }

    if (message.length < 10) {
      return res.status(400).json({
        success: false,
        message: "Message must be at least 10 characters",
      });
    }

    //  Check if user already has atestimonial
    const existing = await Testimonials.findOne({ where: { user_id: userId } });
    if (existing) {
      return res.status(400).json({
        success: false,
        message: "You already have a testimonial. Please udate it instead",
      });
    }

    // Get user details
    const user = await Users.findOne({
      where: { id: userId },
      include: [{ model: Profile, attributes: ["image"] }],
    });

    if (!user) {
      return res
        .status(404)
        .json({ success: false, message: "User not found" });
    }

    const testimonials = await Testimonials.create({
      user_id: userId,
      user_name: `${user.first_name} ${user.last_name}`,
      user_image: user.Profile?.image || null,
      rating,
      message,
    });

    // SEND CONFIRMATION EMAIL
    try {
       const stars = "⭐".repeat(rating);
       const emailHtml = `<div style="font-family: Arial, sans-serif; background-color: #f9fafb; padding: 20px;">
          <div style="max-width: 600px; margin: auto; background: #ffffff; border-radius: 10px; padding: 30px; box-shadow: 0 4px 10px rgba(0,0,0,0.05);">
            
            <h2 style="color: #111827;">Thanks for your testimonial, ${user.first_name}! 🎉</h2>
            
            <p style="color: #4b5563; font-size: 15px; line-height: 1.6;">
              We appreciate you taking the time to share your experience with RentULO. Here's what you submitted:
            </p>

            <div style="background-color: #f3f4f6; border-radius: 8px; padding: 20px; margin: 20px 0;">
              <p style="color: #111827; font-size: 16px; margin: 0 0 10px 0;">${stars}</p>
              <p style="color: #374151; font-size: 15px; font-style: italic; margin: 0;">"${message}"</p>
            </div>

            <p style="color: #4b5563; font-size: 14px; line-height: 1.6;">
              Your testimonial may be featured on our platform to help other users make informed decisions.
            </p>

            <p style="color: #4b5563; font-size: 14px;">
              Want to make changes? You can update or delete your testimonial anytime from your dashboard.
            </p>

            <div style="text-align: center; margin: 30px 0;">
              <a href="https://rentulo.com/dashboard" 
                style="background-color: #111827; color: #ffffff; padding: 12px 20px; text-decoration: none; border-radius: 6px; font-size: 14px;">
                Go to Dashboard
              </a>
            </div>

            <hr style="margin: 30px 0; border: none; border-top: 1px solid #e5e7eb;" />

            <p style="color: #9ca3af; font-size: 12px; text-align: center;">
              © ${new Date().getFullYear()} RentULO. All rights reserved.
            </p>

          </div>
        </div>`;

        const emailText = `Hi ${user.first_name},\n\nThank you for submitting your testimonial on RentULO!\n\nYour rating: ${rating}/5\nYour message: "${message}"\n\nYou can update or delete your testimonial anytime from your dashboard.\n\nBest regards,\nThe RentULO Team`;

        await sendEmail(user.email, 'Thanks for your Testimonilas 🌟', emailText, emailHtml)
    } catch (mailError) {
      console.error('Failed to send testimonial confirmation email', mailError)
    }

    return res.status(200).json({
      success: true,
      message: "Testimonial created successfully",
      data: testimonial,
    });
  } catch (error) {
    console.error("createTestimonial error:", error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
}
