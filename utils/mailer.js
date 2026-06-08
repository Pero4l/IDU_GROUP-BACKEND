const nodemailer = require("nodemailer");
const logger = require("./logger");
require("dotenv").config();

let testAccount = null;

async function getTransporter() {
  if (process.env.EMAIL_USER && process.env.EMAIL_PASS) {
    return nodemailer.createTransport({
      service: process.env.EMAIL_HOST?.includes('gmail') ? 'gmail' : undefined,
      host: process.env.EMAIL_HOST || 'smtp.ethereal.email',
      port: process.env.EMAIL_PORT ? parseInt(process.env.EMAIL_PORT) : 587,
      secure: process.env.EMAIL_PORT == '465',
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS,
      },
      family: 4,             // Force IPv4 — avoids ENETUNREACH on Render
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 10000,
    });
  }

  // Fall back to a free Ethereal test account in dev/staging
  if (!testAccount) {
    testAccount = await nodemailer.createTestAccount();
  }
  return nodemailer.createTransport({
    host: "smtp.ethereal.email",
    port: 587,
    secure: false,
    auth: { user: testAccount.user, pass: testAccount.pass },
  });
}

/**
 * Sends an email. Never throws — a mail failure must never crash or roll back
 * the caller's business logic. Errors are logged for visibility.
 *
 * @param {string} to
 * @param {string} subject
 * @param {string} text      - Plain-text fallback
 * @param {string} [html]    - HTML body (optional)
 */
async function sendEmail(to, subject, text, html) {
  try {
    const mailer = await getTransporter();
    const info = await mailer.sendMail({
      from: '"RentULO Team" <no-reply@rentulo.com>',
      to,
      subject,
      text,
      html: html || `<p>${text}</p>`,
    });

    logger.info('Email sent', { to, subject, messageId: info.messageId });

    const previewUrl = nodemailer.getTestMessageUrl(info);
    if (previewUrl) logger.info('Email preview (Ethereal)', { previewUrl });

  } catch (error) {
    // Log and swallow — email is a side-effect, never a blocker
    logger.error('Failed to send email (non-critical)', { to, subject, error: error.message });
  }
}

module.exports = { sendEmail };
