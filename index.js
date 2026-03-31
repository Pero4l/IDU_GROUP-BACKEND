const express = require('express');

require('dotenv').config();
const cors = require("cors");


const app = express();
app.use(express.json());
app.use(cors({ origin: "*" }));
app.use(express.urlencoded({ extended: true }));

const db = require("./config/db");

const userAuth = require('./routes/user.routes');
const rentalsRoute = require('./routes/rental.routes');
const notificationRoute = require('./routes/notification.routes');
const counts = require('./routes/allCount.routes');
const progressRoute = require('./routes/progress.routes');
const profileRoute = require('./routes/profile.routes');
const reportRoute = require('./routes/report.routes');

app.get("/", (req, res) => {
  res.status(200).json({
    message: "Welcome to RentULO",
  }); 
});

app.use("/auth", userAuth);
app.use("/rental", rentalsRoute);
app.use("/notification", notificationRoute);
app.use('/counts', counts);
app.use('/progress', progressRoute);
app.use('/profile', profileRoute);
app.use('/report', reportRoute);
app.use('/search', searchRoute);


// DB CONNECTION
const PORT = process.env.PORT;

db.sync({ force: true, alter: false })
  .then(async () => {
    
    app.listen(PORT, () => {
      console.log(
        `Database connected successfully and Server running on PORT:${PORT}`
      );
    });
  })
  .catch((e) => {
    console.log(`Database connection failed:`, e);
  });

  