const nodemailer = require("nodemailer");
require("dotenv").config();

let testAccount = null;

async function getTransporter() {
  if (process.env.EMAIL_USER && process.env.EMAIL_PASS) {
    return nodemailer.createTransport({
      service: process.env.EMAIL_HOST && process.env.EMAIL_HOST.includes('gmail') ? 'gmail' : undefined,
      host: process.env.EMAIL_HOST || 'smtp.ethereal.email',
      port: process.env.EMAIL_PORT ? parseInt(process.env.EMAIL_PORT) : 587,
      secure: process.env.EMAIL_PORT == '465' ? true : false,
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS,
      }
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
  });
}

async function sendEmail(to, subject, text, html) {
  try {
    const mailer = await getTransporter();
    const mailOptions = {
      from: '"RentULO Team" <no-reply@rentulo.com>',
      to,
      subject,
      text,
      html: html || `<p>${text}</p>`,
    };
    const info = await mailer.sendMail(mailOptions);
    console.log(`Email sent to ${to}: %s`, info.messageId);
    
    // For test ethereal accounts, log preview url
    const previewUrl = nodemailer.getTestMessageUrl(info);
    if (previewUrl) {
      console.log("Email Preview URL: %s", previewUrl);
    }
  } catch (error) {
    console.error("Failed to send email:", error);
  }
}

module.exports = { sendEmail };
