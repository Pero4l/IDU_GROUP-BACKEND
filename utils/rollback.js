const { sequelize } = require('../models');
const logger = require('./logger');

/**
 * Wraps an async database operation inside a Sequelize managed transaction.
 *
 * ─ If every step inside `operation` succeeds  → transaction is committed.
 * ─ If ANY step throws (network drop, DB error, timeout …) → the entire
 *   transaction is rolled back, leaving the DB in the state it was before
 *   the call. The original error is re-thrown so the controller can respond.
 *
 * Usage:
 *   const result = await withTransaction(async (t) => {
 *     const user    = await Users.create({ ... }, { transaction: t });
 *     const profile = await Profile.create({ user_id: user.id }, { transaction: t });
 *     return user;
 *   }, { context: 'register', email: 'x@x.com' });
 *
 * @param {(t: import('sequelize').Transaction) => Promise<any>} operation
 * @param {object} [meta]  - Extra context written to the log on rollback
 * @returns {Promise<any>}
 */
async function withTransaction(operation, meta = {}) {
  const t = await sequelize.transaction();
  try {
    const result = await operation(t);
    await t.commit();
    logger.info('Transaction committed', meta);
    return result;
  } catch (error) {
    // Sequelize checks internally whether the transaction is still active
    // before rolling back, so this is always safe to call.
    await t.rollback();
    logger.error('Transaction rolled back', {
      ...meta,
      error: error.message,
      stack: error.stack,
    });
    // Re-throw so the calling controller can send the right HTTP response.
    throw error;
  }
}

/**
 * Express middleware wrapper that catches any unhandled async error,
 * logs it, and returns a clean 500 response.
 *
 * Usage:
 *   router.post('/endpoint', catchAsync(myController));
 *
 * @param {(req, res, next) => Promise<void>} fn
 */
function catchAsync(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch((error) => {
      logger.error('Unhandled controller error', {
        route: req.originalUrl,
        method: req.method,
        userId: req.user?.userId,
        error: error.message,
        stack: error.stack,
      });
      return res
        .status(500)
        .json({ success: false, message: 'Server error', error: error.message });
    });
  };
}

module.exports = { withTransaction, catchAsync };
