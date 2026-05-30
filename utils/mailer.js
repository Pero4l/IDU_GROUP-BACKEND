const nodemailer = require("nodemailer");
const axios = require("axios");
require("dotenv").config();

let testAccount = null;



async function getTransporter() {
  if (process.env.EMAIL_USER && process.env.EMAIL_PASS) {
    return nodemailer.createTransport({
      host: process.env.EMAIL_HOST || 'smtp.gmail.com',
      port: process.env.EMAIL_PORT ? parseInt(process.env.EMAIL_PORT) : 587,
      secure: process.env.EMAIL_PORT == '465' ? true : false,
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS,
      },
      family: 4, // Force IPv4 to avoid ENETUNREACH on Render
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 10000,
    });
  }
  
  if (!testAccount) {
    testAccount = await nodemailer.createTestAccount();
  }
  
  return nodemailer.createTransport({
    host: "smtp.ethereal.email",
    port: 587,
    secure: false,
    auth: {
      user: testAccount.user,
      pass: testAccount.pass,
    },
    family: 4,
  });
}

async function sendEmail(to, subject, text, html) {
  // HYBRID MODE: If RESEND_API_KEY is defined, send via HTTP API (Bypasses Render's Free Tier SMTP blocks)
  if (process.env.RESEND_API_KEY) {
    try {
      console.log(`Using Resend API to send email to ${to}...`);
      // Resend sandbox only allows sending from onboarding@resend.dev by default
      const fromAddress = process.env.EMAIL_USER && !process.env.EMAIL_USER.includes('gmail')
        ? `RentULO Team <${process.env.EMAIL_USER}>` 
        : 'RentULO Team <onboarding@resend.dev>';

      const response = await axios.post(
        'https://api.resend.com/emails',
        {
          from: fromAddress,
          to: [to],
          subject: subject,
          text: text,
          html: html || `<p>${text}</p>`,
        },
        {
          headers: {
            'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
            'Content-Type': 'application/json',
          },
        }
      );
      console.log("Email sent successfully via Resend API:", response.data.id);
      return null;
    } catch (error) {
      console.error("Failed to send email via Resend API:", error.response ? error.response.data : error.message);
      throw error;
    }
  }

  // FALLBACK MODE: Use standard SMTP (For local development or when paid Render is used)
  try {
    const mailer = await getTransporter();
    const fromAddress = process.env.EMAIL_USER 
      ? `"RentULO Team" <${process.env.EMAIL_USER}>` 
      : '"RentULO Team" <no-reply@rentulo.com>';

    const mailOptions = {
      from: fromAddress,
      to,
      subject,
      text,
      html: html || `<p>${text}</p>`,
    };
    const info = await mailer.sendMail(mailOptions);
    console.log(`Email sent to ${to} via SMTP: %s`, info.messageId);
    
    // For test ethereal accounts, log preview url
    const previewUrl = nodemailer.getTestMessageUrl(info);
    if (previewUrl) {
      console.log("Email Preview URL: %s", previewUrl);
    }
    return previewUrl || null;
  } catch (error) {
    console.error("Failed to send email via SMTP:", error);
    throw error;
  }
}

module.exports = { sendEmail };

