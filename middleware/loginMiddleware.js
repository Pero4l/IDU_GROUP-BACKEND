const {Users} = require("../models");
const { Op } = require("sequelize");
const bcrypt = require("bcrypt");

async function loginMiddleware(req, res, next) {
  const { user, password } = req.body;

  if (!user || !password) {
    return res.status(400).json({
      success: false,
      message: "Email or phone number and password is required",
    });
  }

  const existingUser = await Users.findOne({
    attributes: [
      "id",
      "password",
      "first_name",
      "last_name",
      "state",
      "country",
      "email",
      "role",
    ],
    where: { [Op.or]: [{ email: user }, { phone_no: user }] },
  });

  
  if (!existingUser) {
    return res.status(404).json({
      success: false,
      message: "User does not exist",
    });
  }

  const passMatch = await bcrypt.compare(password, existingUser.password);
  if (!passMatch) {
    return res.status(401).json({
      success: false,
      message: "Wrong email/number or password",
    });
  }

  req.user = passMatch;
  req.data = existingUser;
  next();
}

module.exports = {
  loginMiddleware,
};
