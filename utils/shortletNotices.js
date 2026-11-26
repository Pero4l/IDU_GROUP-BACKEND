'use strict';

// Post-checkout shortlet notifications, run by the settlement job. Each is
// sent at most once per booking: the booking row is "claimed" with a
// conditional UPDATE first, so overlapping runs never send it twice.
//
//   at check-out    → host:  "Was any damage incurred during the guest's stay?"
//                            (only when a caution fee is held and unanswered)
//                     guest: invitation to review the stay
//   before deadline → guest: review reminder (REVIEW_REMINDER_DAYS_BEFORE days left)
//   auto refund     → guest: caution fee refunded (see notifyDepositReleased)

const { Op } = require('sequelize');
const { ShortletBookings, ShortletReviews, Shortlets, Users } = require('../models');
const { todayInLagos, addDays, stayEndedAt } = require('./shortletSettlement');
const { REVIEW_WINDOW_DAYS, REVIEW_REMINDER_DAYS_BEFORE, reviewEligibility } = require('./shortletReviews');
const logger = require('./logger');

const DAY_MS = 24 * 60 * 60 * 1000;
const naira = (v) => `₦${Number(v).toLocaleString()}`;
const lagosTime = (date) => new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Africa/Lagos', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
}).format(new Date(date));

// Lazy: notification.controller pulls in the mailer, and this file is loaded
// by the settlement job.
const notify = (...args) => require('../controllers/notification.controller').logAndEmailUser(...args);

const INCLUDE = [
  { model: Shortlets, as: 'shortlet', attributes: ['id', 'title'] },
  { model: Users, as: 'guest', attributes: ['id', 'email', 'full_name'] },
  { model: Users, as: 'host', attributes: ['id', 'email', 'full_name'] },
  { model: ShortletReviews, as: 'review', attributes: ['id'], required: false },
];

// Stays that ended: completed, or ended early (cancelled during the stay).
const endedWhere = (since) => ({
  [Op.or]: [
    { status: 'completed', check_out: { [Op.gte]: since } },
    { status: 'cancelled', actual_check_out: { [Op.ne]: null, [Op.gte]: since } },
  ],
});

async function claim(bookingId, column, now) {
  const [n] = await ShortletBookings.update({ [column]: now }, { where: { id: bookingId, [column]: null } });
  return n === 1;
}

async function sendCheckoutNotices(booking, now) {
  const title = booking.shortlet?.title || 'your shortlet';
  const sent = { inspection: false, reviewInvite: false };

  if (booking.deposit_status === 'held' && !booking.deposit_inspection_outcome && Number(booking.security_deposit) > 0 && booking.host) {
    const by = booking.deposit_refund_due_at ? ` If you don't respond by ${lagosTime(booking.deposit_refund_due_at)}, the caution fee will be refunded to the guest automatically.` : '';
    await notify(booking.host.id, booking.host.email, "Checkout Inspection",
      `${booking.guest?.full_name ?? 'Your guest'} has checked out of "${title}" (stay from ${booking.check_in}). Was any damage incurred during the guest's stay? Open the booking on your dashboard and choose "No damage incurred" to refund the ${naira(booking.security_deposit)} caution fee to the guest, or "Yes, damage was incurred" to send a damage report with photos or videos to RentULO for review.${by}`
    );
    sent.inspection = true;
  }

  const e = reviewEligibility(booking, now);
  if (e.eligible && !booking.review && booking.guest) {
    await notify(booking.guest.id, booking.guest.email, "Review Your Stay",
      `Thanks for staying at "${title}"! How was it? Rate your stay from 1 to 5 stars and write a short review from your dashboard by ${lagosTime(e.deadline)} to help other guests.`
    );
    sent.reviewInvite = true;
  }
  return sent;
}

async function runCheckoutNotices(now = new Date()) {
  const summary = { inspectionPrompts: 0, reviewInvites: 0, reviewReminders: 0, failed: 0 };
  const today = todayInLagos(now);
  const since = addDays(today, -(REVIEW_WINDOW_DAYS + 1));

  // 1. At check-out
  const ended = await ShortletBookings.findAll({
    where: { checkout_notified_at: null, ...endedWhere(since) },
    include: INCLUDE,
    order: [['check_out', 'ASC']],
    limit: 200,
  });
  for (const booking of ended) {
    try {
      if (now < stayEndedAt(booking)) continue;          // ended early, but later today
      if (!await claim(booking.id, 'checkout_notified_at', now)) continue;
      const sent = await sendCheckoutNotices(booking, now);
      if (sent.inspection) summary.inspectionPrompts++;
      if (sent.reviewInvite) summary.reviewInvites++;
    } catch (error) {
      summary.failed++;
      logger.error('Checkout notice failed', { booking_id: booking.id, error: error.message });
    }
  }

  // 2. Review reminder, REVIEW_REMINDER_DAYS_BEFORE days before the deadline
  const remindFrom = addDays(today, -(REVIEW_WINDOW_DAYS - REVIEW_REMINDER_DAYS_BEFORE + 1));
  const due = await ShortletBookings.findAll({
    where: {
      checkout_notified_at: { [Op.ne]: null },
      review_reminder_sent_at: null,
      [Op.and]: [endedWhere(since), { [Op.or]: [{ check_out: { [Op.lte]: remindFrom } }, { actual_check_out: { [Op.lte]: remindFrom } }] }],
    },
    include: INCLUDE,
    limit: 200,
  });
  for (const booking of due) {
    try {
      const e = reviewEligibility(booking, now);
      if (!e.eligible || booking.review || !booking.guest) continue;
      if (now < new Date(e.deadline.getTime() - REVIEW_REMINDER_DAYS_BEFORE * DAY_MS)) continue;
      if (!await claim(booking.id, 'review_reminder_sent_at', now)) continue;
      await notify(booking.guest.id, booking.guest.email, "Reminder: Review Your Stay",
        `You still have until ${lagosTime(e.deadline)} to review your stay at "${booking.shortlet?.title || 'your shortlet'}" (from ${booking.check_in}). It only takes a minute: a star rating and a few words.`
      );
      summary.reviewReminders++;
    } catch (error) {
      summary.failed++;
      logger.error('Review reminder failed', { booking_id: booking.id, error: error.message });
    }
  }
  return summary;
}

// The settlement job refunded a held caution fee (no damage report in time,
// or a deferred "no damage" refund that has now gone through).
async function notifyDepositReleased(booking) {
  try {
    const guest = await Users.findByPk(booking.user_id, { attributes: ['id', 'email'] });
    const why = booking.deposit_inspection_outcome === 'no_damage'
      ? 'Your host confirmed that no damage was incurred'
      : 'No damage was reported after your stay';
    await notify(booking.user_id, guest?.email, "Caution Fee Refunded",
      `${why}, so your ${naira(booking.security_deposit)} caution fee for the stay from ${booking.check_in} has been refunded to your wallet.`
    );
  } catch (error) {
    logger.error('Caution fee refund notification failed', { booking_id: booking.id, error: error.message });
  }
}

module.exports = { runCheckoutNotices, notifyDepositReleased };
