const { Op, QueryTypes, UniqueConstraintError } = require('sequelize');
const { sequelize, Shortlets, ShortletBookings, ShortletReviews, Users, Profile } = require('../models');
const { logAndEmailUser } = require('./notification.controller');
const { withTransaction } = require('../utils/rollback');
const { BookingActionError, todayInLagos, addDays } = require('../utils/shortletSettlement');
const {
  REVIEW_WINDOW_DAYS, COMMENT_MIN, COMMENT_MAX, RESPONSE_MAX,
  reviewEligibility, publicReview, displayName,
} = require('../utils/shortletReviews');
const logger = require('../utils/logger');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUUID = (v) => typeof v === 'string' && UUID_RE.test(v);

function sendError(res, error) {
  return res.status(error.status).json({ success: false, ...(error.code && { code: error.code }), message: error.message });
}

const GUEST_INCLUDE = { model: Users, as: 'guest', attributes: ['id', 'full_name'], include: [{ model: Profile, attributes: ['image'] }] };

function parsePage(query) {
  const limit = Math.min(Math.max(parseInt(query.limit, 10) || 10, 1), 50);
  const offset = Math.max(parseInt(query.offset, 10) || 0, 0);
  return { limit, offset };
}

// Recompute the listing's average and count from the reviews themselves, in
// the caller's transaction (the listing row is locked, so concurrent reviews
// for the same listing apply one after another).
async function refreshListingRating(shortletId, t) {
  const [row] = await sequelize.query(
    'SELECT COUNT(*)::int AS count, ROUND(AVG(rating)::numeric, 2) AS average FROM shortlet_reviews WHERE shortlet_id = :id',
    { replacements: { id: shortletId }, type: QueryTypes.SELECT, transaction: t }
  );
  await Shortlets.update(
    { reviewCount: row.count, ratingAverage: row.count ? row.average : null },
    { where: { id: shortletId }, transaction: t }
  );
  return { reviewCount: row.count, ratingAverage: row.count ? row.average : null };
}

// ─────────────────────────────────────────────
// GET /shortlet/get1/:id/reviews?limit=&offset=  — public (no login)
// ─────────────────────────────────────────────
async function getShortletReviews(req, res) {
  try {
    const { id } = req.params;
    const shortlet = await Shortlets.findOne({
      where: isUUID(id) ? { id } : { slug: id },
      attributes: ['id', 'slug', 'title', 'ratingAverage', 'reviewCount'],
    });
    if (!shortlet) return res.status(404).json({ success: false, message: "Short let not found" });

    const { limit, offset } = parsePage(req.query);
    const { rows, count } = await ShortletReviews.findAndCountAll({
      where: { shortlet_id: shortlet.id },
      include: [GUEST_INCLUDE],
      order: [['createdAt', 'DESC']],
      limit,
      offset,
      distinct: true,
    });
    return res.status(200).json({
      success: true,
      message: "Reviews retrieved successfully",
      data: {
        shortlet_id: shortlet.id,
        ratingAverage: shortlet.ratingAverage,
        reviewCount: shortlet.reviewCount,
        reviews: rows.map(publicReview),
      },
      pagination: { total: count, limit, offset },
    });
  } catch (error) {
    logger.error('Error fetching shortlet reviews', { error: error.message });
    return res.status(500).json({ success: false, message: "Server error" });
  }
}

