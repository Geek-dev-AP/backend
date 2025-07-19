require("dotenv").config();
const express = require("express");
const http = require("http");
const cors = require("cors");

const app = express();

const prisma = require("./prismaclient.js");
const server = http.createServer(app);
const io = require("socket.io")(server, {
  cors: {
    origin: "*", // テスト環境用
  },
});


app.use(cors());
app.use(express.json());

// Socket.IO 処理
io.on("connection", (socket) => {
  console.log("接続:", socket.id);

  // ルーム参加
  socket.on("joinRoom", (roomId) => {
    socket.join(`room_${roomId}`);
    console.log(`Socket ${socket.id} joined room_${roomId}`);
  });
});

// ルーム作成
app.post("/rooms/create", async (req, res) => {
  const { player_id } = req.body;

  try {
    const room = await prisma.matchDetail.create({
      data: {
        player_1_id: player_id,
        match_status: 0,       
        started_at: new Date(),
        ended_at: new Date(),
        player_2_id: null       
      }
    });

    res.json({ match_id: room.match_id });

  } catch (err) {
    console.error("ルーム作成エラー:", err);
    res.status(500).json({ error: "ルーム作成失敗", details: err.message });
  }
});

// ルーム参加（QR読み取り後）
app.post("/rooms/join", async (req, res) => {
  const { match_id, player_id } = req.body;
  try {
    const room = await prisma.matchDetail.findUnique({
      where: { match_id: match_id },
      include: { player1: true },
    });

    if (!room) return res.status(404).json({ error: "ルームが存在しません" });
    if (room.player_2_id)
      return res.status(400).json({ error: "すでに2人参加済みです" });

    const updated = await prisma.matchDetail.update({
      where: { match_id: match_id },
      data: {
        player_2_id: player_id,
        match_status: 1, // 対戦中
      },
    });

    
    const player1 = room.player1;

    // プレイヤー名取得
    const player2 = await prisma.user.findUnique({
      where: { user_id: player_id },
    });

    // 対戦相手へ通知
    io.to(`room_${match_id}`).emit("matchReady", {
      player1: player1.user_name,
      player2: player2?.user_name || "Unknown",
    });

    res.json({
      message: "joined",
      opponent_name: player1.user_name,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "ルーム参加失敗" });
  }
});

// ルーム状態確認
app.get("/rooms/status/:match_id", async (req, res) => {
  const match_id = parseInt(req.params.match_id);
  try {
    const room = await prisma.matchDetail.findUnique({
      where: { match_id: match_id },
      include: {
        player1: true,
        player2: true,
      },
    });

    if (!room) return res.status(404).json({ error: "ルームが見つかりません" });

    res.json({
      player1: room.player1?.user_name || null,
      player2: room.player2?.user_name || null,
      status: room.match_status,
    });
  } catch (err) {
    res.status(500).json({ error: "ステータス取得失敗" });
  }
});


// カード形式の問題取得API
app.get("/api/cards/:questionId", async (req, res) => {
  const questionId = parseInt(req.params.questionId, 10);
  if (isNaN(questionId)) {
    return res.status(400).json({ error: "質問の番号がおかしいです" });
  }

  try {
    const question = await prisma.question.findUnique({
      where: { question_id: questionId },
      include: {
        answer: { select: { option_id: true, option_text: true } },
        field: { select: { field_id: true, field_text: true } },
      },
    });

    if (!question) {
      return res.status(404).json({ error: "質問が見つかりません" });
    }

    const otherQuestions = await prisma.question.findMany({
      where: {
        field_id: question.field_id,
        question_id: { not: questionId },
      },
      include: {
        answer: { select: { option_id: true, option_text: true } },
      },
    });

    // ランダムに3つ選ぶ
    const shuffled = otherQuestions
      .sort(() => 0.5 - Math.random())
      .slice(0, 3)
      .map(q => q.answer);

    res.status(200).json({
      question_id: question.question_id,
      question_text: question.question_text,
      field: {
        field_id: question.field.field_id,
        field_text: question.field.field_text,
      },
      correct_answer: question.answer,
      other_correct_answers: shuffled,
    });
  } catch (error) {
    console.error("カードの取得に失敗しました", error);
    res.status(500).json({ error: "内部サーバーエラー" });
  }
});


// サーバー起動
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});
