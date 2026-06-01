const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');


const express = require('express');
const http = require('http');
require('dotenv').config();
const cors = require("cors");
const cookieParser = require('cookie-parser');
const socketConfig = require('./config/socket');

const app = express();
const server = http.createServer(app);
socketConfig.init(server);


app.use(cookieParser());
app.use(express.json());
app.use(cors({
  origin: true,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Origin', 'X-Requested-With', 'Content-Type', 'Accept', 'Authorization'],
}));
app.use(express.urlencoded({ extended: true }));

const db = require("./models");

const userAuth = require('./routes/user.routes');
const rentalsRoute = require('./routes/rental.routes');
const notificationRoute = require('./routes/notification.routes');
const counts = require('./routes/allCount.routes');
const progressRoute = require('./routes/progress.routes');
const profileRoute = require('./routes/profile.routes');
const reportRoute = require('./routes/report.routes');
const searchRoute = require('./routes/search.routes');
const superAdminRoute = require('./routes/superAdmin.routes');
const chatRoute = require('./routes/chat.routes');
const waitlistRoute = require('./routes/waitlist.routes');

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
app.use('/admin', superAdminRoute);
app.use('/chat', chatRoute);
app.use('/waitlist', waitlistRoute);



// DB CONNECTION
const PORT = process.env.PORT;

// db.sync({ force: true, alter: false })
//   .then(async () => {
    

db.sequelize.authenticate()
  .then(() => {
    server.listen(PORT, () => {
      console.log(
        `Database connected successfully and Server running on PORT:${PORT}`
      );
    });
  })
  .catch((e) => {
    console.log(`Database connection failed:`, e);
  });

