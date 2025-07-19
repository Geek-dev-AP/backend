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

const matchStates = {};


io.on("connection", (socket) => {
  console.log("接続:", socket.id);

  // ルーム作成
  socket.on("createRoom", async (player_id) => {
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
      socket.join(`room_${room.match_id}`);
      socket.emit("roomCreated", { match_id: room.match_id });
    } catch (err) {
      socket.emit("roomCreateError", { error: err.message });
    }
  });

  // ルーム参加
  socket.on("joinRoom", async ({ match_id, player_id }) => {
    try {
      const room = await prisma.matchDetail.findUnique({
        where: { match_id },
        include: { player1: true },
      });

      if (!room) return socket.emit("roomJoinError", { error: "ルームが存在しません" });
      if (room.player_2_id) return socket.emit("roomJoinError", { error: "満員です" });

      await prisma.matchDetail.update({
        where: { match_id },
        data: { player_2_id: player_id, match_status: 1 }
      });

      const player2 = await prisma.user.findUnique({ where: { user_id: player_id } });

      socket.join(`room_${match_id}`);

      // 参加者全体に通知
      io.to(`room_${match_id}`).emit("matchReady", {
        player1: room.player1.user_name,
        player2: player2?.user_name || "Unknown"
      });

      socket.emit("roomJoined", { match_id, opponent_name: room.player1.user_name });
    } catch (err) {
      socket.emit("roomJoinError", { error: err.message });
    }
  });

  // ルーム状態取得
  socket.on("getRoomStatus", async (match_id) => {
    try {
      const room = await prisma.matchDetail.findUnique({
        where: { match_id },
        include: { player1: true, player2: true },
      });

      if (!room) return socket.emit("roomStatusError", { error: "見つかりません" });

      socket.emit("roomStatus", {
        player1: room.player1?.user_name || null,
        player2: room.player2?.user_name || null,
        status: room.match_status,
      });
    } catch (err) {
      socket.emit("roomStatusError", { error: err.message });
    }
  });

  // ランダムカード取得
  socket.on("getRandomCard", async () => {
    try {
      const all = await prisma.question.findMany({ select: { question_id: true } });
      if (all.length === 0) return socket.emit("cardError", { error: "質問がない" });

      const random = all[Math.floor(Math.random() * all.length)];
      socket.emit("getCardById", random.question_id);
    } catch (err) {
      socket.emit("cardError", { error: err.message });
    }
  });

  // 問題ID指定で取得
  socket.on("getCardById", async (questionId) => {
    try {
      const question = await prisma.question.findUnique({
        where: { question_id: questionId },
        include: {
          answer: { select: { option_id: true, option_text: true } },
          field: { select: { field_id: true, field_text: true } },
        },
      });

      if (!question) return socket.emit("cardError", { error: "見つかりません" });

      const others = await prisma.question.findMany({
        where: {
          field_id: question.field_id,
          question_id: { not: questionId },
        },
        include: {
          answer: { select: { option_id: true, option_text: true } },
        },
      });

      const shuffled = others.sort(() => 0.5 - Math.random()).slice(0, 3).map(q => q.answer);

      socket.emit("cardData", {
        question_id: question.question_id,
        question_text: question.question_text,
        field: question.field,
        correct_answer: question.answer,
        other_correct_answers: shuffled,
      });
    } catch (err) {
      socket.emit("cardError", { error: err.message });
    }
  });
});

socket.on("sendQuestion", ({ match_id, question }) => {
  // ルーム全体（自分＋相手）に1問だけ送信
  io.to(`room_${match_id}`).emit("questionReceived", question);
});


