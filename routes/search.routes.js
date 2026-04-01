const express = require('express');
const router = express.Router();

const { searchUsers } = require('../controllers/users.controller');
const { authMiddleware } = require('../middleware/authUserMiddleware');

router.get('/', authMiddleware, searchUsers);

module.exports = router;