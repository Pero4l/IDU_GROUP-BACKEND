const PAYMENT_TYPE_LABELS = {
  lock_fee: 'Lock Fee',
  rent_payment: 'Rent Payment',
  inspection_fee: 'Inspection Fee',
};

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
    <div style="border: 1px solid #e5e7eb; border-radius: 10px; overflow: hidden; margin: 20px 0; background-color: #ffffff; box-shadow: 0 2px 8px rgba(0,0,0,0.02);">
      ${imageUrl ? `<img src="${imageUrl}" alt="${rental.title}" style="width: 100%; height: 180px; object-fit: cover; border-bottom: 1px solid #e5e7eb;" />` : ''}
      <div style="padding: 15px;">
        <h4 style="margin: 0 0 5px 0; color: #111827; font-size: 15px; font-weight: 600;">${rental.title}</h4>
        ${priceText ? `<p style="margin: 0 0 5px 0; color: #10b981; font-size: 16px; font-weight: 700;">${priceText}<span style="font-size: 12px; font-weight: normal; color: #6b7280;">${priceTypeSuffix}</span></p>` : ''}
        <p style="margin: 0; color: #6b7280; font-size: 13px;">📍 ${rental.location || ''}</p>
      </div>
    </div>
  `;
}

function buildReceiptHtml(transaction) {
  if (!transaction) return '';
  const label = PAYMENT_TYPE_LABELS[transaction.payment_type] || 'Payment';
  return `
    <div style="background-color: #f9fafb; border: 1px solid #e5e7eb; border-radius: 8px; padding: 20px; margin: 20px 0;">
      <h4 style="margin: 0 0 15px 0; color: #111827; font-size: 14px; text-transform: uppercase; letter-spacing: 0.5px; border-bottom: 1px solid #e5e7eb; padding-bottom: 8px;">Transaction Summary</h4>
      <table style="width: 100%; border-collapse: collapse; font-size: 14px;">
        <tr>
          <td style="padding: 5px 0; color: #6b7280;">Payment Type:</td>
          <td style="padding: 5px 0; text-align: right; color: #111827; font-weight: 500;">${label}</td>
        </tr>
        <tr>
          <td style="padding: 5px 0; color: #6b7280;">Amount Paid:</td>
          <td style="padding: 5px 0; text-align: right; color: #10b981; font-weight: 600;">₦${Number(transaction.amount).toLocaleString()}</td>
        </tr>
        <tr>
          <td style="padding: 5px 0; color: #6b7280;">Reference:</td>
          <td style="padding: 5px 0; text-align: right; color: #111827; font-family: monospace; font-size: 12px;">${transaction.reference || '—'}</td>
        </tr>
        <tr>
          <td style="padding: 5px 0; color: #6b7280;">Status:</td>
          <td style="padding: 5px 0; text-align: right; color: #10b981; font-weight: 600;">Success</td>
        </tr>
      </table>
    </div>
  `;
}

function personLine(person) {
  if (!person) return '';
  const contact = [person.phone_no, person.email].filter(Boolean).join(' · ');
  return `${person.full_name}${contact ? ` <span style="color:#9ca3af;font-weight:400;">(${contact})</span>` : ''}`;
}

// Who's involved — shown to admins (both parties) and to tenants/landlords
// (the other party), so nobody has to go dig up who they're dealing with.
function buildPeopleHtml({ tenant, landlord }) {
  if (!tenant && !landlord) return '';
  const rows = [];
  if (tenant) {
    rows.push(`
      <tr>
        <td style="padding: 5px 0; color: #6b7280;">Tenant:</td>
        <td style="padding: 5px 0; text-align: right; color: #111827; font-weight: 500;">${personLine(tenant)}</td>
      </tr>
    `);
  }
  if (landlord) {
    rows.push(`
      <tr>
        <td style="padding: 5px 0; color: #6b7280;">Landlord:</td>
        <td style="padding: 5px 0; text-align: right; color: #111827; font-weight: 500;">${personLine(landlord)}</td>
      </tr>
    `);
  }
  return `
    <div style="background-color: #f0fdf4; border: 1px solid #d1fae5; border-radius: 8px; padding: 15px 20px; margin: 20px 0;">
      <table style="width: 100%; border-collapse: collapse; font-size: 14px;">${rows.join('')}</table>
    </div>
  `;
}

/**
 * Shared light-green branded email shell for RentULO property emails —
 * used for tenant confirmations, landlord notifications, and admin alerts
 * alike, so all three look and feel consistent.
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
  const currentYear = new Date().getFullYear();

  const propertyCardHtml = buildPropertyCardHtml(rental);
  const receiptHtml = buildReceiptHtml(transaction);
  const peopleHtml = buildPeopleHtml({ tenant, landlord });

  const btnLabel = actionLabel || (rental ? (transaction ? 'View Details' : 'View Listing') : 'Go to Dashboard');
  const btnUrl = actionUrl || (rental && rental.slug ? `https://rentulo.ng/listings/${rental.slug}` : 'https://rentulo.ng/dashboard');
  const actionButtonHtml = `
    <div style="text-align: center; margin: 30px 0 10px 0;">
      <a href="${btnUrl}"
         style="background-color: #10b981; color: #ffffff; padding: 12px 24px; text-decoration: none; border-radius: 8px; font-size: 14px; font-weight: 600; display: inline-block; box-shadow: 0 4px 6px rgba(16, 185, 129, 0.15);">
        ${btnLabel}
      </a>
    </div>
  `;

  return `
    <div style="font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; background-color: #f4f7f6; padding: 30px 15px;">
      <div style="max-width: 550px; margin: 0 auto; background-color: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 15px rgba(0,0,0,0.05); border-top: 4px solid #10b981;">
        <div style="padding: 25px; text-align: center; background-color: #f0fdf4;">
          <div style="background-color: #d1fae5; width: 50px; height: 50px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; margin-bottom: 10px; margin-left: auto; margin-right: auto;">
            <span style="font-size: 24px;">${transaction ? '💰' : '❤️'}</span>
          </div>
          <h2 style="margin: 0; color: #064e3b; font-size: 20px; font-weight: 700;">${heading}</h2>
          <p style="margin: 5px 0 0 0; color: #047857; font-size: 14px;">${subheading}</p>
        </div>

        <div style="padding: 30px; color: #374151; font-size: 15px; line-height: 1.6;">
          <p>Hello <strong>${recipientName || 'there'}</strong>,</p>
          <p>${bodyText}</p>

          ${propertyCardHtml}
          ${peopleHtml}
          ${receiptHtml}
          ${actionButtonHtml}
        </div>

        <div style="background-color: #f9fafb; padding: 20px 30px; text-align: center; border-top: 1px solid #e5e7eb;">
          <p style="margin: 0; color: #9ca3af; font-size: 12px;">
            © ${currentYear} RentULO. All rights reserved.
          </p>
        </div>
      </div>
    </div>
  `;
}

module.exports = { buildPropertyEmailHtml };
