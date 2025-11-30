const jwt = require('jsonwebtoken')

async function authMiddleware(req, res, next) {
    const authHeader = req.headers['authorization']

    if(!authHeader){
        return res.status(403).json({
            "sucess": false,
            "message": "No token provided"
        })
    }

    const token = authHeader.split(' ')[1]


    try{
        const decode = jwt.verify(token, process.env.JWT_SECRET)
        req.user = decode
        next()
    } catch (err){
        res.status(401).json({
             "sucess": false,
            "message": "Invalid or expired token"
        })
    }
}


module.exports = {authMiddleware}