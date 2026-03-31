const express = require('express');
const router = express.Router();

const { register, login, searchUsers } = require('../controllers/users.controller');
const { loginMiddleware } = require('../middleware/loginMiddleware');
const { authMiddleware } = require('../middleware/authUserMiddleware');

router.post('/register', register);
router.post('/login', loginMiddleware, login); 
router.get('/', authMiddleware, searchUsers);

module.exports = router;