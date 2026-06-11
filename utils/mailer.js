const nodemailer = require("nodemailer");
const logger = require("./logger");
const axios = require("axios");
const dnsPromises = require("dns").promises;
require("dotenv").config();

let testAccount = null;

async function getTransporter() {
  if (process.env.EMAIL_USER && process.env.EMAIL_PASS) {
    const originalHost = process.env.EMAIL_HOST || 'smtp.gmail.com';
    let host = originalHost;
    const port = process.env.EMAIL_PORT ? parseInt(process.env.EMAIL_PORT) : 587;

    // Dynamically resolve ANY host (gmail, brevo, etc.) to an IPv4 address to guarantee IPv6 is bypassed!
    try {
      const addresses = await dnsPromises.resolve4(originalHost);
      if (addresses && addresses.length > 0) {
        host = addresses[0];
        console.log(`[EMAIL HELPER] Resolved ${originalHost} to IPv4: ${host}`);
      }
    } catch (dnsErr) {
      console.error(`[EMAIL HELPER] Failed to resolve ${originalHost} to IPv4, falling back to hostname:`, dnsErr);
    }

    return nodemailer.createTransport({
      host: host,
      port: port,
      secure: port === 465,
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS,
      },
      family: 4,             // Force IPv4 — avoids ENETUNREACH on Render
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 10000,
      tls: {
        servername: originalHost
      }
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
    auth: {
      user: testAccount.user,
      pass: testAccount.pass,
    },
    family: 4,
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
  // 1. BREVO HTTP API (Uses Port 443 HTTPS - 100% immune to Render's SMTP port blocks)
  if (process.env.BREVO_API_KEY) {
    try {
      console.log(`[EMAIL HELPER] Initiating Brevo HTTPS API delivery to ${to}...`);
      const emailUser = process.env.EMAIL_USER || "no-reply@rentulo.com";
      
      const response = await axios.post(
        "https://api.brevo.com/v3/smtp/email",
        {
          sender: { name: "RentULO Team", email: emailUser },
          to: [{ email: to }],
          subject: subject,
          htmlContent: html || `<p>${text}</p>`,
          textContent: text || ""
        },
        {
          headers: {
            "api-key": process.env.BREVO_API_KEY,
            "Content-Type": "application/json"
          }
        }
      );

      if (response.status >= 200 && response.status < 300) {
        console.log(`[EMAIL HELPER] Email sent successfully via Brevo HTTPS API! Message ID: ${response.data.messageId}`);
        return null;
      } else {
        console.error("[EMAIL HELPER] Brevo HTTPS API rejection:", response.data);
        throw new Error(response.data.message || "Failed via Brevo API");
      }
    } catch (apiErr) {
      console.error("[EMAIL HELPER] Brevo HTTPS API failed, falling back to SMTP:", apiErr.response ? apiErr.response.data : apiErr.message);
    }
  }

  // 2. SMTP FALLBACK (Gmail SMTP, Brevo SMTP or Ethereal local test account)
  try {
    const mailer = await getTransporter();
    const emailUser = process.env.EMAIL_USER || "no-reply@rentulo.com";
    const fromAddress = `"RentULO Team" <${emailUser}>`;

    const mailOptions = {
      from: fromAddress,
      to,
      subject,
      text: text || "",
      html: html || `<p>${text}</p>`,
    };

    const info = await mailer.sendMail(mailOptions);
    console.log(`[EMAIL HELPER] Email sent successfully to ${to} via SMTP: ${info.messageId}`);
    
    // For test ethereal accounts, log preview url
    const previewUrl = nodemailer.getTestMessageUrl(info);
    if (previewUrl) {
      console.log(`[EMAIL HELPER] Ethereal Sandboxed Mail Preview URL: ${previewUrl}`);
    }
    return previewUrl || null;
  } catch (error) {
    console.error("[EMAIL HELPER] Standard SMTP connection delivery failed:", error);
    return null;
  }
}

module.exports = { sendEmail };