// ─────────────────────────────────────────────
// POST /shortlet/bookings/:bookingId/review  — the booking's guest
// Body: { rating: 1–5, comment }
// ─────────────────────────────────────────────
async function submitShortletReview(req, res) {
  try {
    const { bookingId } = req.params;
    if (!isUUID(bookingId)) return res.status(404).json({ success: false, message: "Booking not found" });
    const userId = req.user.userId;

    const rating = Number(req.body?.rating);
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      return res.status(400).json({ success: false, code: 'INVALID_RATING', message: "rating must be a whole number from 1 to 5" });
    }
    const comment = typeof req.body?.comment === 'string' ? req.body.comment.trim() : '';
    if (comment.length < COMMENT_MIN || comment.length > COMMENT_MAX) {
      return res.status(400).json({ success: false, code: 'INVALID_COMMENT', message: `Write a review of ${COMMENT_MIN}–${COMMENT_MAX} characters about your stay` });
    }

    let result;
    try {
      result = await withTransaction(async (t) => {
        const booking = await ShortletBookings.findByPk(bookingId, { transaction: t, lock: t.LOCK.UPDATE });
        if (!booking || booking.user_id !== userId) throw new BookingActionError(404, 'Booking not found', 'NOT_FOUND');
        const e = reviewEligibility(booking);
        if (!e.eligible) throw new BookingActionError(400, e.message, e.code);
        if (await ShortletReviews.findOne({ where: { booking_id: booking.id }, transaction: t })) {
          throw new BookingActionError(409, 'You have already reviewed this stay', 'REVIEW_EXISTS');
        }
        const shortlet = await Shortlets.findByPk(booking.shortlet_id, { transaction: t, lock: t.LOCK.UPDATE, attributes: ['id', 'title'] });
        if (!shortlet) throw new BookingActionError(400, 'This listing has been removed and can no longer be reviewed', 'LISTING_REMOVED');

        const review = await ShortletReviews.create({
          booking_id: booking.id,
          shortlet_id: shortlet.id,
          guest_id: userId,
          host_id: booking.host_id,
          rating,
          comment,
          stay_check_in: booking.check_in,
          stay_check_out: booking.actual_check_out || booking.check_out,
        }, { transaction: t });
        const listingRating = await refreshListingRating(shortlet.id, t);
        return { review, shortlet, booking, listingRating };
      }, { context: 'shortletReview', bookingId, userId });
    } catch (error) {
      if (error instanceof BookingActionError) return sendError(res, error);
      if (error instanceof UniqueConstraintError) {
        return res.status(409).json({ success: false, code: 'REVIEW_EXISTS', message: "You have already reviewed this stay" });
      }
      throw error;
    }
    const { review, shortlet, booking } = result;
    logger.info('Shortlet review submitted', { review_id: review.id, booking_id: booking.id, rating });

    try {
      const [guest, host] = await Promise.all([
        Users.findByPk(userId, { attributes: ['id', 'full_name'] }),
        booking.host_id ? Users.findByPk(booking.host_id, { attributes: ['id', 'email'] }) : null,
      ]);
      if (host) {
        await logAndEmailUser(host.id, host.email, "New Guest Review",
          `${displayName(guest?.full_name)} left a ${rating}-star review for "${shortlet.title}" (stay from ${booking.check_in}): "${comment}". You can respond publicly from your dashboard.`
        );
      }
    } catch (notifyError) {
      logger.error('Review notification failed', { error: notifyError.message, review_id: review.id });
    }

    const full = await ShortletReviews.findByPk(review.id, { include: [GUEST_INCLUDE] });
    return res.status(201).json({
      success: true,
      message: "Thank you! Your review has been published",
      data: publicReview(full),
      shortlet: { id: shortlet.id, ...result.listingRating },
    });
  } catch (error) {
    logger.error('Error submitting shortlet review', { error: error.message, userId: req.user?.userId });
    return res.status(500).json({ success: false, message: "Server error" });
  }
}

// ─────────────────────────────────────────────
// GET /shortlet/reviews/pending  — the guest's completed stays still waiting for a review
// ─────────────────────────────────────────────
async function getPendingShortletReviews(req, res) {
  try {
    const now = new Date();
    // Stays that ended in the last REVIEW_WINDOW_DAYS (+1 for the Lagos day edge).
    const since = addDays(todayInLagos(now), -(REVIEW_WINDOW_DAYS + 1));
    const bookings = await ShortletBookings.findAll({
      where: {
        user_id: req.user.userId,
        [Op.or]: [
          { status: 'completed', check_out: { [Op.gte]: since } },
          { status: 'cancelled', actual_check_out: { [Op.gte]: since } },
        ],
      },
      include: [
        { model: Shortlets, as: 'shortlet', attributes: ['id', 'slug', 'title', 'coverImage', 'city', 'area'] },
        { model: ShortletReviews, as: 'review', attributes: ['id'] },
      ],
      order: [['check_out', 'DESC']],
    });
    const data = bookings
      .filter((b) => !b.review)
      .map((b) => ({ booking: b, e: reviewEligibility(b, now) }))
      .filter(({ e }) => e.eligible)
      .map(({ booking: b, e }) => ({
        booking_id: b.id,
        shortlet: b.shortlet,
        check_in: b.check_in,
        check_out: b.actual_check_out || b.check_out,
        reviewDeadline: e.deadline,
      }));
    return res.status(200).json({ success: true, count: data.length, data, message: "Stays awaiting your review" });
  } catch (error) {
    logger.error('Error fetching pending reviews', { error: error.message, userId: req.user?.userId });
    return res.status(500).json({ success: false, message: "Server error" });
  }
}

