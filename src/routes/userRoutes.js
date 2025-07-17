const express = require('express');
const router = express.Router();
const userController = require('../controllers/userControllers.js');

// アカウント用
router.post('/', userController.createUser);
router.post('/login', userController.loginUser);