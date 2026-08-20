const { Pins, Users, Notifications } = require("../models");
const bcrypt = require("bcrypt");

async function createPin(req, res) {
    const { pin } = req.body;
    const userId = req.user.id;

    
    if (!pin || pin.length !== 4 || !/^\d+$/.test(pin)) {
        return res.status(400).json({ message: "Pin must be a 4-digit number." });
    }
    if (/[A-Z]/.test(pin) || /[a-z]/.test(pin)){
        return res.status(400).json({ message: "Pin must not contain letters." });
    }

    try {
        const existingPin = await Pins.findOne({ where: { user_id: userId } });
        if (existingPin) {
            return res.status(400).json({ message: "Pin already exists for this user." });
        }

        const hashedPin = await bcrypt.hash(pin, 10);

        const newPin = await Pins.create({
            user_id: userId,
            pin: hashedPin,
        });

        
        await Notifications.create({
            user_id: userId,
            message: "Your pin has been created successfully.",
        });

        return res.status(201).json({ message: "Pin created successfully.", pin: newPin });
    } catch (error) {
        console.error("Error creating pin:", error);
        return res.status(500).json({ message: "Internal server error." });
    }
}


async function updatePin(req, res) {
    const { oldPin, newPin } = req.body;
    const userId = req.user.id;

    try {
        const existingPin = await Pins.findOne({ where: { user_id: userId } });
        const isOldPinValid = existingPin && await bcrypt.compare(oldPin, existingPin.pin);
        if (!isOldPinValid) {
            return res.status(400).json({ message: "Invalid old pin." });
        }

        if (!newPin || newPin.length !== 4 || !/^\d+$/.test(newPin)) {
            return res.status(400).json({ message: "New pin must be a 4-digit number." });
        }
        if (/[A-Z]/.test(newPin) || /[a-z]/.test(newPin)){
            return res.status(400).json({ message: "New pin must not contain letters." });
        }

        const pinRecord = await Pins.findOne({ where: { user_id: userId } });
        if (!pinRecord) {
            return res.status(404).json({ message: "No existing pin found for this user." });
        }

        const hashedPin = await bcrypt.hash(newPin, 10);

        pinRecord.pin = hashedPin;
        await pinRecord.save();

        
        await Notifications.create({
            user_id: userId,
            message: "Your pin has been updated successfully.",
        });

        return res.status(200).json({ message: "Pin updated successfully.", pin: pinRecord });
    } catch (error) {
        console.error("Error updating pin:", error);
        return res.status(500).json({ message: "Internal server error." });
    }
}

module.exports = {
    createPin,
    updatePin,
};