// ─────────────────────────────────────────────
// GET /shortlet/host/reviews?shortlet_id=&limit=&offset=  — reviews of the host's listings
// ─────────────────────────────────────────────
async function getHostShortletReviews(req, res) {
  try {
    const where = { host_id: req.user.userId };
    if (req.query.shortlet_id) {
      if (!isUUID(req.query.shortlet_id)) return res.status(400).json({ success: false, message: "shortlet_id must be a valid id" });
      where.shortlet_id = req.query.shortlet_id;
    }
    if (req.query.responded === 'false') where.host_response = null;
    const { limit, offset } = parsePage(req.query);
    const { rows, count } = await ShortletReviews.findAndCountAll({
      where,
      include: [GUEST_INCLUDE, { model: Shortlets, as: 'shortlet', attributes: ['id', 'slug', 'title', 'ratingAverage', 'reviewCount'] }],
      order: [['createdAt', 'DESC']],
      limit,
      offset,
      distinct: true,
    });
    const data = rows.map((r) => ({ ...publicReview(r), booking_id: r.booking_id, shortlet: r.shortlet, canRespond: true }));
    return res.status(200).json({ success: true, data, pagination: { total: count, limit, offset }, message: "Reviews retrieved successfully" });
  } catch (error) {
    logger.error('Error fetching host reviews', { error: error.message, userId: req.user?.userId });
    return res.status(500).json({ success: false, message: "Server error" });
  }
}

// ─────────────────────────────────────────────
// PUT /shortlet/reviews/:reviewId/response  — the listing's host
// Body: { response }. Posts the public response, or edits it.
// ─────────────────────────────────────────────
async function respondToShortletReview(req, res) {
  try {
    const { reviewId } = req.params;
    if (!isUUID(reviewId)) return res.status(404).json({ success: false, message: "Review not found" });
    const text = typeof req.body?.response === 'string' ? req.body.response.trim() : '';
    if (text.length < 1 || text.length > RESPONSE_MAX) {
      return res.status(400).json({ success: false, code: 'INVALID_RESPONSE', message: `response must be 1–${RESPONSE_MAX} characters` });
    }

    const review = await ShortletReviews.findByPk(reviewId);
    if (!review) return res.status(404).json({ success: false, message: "Review not found" });
    if (!review.host_id || review.host_id !== req.user.userId) {
      return res.status(403).json({ success: false, message: "Only the host of this listing can respond to this review" });
    }

    const now = new Date();
    const first = !review.host_response;
    review.host_response = text;
    if (first) review.host_responded_at = now;
    else review.host_response_updated_at = now;
    await review.save();

    if (first) {
      try {
        const [guest, shortlet] = await Promise.all([
          Users.findByPk(review.guest_id, { attributes: ['id', 'email'] }),
          Shortlets.findByPk(review.shortlet_id, { attributes: ['id', 'title'] }),
        ]);
        await logAndEmailUser(review.guest_id, guest?.email, "Host Responded To Your Review",
          `The host of "${shortlet?.title ?? 'your stay'}" responded to your review: "${text}"`
        );
      } catch (notifyError) {
        logger.error('Review response notification failed', { error: notifyError.message, review_id: review.id });
      }
    }

    const full = await ShortletReviews.findByPk(review.id, { include: [GUEST_INCLUDE] });
    return res.status(200).json({ success: true, message: first ? "Response published" : "Response updated", data: publicReview(full) });
  } catch (error) {
    logger.error('Error responding to review', { error: error.message, userId: req.user?.userId });
    return res.status(500).json({ success: false, message: "Server error" });
  }
}

module.exports = {
  getShortletReviews,
  submitShortletReview,
  getPendingShortletReviews,
  getHostShortletReviews,
  respondToShortletReview,
};
