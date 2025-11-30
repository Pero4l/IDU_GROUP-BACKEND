const express = require('express');

require('dotenv').config();

const app = express();

const db = require("./config/db");

app.get("/", (req, res) =>{
    res.status(200).json({
        "success": false,
        "message": "WELCOME TO IDU_GROUP"
    })
});




// DB CONNECTION
const PORT = process.env.PORT || 5500

db.sync({ force: false, alter: false })
  .then(async () => {
    
    app.listen(PORT, () => {
      console.log(
        `✅ Database connected successfully and Server running on PORT:${PORT}`
      );
    });
  })
  .catch((e) => {
    console.log(`❌ Database connection failed:`, e);
  });