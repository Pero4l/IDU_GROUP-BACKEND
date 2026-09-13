const { Pins, Users, Notifications } = require("../models");
const bcrypt = require("bcrypt");
const logger = require("../utils/logger");

const PIN_PATTERN = /^\d{4}$/;

// The JWT carries `userId` (see users.controller.js login) — `req.user.id`
// does not exist. Centralising the lookup here keeps both handlers consistent.
function isValidPinFormat(pin) {
  return typeof pin === "string" && PIN_PATTERN.test(pin);
}

async function createPin(req, res) {
    const { pin } = req.body;
    const userId = req.user.userId;

    if (!isValidPinFormat(pin)) {
        return res.status(400).json({ success: false, message: "Pin must be a 4-digit number." });
    }

    try {
        const existingPin = await Pins.findOne({ where: { user_id: userId } });
        if (existingPin) {
            return res.status(400).json({ success: false, message: "Pin already exists for this user." });
        }

        const hashedPin = await bcrypt.hash(pin, 10);

        const newPin = await Pins.create({
            user_id: userId,
            pin: hashedPin,
        });

        await Notifications.create({
            user_id: userId,
            type: "system",
            notification: "Your transaction pin has been created successfully.",
            is_read: false,
        });

        return res.status(201).json({ success: true, message: "Pin created successfully.", pin: { id: newPin.id, user_id: newPin.user_id } });
    } catch (error) {
        logger.error("Error creating pin:", { error: error.message, userId });
        return res.status(500).json({ success: false, message: "Internal server error." });
    }
}


async function updatePin(req, res) {
    const { oldPin, newPin } = req.body;
    const userId = req.user.userId;

    if (!isValidPinFormat(newPin)) {
        return res.status(400).json({ success: false, message: "New pin must be a 4-digit number." });
    }

    try {
        const existingPin = await Pins.findOne({ where: { user_id: userId } });
        if (!existingPin) {
            return res.status(404).json({ success: false, message: "No existing pin found for this user." });
        }

        const isOldPinValid = await bcrypt.compare(oldPin, existingPin.pin);
        if (!isOldPinValid) {
            return res.status(400).json({ success: false, message: "Invalid old pin." });
        }

        const hashedPin = await bcrypt.hash(newPin, 10);

        existingPin.pin = hashedPin;
        await existingPin.save();

        await Notifications.create({
            user_id: userId,
            type: "system",
            notification: "Your transaction pin has been updated successfully.",
            is_read: false,
        });

        return res.status(200).json({ success: true, message: "Pin updated successfully.", pin: { id: existingPin.id, user_id: existingPin.user_id } });
    } catch (error) {
        logger.error("Error updating pin:", { error: error.message, userId });
        return res.status(500).json({ success: false, message: "Internal server error." });
    }
}

module.exports = {
    createPin,
    updatePin,
};