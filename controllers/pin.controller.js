const { Pins, Users, Notifications } = require("../models");
const bcrypt = require("bcrypt");

function createPin(req, res) {
    const { pin } = req.body;
    const userId = req.user.id;

    
    if (!pin || pin.length !== 4 || !/^\d+$/.test(pin)) {
        return res.status(400).json({ message: "Pin must be a 4-digit number." });
    }
    if (/[A-Z]/.test(password) || /[a-z]/.test(pin)){
        return res.status(400).json({ message: "Pin must not contain letters." });
    }

    await Pins.findOne({ where: { user_id: userId } })
        .then(async (existingPin) => {
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
        })
        .catch((error) => {
            console.error("Error creating pin:", error);
            return res.status(500).json({ message: "Internal server error." });
        });

}


function