// 回答結果
socket.on("submitAnswer", async ({ match_id, user_id, isCorrect }) => {
  try {
    // 該当マッチの情報取得
    const match = await prisma.matchDetail.findUnique({ where: { match_id } });
    if (!match) return socket.emit("answerError", { error: "マッチが存在しません" });

    const updateUserStat = {
      total_answer: { increment: 1 },
      correct_answer: isCorrect ? { increment: 1 } : undefined,
      incorrect_answer: !isCorrect ? { increment: 1 } : undefined,
    };

    // ユーザー統計を更新
    await prisma.user.update({
      where: { user_id },
      data: updateUserStat,
    });

    // マッチ内のプレイヤーごとの正解数を更新
    if (match.player_1_id === user_id) {
      await prisma.matchDetail.update({
        where: { match_id },
        data: {
          player_1_correct: {
            increment: isCorrect ? 1 : 0,
          },
        },
      });
    } else if (match.player_2_id === user_id) {
      await prisma.matchDetail.update({
        where: { match_id },
        data: {
          player_2_correct: {
            increment: isCorrect ? 1 : 0,
          },
        },
      });
    }

    socket.emit("answerSubmitted", { match_id, user_id, isCorrect });
  } catch (err) {
    socket.emit("answerError", { error: err.message });
  }
});


// マッチ終了時
socket.on("endMatch", async ({ match_id }) => {
  try {
    const match = await prisma.matchDetail.findUnique({
      where: { match_id },
    });

    if (!match) return socket.emit("matchEndError", { error: "マッチが見つかりません" });

    const { player_1_correct = 0, player_2_correct = 0 } = match;

    let winner = null;
    let draw = false;

    if (player_1_correct > player_2_correct) {
      winner = match.player_1_id;
    } else if (player_2_correct > player_1_correct) {
      winner = match.player_2_id;
    } else {
      draw = true;
    }

    // マッチの結果更新
    await prisma.matchDetail.update({
      where: { match_id },
      data: {
        winner: winner,
        ended_at: new Date(),
        match_status: 2, 
      },
    });

    // ユーザー戦績を更新
    if (draw) {
      await prisma.user.updateMany({
        where: {
          user_id: { in: [match.player_1_id, match.player_2_id] },
        },
        data: {
          total_draw: { increment: 1 },
        },
      });
    } else {
      await prisma.user.update({
        where: { user_id: winner },
        data: { total_win: { increment: 1 } },
      });

      const loser = winner === match.player_1_id ? match.player_2_id : match.player_1_id;
      await prisma.user.update({
        where: { user_id: loser },
        data: { total_lose: { increment: 1 } },
      });
    }

    io.to(`room_${match_id}`).emit("matchEnded", {
      winner,
      draw,
      player_1_correct,
      player_2_correct,
    });
  } catch (err) {
    socket.emit("matchEndError", { error: err.message });
  }
});


