const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const authenticateToken = require('../middlewares/auth.js');  

const JWT_SECRET = process.env.JWT_SECRET;

exports.createUser = async (req, res) => {
  const { user_name, account_name, password, email } = req.body;

  try {
    const hashedPassword = await bcrypt.hash(password, 10);

    const newUser = await prisma.user.create({
      data: {
        user_name,
        account_name,
        password: hashedPassword,
        email,
        registered_date: new Date(),
        latest_login: new Date(),
      },
    });

    res.status(201).json({ message: 'User created', user_id: newUser.user_id });
  } catch (error) {
    console.error('Error creating user:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

exports.loginUser = async (req, res) => {
  const { user_name, password } = req.body;

  try {
    const user = await prisma.user.findFirst({
      where: { user_name },
    });

    if (!user) {
      return res.status(404).json({ error: 'アカウントが見つかりません' });
    }

    const isPasswordValid = await bcrypt.compare(password, user.password);
    if (!isPasswordValid) {
      return res.status(401).json({ error: 'パスワードが違います' });
    }

    
    const token = jwt.sign({ user_id: user.user_id }, JWT_SECRET, { expiresIn: '24h' });

    // 最新ログイン時間更新
    await prisma.user.update({
      where: { user_id: user.user_id },
      data: { latest_login: new Date() },
    });

    res.status(200).json({
      message: 'ログイン成功',
      token,
      user: {
        user_id: user.user_id,
        user_name: user.user_name,
        account_name: user.account_name,
        email: user.email,
      },
    });
  } catch (error) {
    console.error('ログイン失敗:', error);
    res.status(500).json({ error: '内部エラーが発生しました' });
  }
};


exports.getProfile = async (req, res) => {
  try {
    const userId = req.user.user_id;

    const user = await prisma.user.findUnique({
      where: { user_id: userId },
      select: {
        user_id: true,
        user_name: true,
        account_name: true,
        email: true,
        total_win: true,
        correct_answer: true,
      },
    });

    if (!user) {
      return res.status(404).json({ error: 'ユーザーが見つかりません' });
    }

    res.json({ user });
  } catch (err) {
    console.error('プロフィール取得エラー:', err);
    res.status(500).json({ error: 'サーバーエラー' });
  }
};