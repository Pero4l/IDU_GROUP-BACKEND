const express = require('express');

require('dotenv').config();

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const db = require("./config/db");

const userAuth = require('./routes/user.routes');
const rentalsRoute = require('./routes/rental.routes');

app.use("/auth", userAuth);
app.use("/auth", rentalsRoute);


// DB CONNECTION
const PORT = process.env.PORT;

db.sync({ force: false, alter: false })
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