// プレイヤーの戦績を管理するAPI
app.get("/api/user/:user_id/stats", async (req, res) => {
  const user_id = parseInt(req.params.user_id, 10);
  try {
    const user = await prisma.user.findUnique({
      where: { user_id },
      select: {
        user_id: true,
        user_name: true,
        total_win: true,
        total_lose: true,
        total_draw: true,
        total_answer: true,
        correct_answer: true,
        incorrect_answer: true,
      },
    });

    if (!user) return res.status(404).json({ error: "ユーザーが存在しません" });

    res.json(user);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
// // ルーム作成
// app.post("/rooms/create", async (req, res) => {
//   const { player_id } = req.body;

//   try {
//     const room = await prisma.matchDetail.create({
//       data: {
//         player_1_id: player_id,
//         match_status: 0,       
//         started_at: new Date(),
//         ended_at: new Date(),
//         player_2_id: null       
//       }
//     });

//     res.json({ match_id: room.match_id });

//   } catch (err) {
//     console.error("ルーム作成エラー:", err);
//     res.status(500).json({ error: "ルーム作成失敗", details: err.message });
//   }
// });

// // ルーム参加（QR読み取り後）
// app.post("/rooms/join", async (req, res) => {
//   const { match_id, player_id } = req.body;
//   try {
//     const room = await prisma.matchDetail.findUnique({
//       where: { match_id: match_id },
//       include: { player1: true },
//     });

//     if (!room) return res.status(404).json({ error: "ルームが存在しません" });
//     if (room.player_2_id)
//       return res.status(400).json({ error: "すでに2人参加済みです" });

//     const updated = await prisma.matchDetail.update({
//       where: { match_id: match_id },
//       data: {
//         player_2_id: player_id,
//         match_status: 1, // 対戦中
//       },
//     });

    
//     const player1 = room.player1;

//     // プレイヤー名取得
//     const player2 = await prisma.user.findUnique({
//       where: { user_id: player_id },
//     });

//     // 対戦相手へ通知
//     io.to(`room_${match_id}`).emit("matchReady", {
//       player1: player1.user_name,
//       player2: player2?.user_name || "Unknown",
//     });

//     res.json({
//       message: "joined",
//       opponent_name: player1.user_name,
//     });
//   } catch (err) {
//     console.error(err);
//     res.status(500).json({ error: "ルーム参加失敗" });
//   }
// });

// // ルーム状態確認
// app.get("/rooms/status/:match_id", async (req, res) => {
//   const match_id = parseInt(req.params.match_id);
//   try {
//     const room = await prisma.matchDetail.findUnique({
//       where: { match_id: match_id },
//       include: {
//         player1: true,
//         player2: true,
//       },
//     });

//     if (!room) return res.status(404).json({ error: "ルームが見つかりません" });

//     res.json({
//       player1: room.player1?.user_name || null,
//       player2: room.player2?.user_name || null,
//       status: room.match_status,
//     });
//   } catch (err) {
//     res.status(500).json({ error: "ステータス取得失敗" });
//   }
// });

// // ランダムなカード形式の問題取得
// app.get("/api/cards/random", async (req, res) => {
//   try {
//     // 全件取得してランダムに1つ選ぶ
//     const allQuestions = await prisma.question.findMany({
//       select: { question_id: true },
//     });

//     if (allQuestions.length === 0) {
//       return res.status(404).json({ error: "質問が存在しません" });
//     }

//     const random = allQuestions[Math.floor(Math.random() * allQuestions.length)];

//     // 既存の /api/cards/:questionId にリダイレクト
//     res.redirect(`/api/cards/${random.question_id}`);
//   } catch (error) {
//     console.error("ランダムカードの取得に失敗しました", error);
//     res.status(500).json({ error: "内部サーバーエラー" });
//   }
// });


// // カード形式の問題取得API
// app.get("/api/cards/:questionId", async (req, res) => {
//   const questionId = parseInt(req.params.questionId, 10);
//   if (isNaN(questionId)) {
//     return res.status(400).json({ error: "質問の番号がおかしいです" });
//   }

//   try {
//     const question = await prisma.question.findUnique({
//       where: { question_id: questionId },
//       include: {
//         answer: { select: { option_id: true, option_text: true } },
//         field: { select: { field_id: true, field_text: true } },
//       },
//     });

//     if (!question) {
//       return res.status(404).json({ error: "質問が見つかりません" });
//     }

//     const otherQuestions = await prisma.question.findMany({
//       where: {
//         field_id: question.field_id,
//         question_id: { not: questionId },
//       },
//       include: {
//         answer: { select: { option_id: true, option_text: true } },
//       },
//     });

//     // ランダムに3つ選ぶ
//     const shuffled = otherQuestions
//       .sort(() => 0.5 - Math.random())
//       .slice(0, 3)
//       .map(q => q.answer);

//     res.status(200).json({
//       question_id: question.question_id,
//       question_text: question.question_text,
//       field: {
//         field_id: question.field.field_id,
//         field_text: question.field.field_text,
//       },
//       correct_answer: question.answer,
//       other_correct_answers: shuffled,
//     });
//   } catch (error) {
//     console.error("カードの取得に失敗しました", error);
//     res.status(500).json({ error: "内部サーバーエラー" });
//   }
// });


// サーバー起動
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});
