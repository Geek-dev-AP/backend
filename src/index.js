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

// サーバー起動
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});
