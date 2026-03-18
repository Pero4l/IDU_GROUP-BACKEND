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
const counts = require('./routes/allCount.routes')

app.get("/", (req, res) => {
  res.status(200).json({
    message: "Welcome to RentULO",
  }); 
});

app.use("/auth", userAuth);
app.use("/rentals", rentalsRoute);
app.use("/notification", notificationRoute);
app.use('/counts', counts);


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

  