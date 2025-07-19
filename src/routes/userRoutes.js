const express = require('express');
const router = express.Router();
const userController = require('../controllers/userControllers.js');
const authenticateToken = require('../middlewares/auth.js');

// アカウント用
router.post('/create', userController.createUser);
router.post('/login', userController.loginUser);
router.get('/profile', authenticateToken, userController.getProfile);

module.exports = router;