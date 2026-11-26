'use strict';

// Shortlet guest reviews: who may review, and how a review is shown.
// One overall 1–5 rating + a written review per completed stay, submitted
// within REVIEW_WINDOW_DAYS of check-out. Reviews can't be edited; the host
// may post (and later edit) one public response.

const { stayEndedAt } = require('./shortletSettlement');

const REVIEW_WINDOW_DAYS = 14;
const REVIEW_REMINDER_DAYS_BEFORE = 3;   // reminder 3 days before the deadline
const COMMENT_MIN = 10;
const COMMENT_MAX = 2000;
const RESPONSE_MAX = 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

function plain(booking) {
  return typeof booking?.toJSON === 'function' ? booking.toJSON() : booking;
}

// The guest actually stayed: a completed booking, or a stay that was ended
// early (cancelled during the stay, so it has an actual check-out day).
function guestStayed(b) {
  return b.status === 'completed' || (b.status === 'cancelled' && !!b.actual_check_out);
}

function reviewDeadline(booking) {
  return new Date(stayEndedAt(plain(booking)).getTime() + REVIEW_WINDOW_DAYS * DAY_MS);
}

// { eligible, code, message, deadline } — does not check for an existing review.
function reviewEligibility(booking, now = new Date()) {
  const b = plain(booking);
  const deadline = reviewDeadline(b);
  const no = (code, message) => ({ eligible: false, code, message, deadline });
  if (!guestStayed(b)) return no('STAY_NOT_COMPLETED', 'You can review a stay once it has been completed');
  if (now < stayEndedAt(b)) return no('STAY_NOT_COMPLETED', 'You can review a stay once you have checked out');
  if (now > deadline) return no('REVIEW_WINDOW_CLOSED', `Reviews must be submitted within ${REVIEW_WINDOW_DAYS} days of check-out`);
  if (!b.shortlet_id) return no('LISTING_REMOVED', 'This listing has been removed and can no longer be reviewed');
  return { eligible: true, code: null, message: null, deadline };
}

// "Chidi Okafor" → "Chidi O."
function displayName(fullName) {
  const parts = String(fullName || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return 'Guest';
  return parts.length === 1 ? parts[0] : `${parts[0]} ${parts[parts.length - 1][0].toUpperCase()}.`;
}

function stayMonth(dateOnly) {
  const d = new Date(`${dateOnly}T12:00:00Z`);
  return new Intl.DateTimeFormat('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(d);
}

function hostResponse(r) {
  return r.host_response
    ? { text: r.host_response, respondedAt: r.host_responded_at, updatedAt: r.host_response_updated_at || r.host_responded_at }
    : null;
}

// How a review appears on the property page (no ids of the guest beyond a
// display name and photo).
function publicReview(review) {
  const r = plain(review);
  return {
    id: r.id,
    rating: r.rating,
    comment: r.comment,
    createdAt: r.createdAt,
    stay: { checkIn: r.stay_check_in, checkOut: r.stay_check_out, month: stayMonth(r.stay_check_in) },
    verifiedBooking: true, // a review can only exist for a real, completed booking
    guest: {
      displayName: displayName(r.guest?.full_name),
      profileImage: r.guest?.Profile?.image || null,
    },
    hostResponse: hostResponse(r),
  };
}

// The `review` block on a booking, for the guest or the host.
function bookingReviewSummary(booking, role, now = new Date()) {
  const b = plain(booking);
  const r = b.review || null;
  const e = reviewEligibility(b, now);
  return {
    submitted: !!r,
    canReview: role === 'guest' && !r && e.eligible,
    deadline: guestStayed(b) ? e.deadline : null,
    ...(role === 'guest' && !r && !e.eligible && guestStayed(b) && { reason: e.message }),
    review: r ? {
      id: r.id, rating: r.rating, comment: r.comment, createdAt: r.createdAt, hostResponse: hostResponse(r),
    } : null,
    canRespond: role === 'host' && !!r,
  };
}

module.exports = {
  REVIEW_WINDOW_DAYS,
  REVIEW_REMINDER_DAYS_BEFORE,
  COMMENT_MIN,
  COMMENT_MAX,
  RESPONSE_MAX,
  guestStayed,
  reviewDeadline,
  reviewEligibility,
  displayName,
  stayMonth,
  publicReview,
  bookingReviewSummary,
};
