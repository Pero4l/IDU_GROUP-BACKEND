const dns = require("dns");
dns.setDefaultResultOrder("ipv4first");

const express = require("express");
const http = require("http");
require("dotenv").config();
const cors = require("cors");
const helmet = require("helmet");
const cookieParser = require("cookie-parser");
const xss = require("xss");
const socketConfig = require("./config/socket");

const app = express();
const server = http.createServer(app);
socketConfig.init(server);

// HTTPS enforcement (for platforms like Render/Heroku behind a proxy)
app.use((req, res, next) => {
  if (req.header("x-forwarded-proto") !== "https" && process.env.NODE_ENV === "production") {
    return res.redirect(301, `https://${req.header("host")}${req.url}`);
  }
  next();
});

// Security headers
app.use(helmet());

app.use(helmet());
app.use(cookieParser());
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: false, limit: "1mb" }));

const allowedOrigins = (process.env.ALLOWED_ORIGINS || "https://rentulo.ng,http://localhost:3000")
  .split(",")
  .map((o) => o.trim());

app.use(
  cors({
    origin: function (origin, callback) {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error("Not allowed by CORS"));
      }
    },
    origin: [
      "https://rentulo.ng",
      "https://www.rentulo.ng",
      // "https://rentulo.com",
      // "https://www.rentulo.com",
      "http://localhost:3000",
      // "http://localhost:5173",
      // "http://localhost:5174"
    ],
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
  }),
);

// Basic XSS sanitization middleware for string values in request body
app.use((req, res, next) => {
  if (req.body && typeof req.body === "object") {
    for (const key of Object.keys(req.body)) {
      if (typeof req.body[key] === "string") {
        req.body[key] = xss(req.body[key]);
      }
    }
  }
  if (req.query && typeof req.query === "object") {
    for (const key of Object.keys(req.query)) {
      if (typeof req.query[key] === "string") {
        req.query[key] = xss(req.query[key]);
      }
    }
  }
  next();
});

const db = require("./models");

const userAuth = require("./routes/user.routes");
const rentalsRoute = require("./routes/rental.routes");
const notificationRoute = require("./routes/notification.routes");
const counts = require("./routes/allCount.routes");
const progressRoute = require("./routes/progress.routes");
const profileRoute = require("./routes/profile.routes");
const reportRoute = require("./routes/report.routes");
const searchRoute = require("./routes/search.routes");
const superAdminRoute = require("./routes/superAdmin.routes");
const chatRoute = require("./routes/chat.routes");
const inspectionRoute = require("./routes/inspection.routes");
const subscriptionRoute = require("./routes/subscribe.routes");
const testimonialRoutes = require("./routes/testimonials.routes");

app.get("/", (req, res) => {
  res.status(200).json({
    message: "Welcome to RentULO",
  });
});

app.use("/auth", userAuth);
app.use("/rental", rentalsRoute);
app.use("/notification", notificationRoute);
app.use("/counts", counts);
app.use("/progress", progressRoute);
app.use("/profile", profileRoute);
app.use("/report", reportRoute);
app.use("/search", searchRoute);
app.use("/admin", superAdminRoute);
app.use("/chat", chatRoute);
app.use("/inspection", inspectionRoute);
app.use("/subscriptions", subscriptionRoute);
app.use("/api/testimonials", testimonialRoutes);

app.use((err, req, res, next) => {
  console.error(err);
  const status = err.status || 400;
  res.status(status).json({
    success: false,
    message: err.message || "Something went wrong",
  });
});

// DB CONNECTION
const PORT = process.env.PORT;

// db.sync({ force: true, alter: false })
//   .then(async () => {

db.sequelize
  .authenticate()
  .then(() => {
    server.listen(PORT, () => {
      console.log(
        `Database connected successfully and Server running on PORT:${PORT}`,
      );
    });
  })
  .catch((e) => {
    console.log(`Database connection failed:`, e);
  });
