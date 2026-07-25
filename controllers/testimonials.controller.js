const { Testimonials, Users, Profile } = require("../models");
const { sendEmail } = require("../utils/mailer");
const { buildEmailShell, buildActionButton } = require("../utils/emailTemplates");

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
        message: "You already have a testimonial. Please update it instead",
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

    const userName = (user.full_name || "").trim() || "there";
    const testimonial = await Testimonials.create({
      user_id: userId,
      user_name: userName,
      user_image: user.Profile?.image || null,
      rating,
      message,
    });

    // SEND CONFIRMATION EMAIL
    try {
      const stars = "⭐".repeat(rating);
      const emailHtml = buildEmailShell({
        eyebrow: 'Testimonial received',
        heading: `Thanks for your testimonial, ${userName}!`,
        bodyHtml: `
          <p style="margin:0;">We appreciate you taking the time to share your experience with RentULO. Here's what you submitted:</p>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e8eaed;border-radius:4px;margin:20px 0;">
            <tr><td style="padding:16px;">
              <p style="margin:0 0 8px;color:#202124;font-size:15px;">${stars}</p>
              <p style="margin:0;color:#3c4043;font-size:14px;font-style:italic;">"${message}"</p>
            </td></tr>
          </table>
          <p style="margin:0 0 12px;">Your testimonial may be featured on our platform to help other users make informed decisions.</p>
          <p style="margin:0;">Want to make changes? You can update or delete your testimonial anytime from your dashboard.</p>
          ${buildActionButton('Go to Dashboard', 'https://rentulo.com/dashboard')}
        `,
      });

      const emailText = `Hi ${userName},\n\nThank you for submitting your testimonial on RentULO!\n\nYour rating: ${rating}/5\nYour message: "${message}"\n\nYou can update or delete your testimonial anytime from your dashboard.\n\nBest regards,\nThe RentULO Team`;

      await sendEmail(
        user.email,
        "Thanks for your Testimonial 🌟",
        emailText,
        emailHtml,
      );
    } catch (mailError) {
      console.error("Failed to send testimonial confirmation email", mailError);
    }

    return res.status(201).json({
      success: true,
      message: "Testimonial created successfully",
      data: testimonial,
    });
  } catch (error) {
    console.error("createTestimonial error:", error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
}

// UPDATE TESTIMONIALS
async function updateTestimonial(req, res) {
  try {
    const userId = req.user.userId;
    const { rating, message } = req.body;

    if (!rating && !message) {
      return res.status(400).json({
        success: false,
        message: "Provide at least one field to update",
      });
    }

    if (rating && (rating < 1 || rating > 5)) {
      return res
        .status(400)
        .json({ success: false, message: "Rating must be between 1 and 5" });
    }

    if (message && message.length < 10) {
      return res.status(400).json({
        success: false,
        message: "Message must be at least 10 characters",
      });
    }

    const testimonial = await Testimonials.findOne({
      where: { user_id: userId },
    });
    if (!testimonial) {
      return res
        .status(404)
        .json({ success: false, message: "Testimonial not found" });
    }

    // ✅ user defined here before it's used anywhere
    const user = await Users.findOne({ where: { id: userId } });
    if (!user) {
      return res
        .status(404)
        .json({ success: false, message: "User not found" });
    }
    const userName = (user.full_name || "").trim() || "there";

    if (rating) testimonial.rating = rating;
    if (message) testimonial.message = message;
    testimonial.user_name = user.full_name || '';
    await testimonial.save();

    // SEND UPDATE EMAIL
    try {
      const stars = "⭐".repeat(testimonial.rating);

      const emailHtml = buildEmailShell({
        eyebrow: 'Testimonial updated',
        heading: 'Your testimonial has been updated',
        bodyHtml: `
          <p style="margin:0;">Hi ${userName}, your testimonial on RentULO has been successfully updated. Here's what it looks like now:</p>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e8eaed;border-radius:4px;margin:20px 0;">
            <tr><td style="padding:16px;">
              <p style="margin:0 0 8px;color:#202124;font-size:15px;">${stars}</p>
              <p style="margin:0;color:#3c4043;font-size:14px;font-style:italic;">"${testimonial.message}"</p>
            </td></tr>
          </table>
          <p style="margin:0;">If you did not make this change, please contact our support team immediately.</p>
          ${buildActionButton('Go to Dashboard', 'https://rentulo.com/dashboard')}
        `,
      });

      const emailText = `Hi ${userName},\n\nYour testimonial has been successfully updated.\n\nYour rating: ${testimonial.rating}/5\nYour message: "${testimonial.message}"\n\nIf you did not make this change, please contact support.\n\nBest regards,\nThe RentULO Team`;
      await sendEmail(
        user.email,
        "Your Testimonial Has Been Updated ✏️",
        emailText,
        emailHtml,
      );
    } catch (mailError) {
      console.error("Failed to send testimonial update email:", mailError);
    }

    return res.status(200).json({
      success: true,
      message: "Testimonial updated successfully",
      data: testimonial,
    });
  } catch (error) {
    console.error("updateTestimonial error:", error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
}

// DELETE TESTIMONIALS
async function deleteTestimonial(req, res) {
  try {
    const userId = req.user.userId;

    const testimonial = await Testimonials.findOne({
      where: { user_id: userId },
    });
    if (!testimonial) {
      return res.status(404).json({
        success: false,
        message: "Testimonial not found",
      });
    }

    // GET USER BEFORE DELETING
    const user = await Users.findOne({ where: { id: userId } });
    const userName = (user.full_name || "").trim() || "there";

    await testimonial.destroy();

    // SEND DELETE EMAIL
    try {
      const emailHtml = buildEmailShell({
        eyebrow: 'Testimonial deleted',
        heading: 'Your testimonial has been deleted',
        bodyHtml: `
          <p style="margin:0 0 12px;">Hi ${userName}, your testimonial on RentULO has been successfully deleted.</p>
          <p style="margin:0 0 12px;">If you change your mind, you can always submit a new testimonial from your dashboard anytime.</p>
          <p style="margin:0;">If you did not request this deletion, please contact our support team immediately.</p>
          ${buildActionButton('Go to Dashboard', 'https://rentulo.com/dashboard')}
        `,
      });

      const emailText = `Hi ${userName},\n\nYour testimonial on RentULO has been successfully deleted.\n\nIf you did not request this, please contact support immediately.\n\nBest regards,\nThe RentULO Team`;

      await sendEmail(
        user.email,
        "Your Testimonial Has Been Deleted 🗑️",
        emailText,
        emailHtml,
      );
    } catch (mailError) {
      console.error("Failed to send testimonial delete email:", mailError);
    }

    return res.status(200).json({
      success: true,
      message: "Testimonial deleted successfully",
    });
  } catch (error) {
    console.error("deleteTestimonial error:", error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
}

// GET ALL TESTIMONIALS
async function getAllTestimonials(req, res) {
  try {
    const testimonials = await Testimonials.findAll({
      order: [["createdAt", "DESC"]],
    });

    return res.status(200).json({
      success: true,
      message: "Testimonial fetched successfully",
      data: testimonials,
    });
  } catch (error) {
    console.error("getAllTestimonial error:", error);
    return res.status(500).json({
      success: false,
      message: "Server error",
    });
  }
}

// GET logged-in user's testimonials
async function getMyTestimonial(req, res) {
  try {
    const userId = req.user.userId;

    const testimonial = await Testimonials.findOne({
      where: { user_id: userId },
    });
    if (!testimonial) {
      return res.status(404).json({
        success: false,
        message: "You have not submitted a testimonial yet",
      });
    }

    return res.status(200).json({
      success: true,
      message: "Testimonial fetched successfully",
      data: testimonial,
    });
  } catch (error) {
    console.error("getMytestimonial:", error);
    return res.status(500).json({
      success: false,
      message: "Server error",
    });
  }
}

module.exports = {
  createTestimonial,
  updateTestimonial,
  deleteTestimonial,
  getAllTestimonials,
  getMyTestimonial,
};
