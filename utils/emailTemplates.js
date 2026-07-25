// Shared building blocks for all RentULO transactional emails.
//
// Style: flat and edge-to-edge like Google's own account/security emails —
// no outer gray backdrop, no floating card, no shadows/heavy radii. Content
// sits directly on a white background with thin hairline dividers.

const BRAND_NAME = 'RentULO';
const BRAND_COLOR = '#059669';
const TEXT_PRIMARY = '#202124';
const TEXT_SECONDARY = '#3c4043';
const TEXT_MUTED = '#5f6368';
const TEXT_FAINT = '#9aa0a6';
const BORDER_COLOR = '#e8eaed';
const SURFACE = '#f8f9fa';
const FONT_STACK = "Roboto, 'Segoe UI', Helvetica, Arial, sans-serif";

const PAYMENT_TYPE_LABELS = {
  lock_fee: 'Lock Fee',
  rent_payment: 'Rent Payment',
  inspection_fee: 'Inspection Fee',
  topup: 'Wallet Top-up',
};

/**
 * Full-bleed, flat email shell shared by every RentULO email — a wordmark
 * header, body content, and a footer, all separated by hairline borders
 * instead of padding/margin around a floating card.
 *
 * @param {object} opts
 * @param {string} [opts.preheader] - hidden preview text shown in inbox lists
 * @param {string} [opts.eyebrow] - small uppercase label above the heading (e.g. "Security alert")
 * @param {string} opts.heading
 * @param {string} opts.bodyHtml - inner content HTML
 * @param {string} [opts.footerNote] - overrides the default footer line
 */
function buildEmailShell({ preheader, eyebrow, heading, bodyHtml, footerNote }) {
  const year = new Date().getFullYear();
  return `
    <div style="background-color:#ffffff;">
      ${preheader ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${preheader}</div>` : ''}
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width:100%;background-color:#ffffff;">
        <tr>
          <td align="center">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;font-family:${FONT_STACK};">
              <tr>
                <td style="padding:26px 40px;border-bottom:1px solid ${BORDER_COLOR};">
                  <span style="font-size:19px;font-weight:600;color:${BRAND_COLOR};letter-spacing:-0.2px;">${BRAND_NAME}</span>
                </td>
              </tr>
              <tr>
                <td style="padding:36px 40px 32px 40px;">
                  ${eyebrow ? `<p style="margin:0 0 8px;font-size:12px;font-weight:600;letter-spacing:.4px;text-transform:uppercase;color:${BRAND_COLOR};">${eyebrow}</p>` : ''}
                  ${heading ? `<h1 style="margin:0 0 16px;font-size:21px;line-height:27px;font-weight:400;color:${TEXT_PRIMARY};">${heading}</h1>` : ''}
                  <div style="font-size:14px;line-height:22px;color:${TEXT_SECONDARY};">
                    ${bodyHtml}
                  </div>
                </td>
              </tr>
              <tr>
                <td style="padding:24px 40px 32px 40px;border-top:1px solid ${BORDER_COLOR};">
                  <p style="margin:0;font-size:12px;line-height:18px;color:${TEXT_MUTED};">
                    ${footerNote || `This is an automated message from ${BRAND_NAME}. Please don't reply directly to this email.`}
                  </p>
                  <p style="margin:14px 0 0;font-size:12px;color:${TEXT_FAINT};">&copy; ${year} ${BRAND_NAME} Nigeria. All rights reserved.</p>
                </td>
              </tr>
            </table>
          </td>
        </tr>
      </table>
    </div>
  `;
}

function buildActionButton(label, url) {
  if (!label || !url) return '';
  return `
    <div style="margin:28px 0 4px;">
      <a href="${url}" style="background-color:${BRAND_COLOR};color:#ffffff;padding:10px 24px;text-decoration:none;border-radius:4px;font-size:14px;font-weight:500;display:inline-block;">${label}</a>
    </div>
  `;
}

function buildCodeBadge(code) {
  if (!code) return '';
  return `
    <div style="margin:24px 0;">
      <span style="display:inline-block;font-size:30px;font-weight:600;letter-spacing:8px;color:${TEXT_PRIMARY};background-color:${SURFACE};padding:14px 28px;border-radius:4px;">${code}</span>
    </div>
  `;
}

function resolvePropertyImage(rental) {
  if (!rental || !rental.images) return '';
  if (Array.isArray(rental.images) && rental.images.length > 0) {
    return rental.images[0];
  }
  if (typeof rental.images === 'string') {
    try {
      const parsed = JSON.parse(rental.images);
      if (Array.isArray(parsed) && parsed.length > 0) return parsed[0];
    } catch (_) {
      return rental.images;
    }
  }
  return '';
}

function buildPropertyCardHtml(rental) {
  if (!rental) return '';
  const imageUrl = resolvePropertyImage(rental);
  const priceText = rental.price ? `₦${Number(rental.price).toLocaleString()}` : '';
  const priceTypeSuffix = rental.priceType ? ` / ${rental.priceType}` : '';
  return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${BORDER_COLOR};border-radius:4px;margin:20px 0;">
      ${imageUrl ? `<tr><td><img src="${imageUrl}" alt="${rental.title}" style="width:100%;max-height:180px;object-fit:cover;display:block;border-radius:3px 3px 0 0;" /></td></tr>` : ''}
      <tr>
        <td style="padding:16px;">
          <p style="margin:0 0 4px;color:${TEXT_PRIMARY};font-size:15px;font-weight:600;">${rental.title}</p>
          ${priceText ? `<p style="margin:0 0 4px;color:${BRAND_COLOR};font-size:15px;font-weight:600;">${priceText}<span style="font-size:12px;font-weight:400;color:${TEXT_MUTED};"> ${priceTypeSuffix}</span></p>` : ''}
          <p style="margin:0;color:${TEXT_MUTED};font-size:13px;">${rental.location || ''}</p>
        </td>
      </tr>
    </table>
  `;
}

