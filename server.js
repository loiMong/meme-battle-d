/**
 * Meme Battle server (single-folder)
 * - Serves static front from same folder
 * - Socket.IO realtime room state
 * - Host anonymity: memes are not sent in room-status during collect until revealed
 */
const path = require("path");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const PORT = process.env.PORT || 3000;

const app = express();
app.use(express.json({ limit: '2mb' }));
const server = http.createServer(app);


// --- Normalize TikTok/YouTube links (for embeds) ---
function extractTikTokId(url){
  try{
    const u = new URL(url);
    const m1 = u.pathname.match(/\/video\/(\d+)/);
    if(m1) return m1[1];
    const m2 = u.pathname.match(/\/embed\/v2\/(\d+)/);
    if(m2) return m2[1];
    const m3 = url.match(/video\/(\d+)/);
    if(m3) return m3[1];
    return null;
  }catch(e){
    const m = String(url||"").match(/video\/(\d+)/);
    return m ? m[1] : null;
  }
}

async function tryTikTokOEmbed(inputUrl, timeoutMs = 6000){
  // TikTok oEmbed: returns JSON with `html` that contains embed code with video id
  const api = "https://www.tiktok.com/oembed?url=" + encodeURIComponent(inputUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const r = await fetch(api, {
    headers: {
      "user-agent": "Mozilla/5.0",
      "accept": "application/json,text/plain,*/*"
    },
    signal: controller.signal
  });
  clearTimeout(timer);
  if(!r.ok) return null;
  const j = await r.json();
  const html = j && j.html ? String(j.html) : "";
  const m = html.match(/data-video-id=['"](\d+)['"]/) || html.match(/embed\/v2\/(\d+)/);
  const videoId = m ? m[1] : null;
  return { videoId, html };
}

app.post("/api/normalize-video-link", async (req, res) => {
  const inputUrl = String(req.body?.url || "").trim();
  try{
    if(!inputUrl) {
      return res.status(400).json({ ok:false, reason:"url is required" });
    }

    // Quick pass-through for non-http
    if(!/^https?:\/\//i.test(inputUrl)){
      return res.json({ ok:false, reason:"non-http url", finalUrl: inputUrl });
    }

    // TikTok
    if(/tiktok\.com/i.test(inputUrl)){
      let videoId = extractTikTokId(inputUrl);

      if (!videoId) {
        try{
          const o = await tryTikTokOEmbed(inputUrl);
          if (o?.videoId) videoId = o.videoId;
        }catch(e){
          return res.json({
            ok: false,
            reason: "oembed_failed",
            finalUrl: inputUrl
          });
        }
      }

      if (!videoId) {
        return res.json({
          ok: false,
          reason: "video_id_not_found",
          finalUrl: inputUrl
        });
      }

      return res.json({
        ok: true,
        videoId,
        embedUrl: `https://www.tiktok.com/embed/v2/${videoId}`
      });
    }

    // YouTube: nothing special needed (front-end embeds itself), just echo
    return res.json({ ok:false, reason:"not_tiktok", finalUrl: inputUrl });

  }catch(err){
    return res.status(500).json({ ok:false, reason: String(err?.message || err), finalUrl: inputUrl });
  }
});
// --- End normalize ---

app.use(express.static(path.join(__dirname, ".")));
app.get("/health", (req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

const io = new Server(server, {
  cors: { origin: "*" },
  transports: ["websocket", "polling"],
  maxHttpBufferSize: 12 * 1024 * 1024, // 12MB for base64 images/gifs
  pingInterval: 25000,
  pingTimeout: 20000,
});

function cbOk(cb, extra = {}) { if (typeof cb === "function") cb({ ok: true, ...extra }); }
function cbErr(cb, errorCode, errorText = "") {
  const error = errorText ? `${errorText} (${errorCode})` : errorCode;
  if (typeof cb === "function") cb({ ok: false, error, errorCode });
}
function normNick(s) {
  return String(s || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .slice(0, 24);
}
function randomCode(len = 4) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

const rooms = Object.create(null);

function createRoom(hostId) {
  let code = randomCode();
  while (rooms[code]) code = randomCode();
  rooms[code] = {
    code,
    hostId,
    phase: "lobby",      // lobby -> collect -> vote -> finished
    roundNumber: 0,
    task: "",
    locked: false,       // block new nicknames when game started
    memesRevealed: false,
    playersById: Object.create(null),
    nickIndex: Object.create(null),
    socketToPlayerId: Object.create(null),
    memes: [],           // {id,url,caption,ownerId,nickname,votes}
    updatedAt: Date.now(),
  };
  return code;
}
function getRoom(code) {
  const c = String(code || "").trim().toUpperCase();
  return rooms[c] || null;
}
function playersArray(room) {
  return Object.values(room.playersById).map(p => ({
    id: p.id,
    nickname: p.nickname,
    connected: !!p.connected,
    hasMeme: !!p.hasMeme,
    hasVoted: !!p.hasVoted,
  }));
}
function publicMemes(room) {
  // IMPORTANT: during collect and before reveal — do NOT send memes at all
  if (room.phase === "collect" && !room.memesRevealed) return [];
  return room.memes;
}
function broadcast(room) {
  io.to(room.code).emit("room-status", {
    roomCode: room.code,
    phase: room.phase,
    roundNumber: room.roundNumber,
    task: room.task,
    locked: !!room.locked,
    memesRevealed: !!room.memesRevealed,
    memesCount: room.memes.length,
    players: playersArray(room),
    memes: publicMemes(room),
  });
}
function ensureHost(room, socket, cb) {
  if (room.hostId !== socket.id) {
    cbErr(cb, "E_NOT_HOST", "Вы не ведущий");
    return false;
  }
  return true;
}
function getPlayer(room, socket) {
  const pid = room.socketToPlayerId[socket.id];
  if (!pid) return null;
  return room.playersById[pid] || null;
}
function checkAllMemesReady(room) {
  const active = Object.values(room.playersById).filter(p => p.connected);
  if (active.length === 0) return false;
  return active.every(p => p.hasMeme);
}

io.on("connection", (socket) => {
  socket.on("host-create-room", (cb) => {
    try {
      const roomCode = createRoom(socket.id);
      socket.join(roomCode);
      socket.data.roomCode = roomCode;
      socket.data.role = "host";
      cbOk(cb, { roomCode });
      broadcast(getRoom(roomCode));
    } catch {
      cbErr(cb, "E_CREATE_ROOM", "Не удалось создать комнату");
    }
  });

  socket.on("host-task-update", (payload, cb) => {
    try {
      const roomCode = String(payload?.roomCode || socket.data?.roomCode || "").trim().toUpperCase();
      const room = getRoom(roomCode);
      if (!room) return cbErr(cb, "E_ROOM_NOT_FOUND", "Комната не найдена");
      if (!ensureHost(room, socket, cb)) return;

      room.roundNumber = Number(payload?.roundNumber || 1);
      room.task = String(payload?.task || "");
      room.phase = "collect";
      room.locked = true;
      room.memesRevealed = false;
      room.memes = [];
      Object.values(room.playersById).forEach(p => { p.hasMeme = false; p.hasVoted = false; });
      room.updatedAt = Date.now();

      io.to(room.code).emit("round-task", { roomCode: room.code, roundNumber: room.roundNumber, task: room.task });
      cbOk(cb);
      broadcast(room);
    } catch {
      cbErr(cb, "E_TASK_UPDATE", "Ошибка обновления задания");
    }
  });

  socket.on("host-start-vote", (payload, cb) => {
    try{
      const roomCode = String(payload?.roomCode || socket.data?.roomCode || "").trim().toUpperCase();
      const room = getRoom(roomCode);
      if (!room) return cbErr(cb, "E_ROOM_NOT_FOUND", "Комната не найдена");
      if (!ensureHost(room, socket, cb)) return;
      if (room.phase !== "collect") return cbErr(cb, "E_WRONG_PHASE", "Голосование можно начать только во время сбора мемов");

      room.memesRevealed = true;  // reveal memes to host & players
      room.phase = "vote";
      room.updatedAt = Date.now();

      // ensure votes numbers
      room.memes = room.memes.map(m => ({ ...m, votes: Number(m.votes || 0) }));

      io.to(room.code).emit("voting-started", { roomCode: room.code, memes: room.memes });
      cbOk(cb);
      broadcast(room);
    }catch{
      cbErr(cb, "E_START_VOTE", "Ошибка запуска голосования");
    }
  });

  socket.on("player-join", (payload, cb) => {
    try {
      const roomCode = String(payload?.roomCode || "").trim().toUpperCase();
      const nicknameRaw = String(payload?.nickname || "").trim().slice(0, 24);
      if (!roomCode || !nicknameRaw) return cbErr(cb, "E_BAD_DATA", "Нужны код комнаты и ник");
      const room = getRoom(roomCode);
      if (!room) return cbErr(cb, "E_ROOM_NOT_FOUND", "Комната не найдена");

      const nn = normNick(nicknameRaw);
      const isRejoin = !!room.nickIndex[nn];
      const gameStarted = room.phase !== "lobby" || room.roundNumber > 0 || room.locked;

      if (gameStarted && !isRejoin) {
        return cbErr(cb, "E_ROOM_LOCKED", "Игра уже идёт. Новые игроки не могут войти.");
      }

      delete room.socketToPlayerId[socket.id];

      if (isRejoin) {
        const pid = room.nickIndex[nn];
        const p = room.playersById[pid];
        if (p) {
          p.connected = true;
          p.lastSeen = Date.now();
          room.socketToPlayerId[socket.id] = pid;
          socket.join(roomCode);
          socket.data.roomCode = roomCode;
          socket.data.role = "player";
          cbOk(cb, { rejoined: true, playerId: pid, roomCode, nickname: p.nickname, phase: room.phase, roundNumber: room.roundNumber, task: room.task });
          broadcast(room);
          return;
        }
      }

      const pid = "p_" + Math.random().toString(36).slice(2, 10);
      room.playersById[pid] = {
        id: pid,
        nickname: nicknameRaw,
        norm: nn,
        connected: true,
        lastSeen: Date.now(),
        hasMeme: false,
        hasVoted: false,
        score: 0,
      };
      room.nickIndex[nn] = pid;
      room.socketToPlayerId[socket.id] = pid;

      socket.join(roomCode);
      socket.data.roomCode = roomCode;
      socket.data.role = "player";

      cbOk(cb, { rejoined: false, playerId: pid, roomCode, nickname: nicknameRaw, phase: room.phase, roundNumber: room.roundNumber, task: room.task });
      broadcast(room);
    } catch {
      cbErr(cb, "E_JOIN", "Ошибка входа");
    }
  });

  socket.on("player-send-meme", (payload, cb) => {
    try {
      const roomCode = String(payload?.roomCode || socket.data?.roomCode || "").trim().toUpperCase();
      const room = getRoom(roomCode);
      if (!room) return cbErr(cb, "E_ROOM_NOT_FOUND", "Комната не найдена");
      if (room.phase !== "collect") return cbErr(cb, "E_WRONG_PHASE", "Сейчас нельзя отправлять мем");

      const p = getPlayer(room, socket);
      if (!p) return cbErr(cb, "E_NOT_IN_ROOM", "Вы не в комнате");

      const url = String(payload?.url || "").trim();
      const caption = String(payload?.caption || "").trim().slice(0, 140);
      if (!url) return cbErr(cb, "E_BAD_DATA", "Нужна ссылка или файл");

      room.locked = true;

      const idx = room.memes.findIndex(m => m.ownerId === p.id);
      const memeObj = {
        id: idx >= 0 ? room.memes[idx].id : `${Date.now()}_${Math.random().toString(16).slice(2)}`,
        url,
        caption,
        ownerId: p.id,
        nickname: p.nickname,
        votes: idx >= 0 ? Number(room.memes[idx].votes || 0) : 0,
      };
      if (idx >= 0) room.memes[idx] = memeObj; else room.memes.push(memeObj);

      p.hasMeme = true;
      room.updatedAt = Date.now();

      cbOk(cb);

      // If all connected players submitted — reveal memes on host screen (but do NOT start voting automatically)
      if (!room.memesRevealed && checkAllMemesReady(room)) {
        room.memesRevealed = true;
        io.to(room.hostId).emit("memes-ready", { roomCode: room.code, memesCount: room.memes.length });
      }

      broadcast(room);
    } catch {
      cbErr(cb, "E_MEME_SEND", "Не удалось отправить мем");
    }
  });

  socket.on("player-vote", (payload, cb) => {
    try {
      const roomCode = String(payload?.roomCode || socket.data?.roomCode || "").trim().toUpperCase();
      const memeId = String(payload?.memeId || "").trim();
      const room = getRoom(roomCode);
      if (!room) return cbErr(cb, "E_ROOM_NOT_FOUND", "Комната не найдена");
      if (room.phase !== "vote") return cbErr(cb, "E_VOTE_NOT_STARTED", "Голосование не началось");

      const p = getPlayer(room, socket);
      if (!p) return cbErr(cb, "E_NOT_IN_ROOM", "Вы не в комнате");
      if (p.hasVoted) return cbErr(cb, "E_ALREADY_VOTED", "Вы уже голосовали");

      const meme = room.memes.find(m => m.id === memeId);
      if (!meme) return cbErr(cb, "E_MEME_NOT_FOUND", "Мем не найден");
      if (meme.ownerId === p.id) return cbErr(cb, "E_VOTE_OWN_MEME", "Нельзя голосовать за свой мем");

      meme.votes = Number(meme.votes || 0) + 1;
      p.hasVoted = true;
      room.updatedAt = Date.now();

      cbOk(cb);
      broadcast(room);
    } catch {
      cbErr(cb, "E_VOTE", "Ошибка голосования");
    }
  });

  socket.on("host-final-results", (payload, cb) => {
    try {
      const roomCode = String(payload?.roomCode || socket.data?.roomCode || "").trim().toUpperCase();
      const room = getRoom(roomCode);
      if (!room) return cbErr(cb, "E_ROOM_NOT_FOUND", "Комната не найдена");
      if (!ensureHost(room, socket, cb)) return;

      const safe = Array.isArray(payload?.results) ? payload.results : [];
      const results = safe.map(r => ({
        nickname: String(r?.nickname || r?.name || "Игрок").trim(),
        score: Number(r?.score || 0) || 0,
      })).sort((a, b) => b.score - a.score);

      room.phase = "finished";
      room.updatedAt = Date.now();

      cbOk(cb, { results });
      io.to(room.code).emit("game-finished", { roomCode: room.code, results });
      broadcast(room);
    } catch {
      cbErr(cb, "E_FINAL_RESULTS", "Ошибка финальных результатов");
    }
  });

  socket.on("host-new-game", (payload, cb) => {
    try {
      const roomCode = String(payload?.roomCode || socket.data?.roomCode || "").trim().toUpperCase();
      const room = getRoom(roomCode);
      if (!room) return cbErr(cb, "E_ROOM_NOT_FOUND", "Комната не найдена");
      if (!ensureHost(room, socket, cb)) return;

      room.phase = "lobby";
      room.locked = false;
      room.roundNumber = 0;
      room.task = "";
      room.memes = [];
      room.memesRevealed = false;
      Object.values(room.playersById).forEach(p => { p.hasMeme = false; p.hasVoted = false; p.score = 0; });
      room.updatedAt = Date.now();

      cbOk(cb);
      io.to(room.code).emit("new-game", { roomCode: room.code });
      broadcast(room);
    } catch {
      cbErr(cb, "E_NEW_GAME", "Ошибка новой игры");
    }
  });

  socket.on("disconnect", () => {
    try {
      const roomCode = socket.data?.roomCode;
      const room = getRoom(roomCode);
      if (!room) return;

      if (room.hostId === socket.id) {
        io.to(room.code).emit("room-closed", { roomCode: room.code });
        delete rooms[room.code];
        return;
      }

      const pid = room.socketToPlayerId[socket.id];
      if (pid && room.playersById[pid]) {
        room.playersById[pid].connected = false;
        room.playersById[pid].lastSeen = Date.now();
      }
      delete room.socketToPlayerId[socket.id];
      broadcast(room);
    } catch {}
  });
});

server.listen(PORT, () => console.log(`[server] listening on ${PORT}`));
