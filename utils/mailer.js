const nodemailer = require("nodemailer");
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
    console.log(`Email sent to ${to}: %s`, info.messageId);
    
    // For test ethereal accounts, log preview url
    const previewUrl = nodemailer.getTestMessageUrl(info);
    if (previewUrl) {
      console.log("Email Preview URL: %s", previewUrl);
    }
    return previewUrl || null;
  } catch (error) {
    console.error("Failed to send email:", error);
    throw error;
  }
}

module.exports = { sendEmail };

