const {Users} = require('../models');
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
require("dotenv").config();



async function register(req, res) {
  try {
    
    const {
      first_name,
      last_name,
      gender,
      role,
      phone_no,
      email,
      address,
      state,
      country,
      password,
    } = req.body;

    if (
      !first_name ||
      !last_name ||
      !gender ||
      !role ||
      !phone_no ||
      !address ||
      !state ||
      !country ||
      !email ||
      !password
    ) {
      return res.status(400).json({ message: "All fields are required" });
    }

    if (password.length < 6) {
      return res.status(400).json({ message: "Password must be at least 6 characters" });
    } else if (!/[A-Z]/.test(password) || !/[a-z]/.test(password)) {
      return res.status(400).json({ message: "Password must contain both uppercase and lowercase letters" });
    } else if (!/[0-9]/.test(password)) {
      return res.status(400).json({ message: "Password must contain a number" });
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ message: "Invalid email format" });
    } else if (first_name.length < 3 || last_name.length < 3) {
      return res.status(400).json({ message: "Name must be at least 3 characters" });
    }

    const existingUser = await Users.findOne({ where: { email } });
    if (existingUser) {
      return res.status(400).json({ success: false, message: "User already exists" });
    }

    const hashedPassword = await bcrypt.hash(password, 12);


    await Users.create({
      first_name,
      last_name,
      gender,
      role,
      email,
      phone_no,
      address,
      state,
      country,
      password: hashedPassword,
    });


    // HANDLE NOTIFICATION
    // const isUser = await Users.findOne({ where: { email } });
    // if (isUser) {

    //   await Notifications.create({
    //     user_id: isUser.id,
    //     type: "account",
    //     notification: `Welcome to RentUIO ${isUser.first_name} ${isUser.last_name}! Your account has been successfully created.`,
    //     is_read: false
    //   })
      
    // }


    // HANDLE PROFILE CREATION
    // let location =  `${state}, ${country}`
    // let share = `main/${phone_no}`
    // const user = await Users.findOne({ where: { email } });
    // if (user) {

    //   await Profile.create({
    //     user_id: user.id, 
    //     bio: null || 'Excited to be part of the FarmChain community, let connect and grow together!',
    //     organization: 'eg FarmChain',
    //     location: location,
    //     verified: false,
    //     share_account: share,
    //   });
    // }
    

    return res.status(201).json({
      success: true,
      message: "Account registered successfully",
    });

  } catch (error) {
    console.error(error);
    return res.status(500).json({
      success: false,
      message: "Server error",
    });
  }
}

async function login(req, res) {
  
  const token = jwt.sign(
    {
      userId: req.data.id,
      currentUser: `${req.data.first_name} ${req.data.last_name}`,
      location: `${req.data.state}, ${req.data.country}`,
      email: `${req.data.email}`
    },
    process.env.JWT_SECRET,
    { expiresIn: "24h" }
  );

  const role = req.data.role
  console.log(role);
  

  // const userId = req.data.id;
  // const currentUser = `${req.data.first_name} ${req.data.last_name}`;
  // const location = `${req.data.state}, ${req.data.country}`;
  // const verified = req.data.verified

  // const user = { 
  //  userId: req.data.id,
  //  currentUser: `${req.data.first_name} ${req.data.last_name}`,
  //  location: `${req.data.state}, ${req.data.country}`,
  //  email: `${req.data.email}`
  // }



// Notification count
// const notificationCount = await Notifications.count({
//   where: { user_id: user.userId, is_read: false }
// });




  if (req.user) {
    return res.status(200).json({
      success: true,
      message: "Login Successfully",
      token: token,
      role: role,

      // user: user,
    });
  }


}


module.exports = {register, login}