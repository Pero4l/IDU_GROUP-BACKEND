const { config } = require('dotenv')
const multer = require('multer')
const path = require('path')

const upload = multer({
    storage: "/images"
})


app.post('/upload', upload.single('avatar'), (req, res) => {
    res.send('File uploaded successfully')
})

const config = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, 'images/')
    },
    filename: function (req, file, cb) {
        cb(null, `photo${Date.now()}${path.extname(file.originalname)}`)
    }
})