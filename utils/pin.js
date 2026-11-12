const bcrypt = require('bcrypt');
const { Pins } = require('../models');

const PIN_PATTERN = /^\d{4}$/;

/**
 * Verifies a user's 4-digit transaction PIN before money leaves their wallet.
 * Returns null on success, or { status, message, code } on failure so the
 * caller can respond with the right HTTP code. PINs are stored bcrypt-hashed
 * (see pin.controller.js), so we always compare against the hash.
 *
 * `action` is only used to phrase the "no pin set" message
 * (e.g. "withdrawing", "booking").
 */
async function verifyTransactionPin(user_id, pin, action = 'continuing') {
  const pinRecord = await Pins.findOne({ where: { user_id } });
  if (!pinRecord || !pinRecord.pin) {
    return {
      status: 403,
      code: 'PIN_NOT_SET',
      message: `You have not set a transaction pin. Please create one before ${action}.`,
    };
  }
  if (typeof pin !== 'string' || !PIN_PATTERN.test(pin)) {
    return { status: 400, code: 'PIN_REQUIRED', message: 'A valid 4-digit transaction pin is required.' };
  }
  const matches = await bcrypt.compare(pin, pinRecord.pin);
  if (!matches) {
    return { status: 403, code: 'PIN_INCORRECT', message: 'Incorrect transaction pin.' };
  }
  return null;
}

module.exports = { verifyTransactionPin, PIN_PATTERN };
