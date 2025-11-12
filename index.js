const express = require('express');

require('dotenv').config();

const app = express();

app.get("/", (req, res) =>{
    res.status(200).json({
        "success": false,
        "message": "WELCOME TO IDU_GROUP"
    })
});

const PORT = process.env.PORT || 5500

app.listen(PORT, ()=>{
    console.log(`Server running on port ${PORT}`);
})