function buildReceiptHtml(transaction) {
  if (!transaction) return '';
  const label = PAYMENT_TYPE_LABELS[transaction.payment_type] || 'Payment';
  const status = transaction.status || 'Success';
  const statusColor = status.toLowerCase() === 'failed' ? '#dc2626' : BRAND_COLOR;
  return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${BORDER_COLOR};border-radius:4px;margin:20px 0;">
      <tr>
        <td style="padding:12px 16px;border-bottom:1px solid ${BORDER_COLOR};font-size:12px;font-weight:600;letter-spacing:.4px;text-transform:uppercase;color:${TEXT_MUTED};">
          Transaction Summary
        </td>
      </tr>
      <tr>
        <td style="padding:8px 16px 14px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:14px;">
            <tr>
              <td style="padding:5px 0;color:${TEXT_MUTED};">Payment Type</td>
              <td style="padding:5px 0;text-align:right;color:${TEXT_PRIMARY};font-weight:500;">${label}</td>
            </tr>
            <tr>
              <td style="padding:5px 0;color:${TEXT_MUTED};">Amount Paid</td>
              <td style="padding:5px 0;text-align:right;color:${BRAND_COLOR};font-weight:600;">₦${Number(transaction.amount).toLocaleString()}</td>
            </tr>
            <tr>
              <td style="padding:5px 0;color:${TEXT_MUTED};">Reference</td>
              <td style="padding:5px 0;text-align:right;color:${TEXT_PRIMARY};font-family:monospace;font-size:12px;">${transaction.reference || '—'}</td>
            </tr>
            <tr>
              <td style="padding:5px 0;color:${TEXT_MUTED};">Status</td>
              <td style="padding:5px 0;text-align:right;color:${statusColor};font-weight:600;">${status}</td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  `;
}

function personLine(person) {
  if (!person) return '';
  const contact = [person.phone_no, person.email].filter(Boolean).join(' · ');
  return `${person.full_name}${contact ? ` <span style="color:${TEXT_FAINT};font-weight:400;">(${contact})</span>` : ''}`;
}

// Who's involved — shown to admins (both parties) and to tenants/landlords
// (the other party), so nobody has to go dig up who they're dealing with.
function buildPeopleHtml({ tenant, landlord }) {
  if (!tenant && !landlord) return '';
  const rows = [];
  if (tenant) {
    rows.push(`
      <tr>
        <td style="padding:5px 0;color:${TEXT_MUTED};">Tenant</td>
        <td style="padding:5px 0;text-align:right;color:${TEXT_PRIMARY};font-weight:500;">${personLine(tenant)}</td>
      </tr>
    `);
  }
  if (landlord) {
    rows.push(`
      <tr>
        <td style="padding:5px 0;color:${TEXT_MUTED};">Landlord</td>
        <td style="padding:5px 0;text-align:right;color:${TEXT_PRIMARY};font-weight:500;">${personLine(landlord)}</td>
      </tr>
    `);
  }
  return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${BORDER_COLOR};border-radius:4px;padding:14px 16px;margin:20px 0;">
      <tr><td><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:14px;">${rows.join('')}</table></td></tr>
    </table>
  `;
}

/**
 * Branded email body for RentULO property emails — used for tenant
 * confirmations, landlord notifications, and admin alerts alike, so all
 * three look and feel consistent. Wraps its content in the shared flat shell.
 *
 * @param {object} opts
 * @param {string} opts.heading
 * @param {string} opts.subheading
 * @param {string} opts.bodyText
 * @param {string} opts.recipientName - who the email greets ("Hello X,")
 * @param {object} [opts.rental] - property being referenced (renders the image/price/location card)
 * @param {object} [opts.transaction] - { amount, reference, payment_type } — renders a receipt table
 * @param {object} [opts.tenant] - { full_name, phone_no, email } — shown as a "Tenant" row
 * @param {object} [opts.landlord] - { full_name, phone_no, email } — shown as a "Landlord" row
 * @param {string} [opts.actionLabel]
 * @param {string} [opts.actionUrl]
 */
function buildPropertyEmailHtml({
  heading,
  subheading,
  bodyText,
  recipientName,
  rental,
  transaction,
  tenant,
  landlord,
  actionLabel,
  actionUrl,
}) {
  const propertyCardHtml = buildPropertyCardHtml(rental);
  const receiptHtml = buildReceiptHtml(transaction);
  const peopleHtml = buildPeopleHtml({ tenant, landlord });

  const btnLabel = actionLabel || (rental ? (transaction ? 'View Details' : 'View Listing') : 'Go to Dashboard');
  const btnUrl = actionUrl || (rental && rental.slug ? `https://rentulo.ng/listings/${rental.slug}` : 'https://rentulo.ng/dashboard');

  const bodyHtml = `
    <p style="margin:0 0 16px;">Hello <strong>${recipientName || 'there'}</strong>,</p>
    <p style="margin:0;">${bodyText}</p>
    ${propertyCardHtml}
    ${peopleHtml}
    ${receiptHtml}
    ${buildActionButton(btnLabel, btnUrl)}
  `;

  return buildEmailShell({
    eyebrow: subheading,
    heading,
    bodyHtml,
  });
}

module.exports = {
  buildEmailShell,
  buildActionButton,
  buildCodeBadge,
  buildPropertyEmailHtml,
};
