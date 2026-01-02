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

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || process.env.OPENAI_KEY || "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
// Replit can be a bit slow on first cold start; keep a generous timeout.
const OPENAI_TIMEOUT_MS = Number(process.env.OPENAI_TIMEOUT_MS || 25000);


const APP_VERSION = process.env.APP_VERSION || "0.1.3-beta";
const ADMIN_TOKEN = String(process.env.ADMIN_TOKEN || "dev").trim(); // ⚠️ поменяй в Secrets/ENV

const STARTED_AT = Date.now();
const adminTotals = {
  httpApiRequests: 0,
  roomsCreated: 0,
  playerJoins: 0,
  memesSubmitted: 0,
  votesCast: 0,
  errors: 0,
};
const ADMIN_EVENTS_MAX = 600;
const adminEvents = [];
function logAdmin(tag, detail, level = "info"){
  const e = { ts: new Date().toISOString(), tag: String(tag), level, detail };
  adminEvents.unshift(e);
  if(adminEvents.length > ADMIN_EVENTS_MAX) adminEvents.length = ADMIN_EVENTS_MAX;
}
function incTotal(k, n=1){ adminTotals[k] = (adminTotals[k]||0) + (Number(n)||0); }

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use((req,res,next)=>{ try{ if(String(req.path||"").startsWith("/api") || req.path==="/health") incTotal("httpApiRequests", 1); }catch(e){}; next(); });
const server = http.createServer(app);


// --- Normalize TikTok links to safe embed URLs (prevents net::ERR_BLOCKED_BY_RESPONSE in iframes) ---
async function doFetch(url, opts){
  if (typeof fetch === "function") return fetch(url, opts);
  const mod = await import("node-fetch");
  return mod.default(url, opts);
}

function extractTikTokId(url){
  const s = String(url || "");
  return (
    s.match(/\/video\/(\d{10,})/i)?.[1] ||
    s.match(/\/embed\/v2\/(\d{10,})/i)?.[1] ||
    s.match(/\/embed\/(\d{10,})/i)?.[1] ||
    s.match(/[?&](?:item_id|share_item_id|aweme_id)=(\d{10,})/i)?.[1] ||
    null
  );
}

function toTikTokEmbedFast(url){
  const id = extractTikTokId(url);
  return id ? `https://www.tiktok.com/embed/v2/${id}` : String(url || "");
}

async function tryTikTokOEmbed(inputUrl, timeoutMs = 6000){
  const api = "https://www.tiktok.com/oembed?url=" + encodeURIComponent(String(inputUrl || ""));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try{
    const r = await doFetch(api, {
      headers: {
        "user-agent": "Mozilla/5.0",
        "accept": "application/json,text/plain,*/*"
      },
      signal: controller.signal
    });
    if(!r.ok) return null;
    const j = await r.json();
    const html = j && j.html ? String(j.html) : "";
    const id = extractTikTokId(html);
    return id ? { videoId: id } : null;
  }catch(e){
    return null;
  }finally{
    clearTimeout(timer);
  }
}

async function resolveRedirect(url, timeoutMs = 6000){
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try{
    const r = await doFetch(String(url), {
      redirect: "follow",
      headers: { "user-agent": "Mozilla/5.0", "accept": "text/html,*/*" },
      signal: controller.signal
    });
    return r?.url || String(url);
  }catch(e){
    return String(url);
  }finally{
    clearTimeout(timer);
  }
}

app.post("/api/normalize-video-link", async (req, res) => {
  const inputUrl = String(req.body?.url || "").trim();
  try{
    if(!inputUrl) return res.status(400).json({ ok:false, reason:"url is required" });

    // Only TikTok is normalized here
    if(!/tiktok\.com/i.test(inputUrl)){
      return res.json({ ok:false, reason:"not_tiktok", inputUrl, finalUrl: inputUrl });
    }

    // 1) Fast path: already has id
    const fastId = extractTikTokId(inputUrl);
    if (fastId){
      return res.json({
        ok: true,
        inputUrl,
        finalUrl: inputUrl,
        videoId: fastId,
        embedUrl: `https://www.tiktok.com/embed/v2/${fastId}`
      });
    }

    // 2) oEmbed (works for vm/vt short links often)
    const o = await tryTikTokOEmbed(inputUrl);
    if (o?.videoId){
      return res.json({
        ok: true,
        inputUrl,
        finalUrl: inputUrl,
        videoId: o.videoId,
        embedUrl: `https://www.tiktok.com/embed/v2/${o.videoId}`
      });
    }

    // 3) Resolve redirect and try again
    const finalUrl = await resolveRedirect(inputUrl);
    const id = extractTikTokId(finalUrl);
    if(id){
      return res.json({
        ok: true,
        inputUrl,
        finalUrl,
        videoId: id,
        embedUrl: `https://www.tiktok.com/embed/v2/${id}`
      });
    }

    return res.json({ ok:false, reason:"video_id_not_found", inputUrl, finalUrl });
  }catch(err){
    return res.status(500).json({ ok:false, reason: String(err?.message || err) });
  }
});
// --- End normalize ---


// === AI Tasks (OpenAI) ===
// NOTE: API key must stay server-side (Replit Secret OPENAI_API_KEY).
// Uses the Responses API with Structured Outputs. See OpenAI docs: https://platform.openai.com/docs/api-reference/responses

function clampInt(n, min, max){
  n = Number(n);
  if(!Number.isFinite(n)) n = min;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}
function shuffle(arr){
  const a = arr.slice();
  for(let i=a.length-1;i>0;i--){
    const j = Math.floor(Math.random()*(i+1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function extractOutputText(resp){
  if(!resp) return "";
  if(typeof resp.output_text === "string" && resp.output_text) return resp.output_text;
  const out = resp.output;
  if(!Array.isArray(out)) return "";
  const parts = [];
  for(const item of out){
    const content = item && item.content;
    if(!Array.isArray(content)) continue;
    for(const c of content){
      if(c && typeof c.text === "string") parts.push(c.text);
    }
  }
  return parts.join("");
}
function cleanOneLine(s){
  return String(s || "")
    .replace(/\r?\n+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
function cutOneSentence(s, maxLen){
  let t = cleanOneLine(s);
  // remove leading bullets/numbers
  t = t.replace(/^[-–—•\d\.\)\s]+/, "").trim();
  // Keep only first sentence-ish if user gave multiple
  const m = t.match(/^(.+?[.!?…])\s+/);
  if(m && m[1]) t = m[1].trim();
  if(maxLen && t.length > maxLen){
    t = t.slice(0, maxLen-1).trimEnd() + "…";
  }
  return t;
}
function fallbackTasks(themes, rounds){
  const t = (themes && themes.length) ? themes : ["мемы", "повседневность"];
  const templates = [
    "Мем о том, как {T} внезапно становится слишком жизненным.",
    "Когда {T} идёт не по плану — покажи это мемом.",
    "Мем про «ожидание vs реальность» в {T}.",
    "Мем о моменте, когда {T} неожиданно побеждает здравый смысл.",
    "Когда ты пытаешься быть серьёзным, но {T} мешает — мем.",
    "Мем про самый неловкий поворот событий в {T}.",
    "Мем о том, как {T} выглядит со стороны.",
    "Когда {T} говорит «держи моё пиво» — мем.",
  ];
  const out = [];
  for(let i=0;i<rounds;i++){
    const theme = t[i % t.length];
    const tpl = templates[Math.floor(Math.random()*templates.length)];
    out.push(cutOneSentence(tpl.replace("{T}", theme), 140));
  }
  return out;
}

async function openaiGenerateTasks({ themes, rounds, humorLevel }){
  if(!OPENAI_API_KEY) throw new Error("E_NO_OPENAI_KEY");

  const want = clampInt(rounds + 3, rounds, rounds + 8);
  const safeThemes = (themes || []).map(cleanOneLine).filter(Boolean).slice(0, 50);

  const system = [
    "Ты — генератор заданий для игры «Мем‑баттл».",
    "Твоя цель: придумать короткие, НЕ слишком конкретные задания, чтобы у игроков был простор для фантазии.",
    "Каждое задание — ОДНО предложение на русском, без списков, без нумерации, без переносов строк.",
    "Не используй реальные имена людей, не упоминай конкретные бренды, не проси незаконное.",
    "Даже на жёстких уровнях избегай ненависти/травли/графического насилия/порнографии; допускается ирония, абсурд и «чёрный юмор» без таргета по защищённым группам.",
    "Стиль может напоминать Cards Against Humanity по дерзости и неожиданности, но НЕ копируй известные карточки дословно — только оригинальные идеи."
  ].join(" ");

  const user = [
    `Сгенерируй ${want} уникальных заданий.`,
    `Темы (подмешивай 1–2 темы в каждом задании): ${safeThemes.join(", ") || "любые"}.`,
    `Уровень юмора/абсурда (1–5): ${clampInt(humorLevel,1,5)}.`,
    `Правила: задания общие, максимум 140 символов, одно предложение.`,
    `Верни только JSON по схеме.`
  ].join("\n");

  const schema = {
    type: "object",
    additionalProperties: false,
    properties: {
      tasks: {
        type: "array",
        minItems: want,
        maxItems: want,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            text: { type: "string", description: "One-sentence meme prompt in Russian." },
            themes: { type: "array", minItems: 1, maxItems: 2, items: { type: "string" } }
          },
          required: ["text", "themes"]
        }
      }
    },
    required: ["tasks"]
  };

  const body = {
    model: OPENAI_MODEL,
    input: [
      { role: "system", content: system },
      { role: "user", content: user }
    ],
    temperature: 0.9,
    max_output_tokens: 900,
    store: false,
    text: {
      format: {
        type: "json_schema",
        name: "meme_tasks",
        strict: true,
        schema
      }
    }
  };


  async function callResponses(bodyObj){
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), OPENAI_TIMEOUT_MS);

    const resp = await doFetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${OPENAI_API_KEY}`
      },
      body: JSON.stringify(bodyObj),
      signal: controller.signal
    }).finally(() => clearTimeout(t));

    if(!resp.ok){
      const txt = await resp.text().catch(()=> "");
      const err = new Error("E_OPENAI_HTTP_" + resp.status);
      err.details = txt.slice(0, 1000);
      throw err;
    }

    const json = await resp.json();
    const rawText = extractOutputText(json);
    return { json, rawText };
  }

  let json, rawText;
  try{
    ({ json, rawText } = await callResponses(body));
  }catch(e){
    // Fallback: some models/accounts may not support json_schema. Retry with JSON mode.
    if(String(e?.message || "").startsWith("E_OPENAI_HTTP_400")){
      const body2 = JSON.parse(JSON.stringify(body));
      body2.text = { format: { type: "json_object" } };
      body2.input[0].content = system + " IMPORTANT: respond with a single JSON object only.";
      body2.input[1].content = user.replace("Верни только JSON по схеме.", "Верни JSON вида {\"tasks\":[{\"text\":\"...\"},{\"text\":\"...\"}]}.");
      ({ json, rawText } = await callResponses(body2));
    }else{
      throw e;
    }
  }

  let parsed = null;
  try{
    parsed = JSON.parse(rawText);
  }catch(e){
    const err = new Error("E_OPENAI_BAD_JSON");
    err.details = rawText.slice(0, 1000);
    throw err;
  }

  let tasks = [];
  if(Array.isArray(parsed?.tasks)){
    tasks = parsed.tasks.map(x => (typeof x === "string" ? x : x?.text)).filter(Boolean);
  }else if(Array.isArray(parsed)){
    tasks = parsed.map(x => (typeof x === "string" ? x : x?.text)).filter(Boolean);
  }
  tasks = tasks.map(s => cutOneSentence(s, 140)).filter(Boolean);

  // Unique + stable
  const seen = new Set();
  tasks = tasks.filter(s => { const k=s.toLowerCase(); if(seen.has(k)) return false; seen.add(k); return true; });
  if(tasks.length < rounds){
    tasks = tasks.concat(fallbackTasks(safeThemes, rounds - tasks.length));
  }
  tasks = shuffle(tasks).slice(0, rounds);

  const usage = json?.usage || null;
  return { tasks, usage, model: OPENAI_MODEL };

}
// === END AI TASKS ===

app.use(express.static(path.join(__dirname, ".")));
app.get("/health", (req, res) => res.json({ ok: true, ts: new Date().toISOString(), version: APP_VERSION, adminTokenConfigured: ADMIN_TOKEN !== "dev" }));
app.get("/api/version", (req, res) => res.json({ ok:true, version: APP_VERSION }));
const io = new Server(server, {
  cors: { origin: "*" },
  transports: ["websocket", "polling"],
  maxHttpBufferSize: 12 * 1024 * 1024, // 12MB for base64 images/gifs
  pingInterval: 25000,
  pingTimeout: 20000,
});

function cbOk(cb, extra = {}) { if (typeof cb === "function") cb({ ok: true, ...extra }); }
function cbErr(cb, errorCode, errorText = "", details = "", extra = {}) {
  try{ incTotal("errors", 1); logAdmin("error", { errorCode, errorText, details: details ? String(details).slice(0, 240) : "" }, "warn"); }catch(e){}
  const error = errorText ? `${errorText} (${errorCode})` : errorCode;
  if (typeof cb === "function") cb({ ok: false, error, errorCode, errorText, details: details ? String(details).slice(0, 1000) : "", ...extra });
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
    createdAt: Date.now(),
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


// ===== Admin API (token via header: x-admin-token) =====
function requireAdmin(req, res){
  const t = String(req.headers["x-admin-token"] || req.query.token || "").trim();
  if(!t || t !== ADMIN_TOKEN){
    res.status(401).json({ ok:false, error:"E_ADMIN_AUTH" });
    return false;
  }
  return true;
}

function roomSummary(room){
  const players = Object.values(room.playersById || {});
  const playersTotal = players.length;
  const playersOnline = players.filter(p => !!p.connected).length;
  const memesCount = Array.isArray(room.memes) ? room.memes.length : 0;
  return {
    code: room.code,
    phase: room.phase,
    roundNumber: room.roundNumber,
    playersTotal,
    playersOnline,
    memesCount,
    locked: !!room.locked,
    memesRevealed: !!room.memesRevealed,
    updatedAt: room.updatedAt || null,
    createdAt: room.createdAt || null,
    task: room.task ? String(room.task).slice(0, 140) : "",
  };
}

function roomDetail(room){
  const r = roomSummary(room);
  return {
    ...r,
    players: Object.values(room.playersById || {}).map(p => ({
      id: p.id,
      nickname: p.nickname,
      connected: !!p.connected,
      hasMeme: !!p.hasMeme,
      hasVoted: !!p.hasVoted,
      lastSeen: p.lastSeen || null,
      score: Number(p.score || 0),
    })),
    memes: (Array.isArray(room.memes) ? room.memes : []).map(m => ({
      id: m.id,
      nickname: m.nickname,
      caption: m.caption || "",
      votes: Number(m.votes || 0),
      ownerId: m.ownerId,
      urlPreview: String(m.url || "").startsWith("data:") ? "[data-url]" : String(m.url || "").slice(0, 220),
      submittedAt: m.submittedAt || null,
    })),
  };
}

// --- Sandbox data (для быстрой проверки админки, не трогает реальные комнаты)
const adminSandbox = { rooms: Object.create(null), updatedAt: Date.now() };

function sbRandomCode(){
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "SB";
  for(let i=0;i<2;i++) out += chars[Math.floor(Math.random()*chars.length)];
  return out;
}
function sbMakeRoom(players=4, memes=4){
  const code = sbRandomCode();
  const r = {
    code,
    phase: "collect",
    roundNumber: 1,
    task: "Sandbox: мем про баги",
    players: [],
    memes: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  for(let i=0;i<players;i++){
    r.players.push({
      id: "sbp" + i,
      nickname: "Bot_" + (i+1),
      connected: Math.random() > 0.2,
      hasMeme: i < memes,
      hasVoted: false,
      lastSeen: Date.now() - Math.floor(Math.random()*180000),
      score: 0,
    });
  }
  for(let i=0;i<memes;i++){
    r.memes.push({
      id: "sbm" + i,
      nickname: r.players[i % r.players.length]?.nickname || "Bot",
      caption: "sandbox meme " + (i+1),
      votes: Math.floor(Math.random()*5),
      urlPreview: "sandbox://meme/" + (i+1),
      submittedAt: Date.now() - Math.floor(Math.random()*180000),
    });
  }
  return r;
}

app.get("/api/admin/overview", (req, res) => {
  if(!requireAdmin(req, res)) return;

  const now = Date.now();
  const uptimeSec = Math.floor((now - STARTED_AT) / 1000);
  const roomsList = Object.values(rooms).map(roomSummary).sort((a,b)=> (Number(b.updatedAt||0)-Number(a.updatedAt||0)));
  const activeGames = roomsList.filter(r => r.phase === "collect" || r.phase === "vote").length;

  res.json({
    ok: true,
    version: APP_VERSION,
    serverTime: new Date().toISOString(),
    uptimeSec,
    socketsOnline: io.of("/").sockets.size,
    roomsActive: roomsList.length,
    gamesInProgress: activeGames,
    totals: adminTotals,
    rooms: roomsList.slice(0, 200),
    events: adminEvents.slice(0, 200),
    sandbox: {
      rooms: Object.values(adminSandbox.rooms).slice(0, 200),
      updatedAt: adminSandbox.updatedAt || null,
    }
  });
});

app.get("/api/admin/errors", (req, res) => {
  if(!requireAdmin(req, res)) return;

  const limitRaw = Number(req.query?.limit || 200);
  const limit = Math.max(1, Math.min(600, isFinite(limitRaw) ? limitRaw : 200));

  const errs = adminEvents.filter(e => String(e.tag) === "error").slice(0, limit);
  res.json({ ok:true, errors: errs, limit });
});


app.get("/api/admin/room/:code", (req, res) => {
  if(!requireAdmin(req, res)) return;
  const code = String(req.params.code || "").toUpperCase().trim();
  const room = rooms[code];
  if(!room) return res.status(404).json({ ok:false, error:"E_ROOM_NOT_FOUND" });
  res.json({ ok:true, room: roomDetail(room) });
});

app.post("/api/admin/sandbox/reset", (req, res) => {
  if(!requireAdmin(req, res)) return;
  adminSandbox.rooms = Object.create(null);
  adminSandbox.updatedAt = Date.now();
  res.json({ ok:true });
});

app.post("/api/admin/sandbox/generate", (req, res) => {
  if(!requireAdmin(req, res)) return;
  const roomsN = Math.max(1, Math.min(30, Number(req.body?.rooms || 3)));
  const playersN = Math.max(1, Math.min(20, Number(req.body?.players || 4)));
  const memesN = Math.max(0, Math.min(playersN, Number(req.body?.memes || 4)));

  adminSandbox.rooms = Object.create(null);
  for(let i=0;i<roomsN;i++){
    const r = sbMakeRoom(playersN, memesN);
    adminSandbox.rooms[r.code] = r;
  }
  adminSandbox.updatedAt = Date.now();
  res.json({ ok:true, rooms: Object.values(adminSandbox.rooms) });
});

app.get("/api/admin/sandbox/list", (req, res) => {
  if(!requireAdmin(req, res)) return;
  res.json({ ok:true, rooms: Object.values(adminSandbox.rooms), updatedAt: adminSandbox.updatedAt || null });
});

// --- Sandbox tools that affect REAL rooms (use carefully; intended for testing) ---
function sbEscapeXml(s){
  return String(s ?? "").replace(/[<>&'"]/g, ch => ({ "<":"&lt;", ">":"&gt;", "&":"&amp;", "'":"&#39;", '"':"&quot;" }[ch]));
}
function sbSvgDataUrl(label){
  const safe = sbEscapeXml(label);
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480">` +
    `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">` +
    `<stop offset="0%" stop-color="#111827"/><stop offset="100%" stop-color="#0b1220"/></linearGradient></defs>` +
    `<rect width="100%" height="100%" fill="url(#g)"/>` +
    `<text x="50%" y="44%" dominant-baseline="middle" text-anchor="middle" fill="#e5e7eb" font-size="34" font-family="system-ui, -apple-system, Segoe UI, Roboto, Arial">Sandbox</text>` +
    `<text x="50%" y="58%" dominant-baseline="middle" text-anchor="middle" fill="#93c5fd" font-size="28" font-family="system-ui, -apple-system, Segoe UI, Roboto, Arial">${safe}</text>` +
    `</svg>`;
  return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
}
function sbMakeBotNick(room, i){
  // ensure uniqueness inside room
  let nick = `Bot_${i}`;
  let nn = normNick(nick);
  let guard = 0;
  while(room.nickIndex[nn] && guard < 50){
    nick = `Bot_${i}_${Math.floor(Math.random()*99)}`;
    nn = normNick(nick);
    guard++;
  }
  return { nick, nn };
}

app.post("/api/admin/sandbox/real/add-bots", (req, res) => {
  if(!requireAdmin(req, res)) return;
  const roomCode = String(req.body?.roomCode || "").trim().toUpperCase();
  const room = getRoom(roomCode);
  if(!room) return res.status(404).json({ ok:false, error:"E_ROOM_NOT_FOUND" });

  const count = clampInt(req.body?.count ?? 2, 1, 20);
  const connected = !!req.body?.connected;

  let added = 0;
  for(let i=1;i<=count;i++){
    const { nick, nn } = sbMakeBotNick(room, i + added + Object.keys(room.playersById).length);
    const pid = "b_" + Math.random().toString(36).slice(2, 10);
    room.playersById[pid] = {
      id: pid,
      nickname: nick,
      norm: nn,
      connected,
      lastSeen: Date.now(),
      hasMeme: false,
      hasVoted: false,
      score: 0,
      bot: true,
    };
    room.nickIndex[nn] = pid;
    added++;
  }

  room.updatedAt = Date.now();
  logAdmin("sandbox_add_bots", { roomCode, added, connected });
  res.json({ ok:true, added, totalPlayers: Object.keys(room.playersById).length });
  broadcast(room);
});

app.post("/api/admin/sandbox/real/fill-memes", (req, res) => {
  if(!requireAdmin(req, res)) return;
  const roomCode = String(req.body?.roomCode || "").trim().toUpperCase();
  const room = getRoom(roomCode);
  if(!room) return res.status(404).json({ ok:false, error:"E_ROOM_NOT_FOUND" });

  const mode = String(req.body?.mode || "missing"); // missing | all | bots
  const overwrite = !!req.body?.overwrite;

  const players = Object.values(room.playersById);
  const selected = players.filter(p=>{
    if(mode === "bots") return !!p.bot;
    if(mode === "all") return true;
    return !p.hasMeme;
  });

  let created = 0, updated = 0;
  for(const p of selected){
    const existingIdx = room.memes.findIndex(m => m.ownerId === p.id);
    if(existingIdx >= 0 && !overwrite){
      if(!p.hasMeme) p.hasMeme = true;
      continue;
    }
    const memeObj = {
      id: "sbm_" + Math.random().toString(36).slice(2, 10),
      url: sbSvgDataUrl(p.nickname || "Bot"),
      caption: "sandbox meme",
      ownerId: p.id,
      nickname: p.nickname,
      votes: existingIdx >= 0 ? Number(room.memes[existingIdx].votes || 0) : 0,
      submittedAt: existingIdx >= 0 ? (room.memes[existingIdx].submittedAt || Date.now()) : Date.now(),
    };
    if(existingIdx >= 0){
      room.memes[existingIdx] = memeObj;
      updated++;
    }else{
      room.memes.push(memeObj);
      created++;
    }
    p.hasMeme = true;
  }

  // if all connected players have memes, reveal to allow quick testing
  if(!room.memesRevealed && checkAllMemesReady(room)){
    room.memesRevealed = true;
    io.to(room.hostId).emit("memes-ready", { roomCode: room.code, memesCount: room.memes.length });
  }

  room.updatedAt = Date.now();
  incTotal("memesSubmitted", created);
  logAdmin("sandbox_fill_memes", { roomCode, mode, created, updated, overwrite });
  res.json({ ok:true, created, updated, memesCount: room.memes.length });
  broadcast(room);
});

app.post("/api/admin/sandbox/real/reveal", (req, res) => {
  if(!requireAdmin(req, res)) return;
  const roomCode = String(req.body?.roomCode || "").trim().toUpperCase();
  const room = getRoom(roomCode);
  if(!room) return res.status(404).json({ ok:false, error:"E_ROOM_NOT_FOUND" });
  room.memesRevealed = true;
  room.updatedAt = Date.now();
  logAdmin("sandbox_reveal", { roomCode, memesCount: room.memes.length });
  res.json({ ok:true });
  broadcast(room);
});

app.post("/api/admin/sandbox/real/force-vote", (req, res) => {
  if(!requireAdmin(req, res)) return;
  const roomCode = String(req.body?.roomCode || "").trim().toUpperCase();
  const room = getRoom(roomCode);
  if(!room) return res.status(404).json({ ok:false, error:"E_ROOM_NOT_FOUND" });

  room.memesRevealed = true;
  room.phase = "vote";
  // normalize votes
  room.memes = room.memes.map(m => ({ ...m, votes: Number(m.votes || 0) }));
  room.updatedAt = Date.now();

  logAdmin("sandbox_force_vote", { roomCode, memesCount: room.memes.length });
  res.json({ ok:true });
  io.to(room.code).emit("voting-started", { roomCode: room.code, memes: room.memes });
  broadcast(room);
});

app.post("/api/admin/sandbox/real/auto-vote", (req, res) => {
  if(!requireAdmin(req, res)) return;
  const roomCode = String(req.body?.roomCode || "").trim().toUpperCase();
  const room = getRoom(roomCode);
  if(!room) return res.status(404).json({ ok:false, error:"E_ROOM_NOT_FOUND" });

  if(room.phase !== "vote"){
    return res.status(400).json({ ok:false, error:"E_WRONG_PHASE", message:"Комната должна быть в фазе vote" });
  }

  const memes = room.memes || [];
  let votes = 0;

  for(const p of Object.values(room.playersById)){
    if(!p.connected) continue;
    if(p.hasVoted) continue;

    const choices = memes.filter(m => m.ownerId !== p.id);
    if(choices.length === 0) continue;

    const pick = choices[Math.floor(Math.random() * choices.length)];
    pick.votes = Number(pick.votes || 0) + 1;
    p.hasVoted = true;
    votes++;
  }

  room.updatedAt = Date.now();
  incTotal("votesCast", votes);
  logAdmin("sandbox_auto_vote", { roomCode, votes });
  res.json({ ok:true, votes });
  broadcast(room);
});

app.post("/api/admin/sandbox/real/reset-round", (req, res) => {
  if(!requireAdmin(req, res)) return;
  const roomCode = String(req.body?.roomCode || "").trim().toUpperCase();
  const room = getRoom(roomCode);
  if(!room) return res.status(404).json({ ok:false, error:"E_ROOM_NOT_FOUND" });

  room.phase = "collect";
  room.locked = true;
  room.memesRevealed = false;
  room.memes = [];
  Object.values(room.playersById).forEach(p => { p.hasMeme = false; p.hasVoted = false; });
  room.updatedAt = Date.now();

  logAdmin("sandbox_reset_round", { roomCode });
  res.json({ ok:true });
  broadcast(room);
});

// ===== END Admin API =====

io.on("connection", (socket) => {
  socket.on("host-create-room", (cb) => {
    try {
      const roomCode = createRoom(socket.id);
      incTotal("roomsCreated", 1);
      logAdmin("room_created", { roomCode, hostId: socket.id });
      socket.join(roomCode);
      socket.data.roomCode = roomCode;
      socket.data.role = "host";
      cbOk(cb, { roomCode });
      broadcast(getRoom(roomCode));
    } catch {
      cbErr(cb, "E_CREATE_ROOM", "Не удалось создать комнату");
    }
  });


socket.on("host-generate-tasks", async (payload, cb) => {
  try{
    const roomCode = String(payload?.roomCode || "").toUpperCase().trim();
    const room = getRoom(roomCode);
    if(!room) return cbErr(cb, "E_NO_ROOM", "Комната не найдена");
    if(!ensureHost(room, socket, cb)) return;

    const rounds = clampInt(payload?.totalRounds ?? room.totalRounds ?? 5, 1, 20);
    const themes = Array.isArray(payload?.themes) ? payload.themes.map(cleanOneLine).filter(Boolean) : [];
    const humorLevel = clampInt(payload?.humorLevel ?? 3, 1, 5);

    if(themes.length === 0) return cbErr(cb, "E_NO_THEMES", "Нужно выбрать хотя бы одну тему");
    if(themes.length > rounds) return cbErr(cb, "E_TOO_MANY_THEMES", "Тем не должно быть больше, чем раундов");
    if(!OPENAI_API_KEY) return cbErr(cb, "E_NO_OPENAI_KEY", "На сервере не найден OPENAI_API_KEY");

    const result = await openaiGenerateTasks({ themes, rounds, humorLevel });

    room.totalRounds = rounds;
    room.ai = {
      enabled: true,
      themes,
      humorLevel,
      generatedAt: new Date().toISOString(),
      model: result.model,
      usage: result.usage || null,
      tasks: result.tasks
    };

    cbOk(cb, { tasks: result.tasks, usage: result.usage || null, model: result.model });
  }catch(e){
    // Surface real error codes to UI to make debugging possible.
    const code =
      (e?.name === "AbortError") ? "E_OPENAI_TIMEOUT" :
      (e && e.message) ? String(e.message) :
      "E_AI_FAIL";

    cbErr(cb, code, "Не удалось сгенерировать задания", e?.details || "", { model: OPENAI_MODEL });
    console.error("[AI_TASKS]", code, e?.details || e);
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
      logAdmin("round_task", { roomCode, roundNumber: room.roundNumber, task: String(room.task||"").slice(0, 140) });
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
      logAdmin("voting_started", { roomCode });
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
          incTotal("playerJoins", 1);
          logAdmin("player_join", { roomCode, nickname: p.nickname, playerId: pid, rejoined: true });
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
      incTotal("playerJoins", 1);
      logAdmin("player_join", { roomCode, nickname: nicknameRaw, playerId: pid, rejoined: false });
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

      let url = String(payload?.url || "").trim();
    // Normalize TikTok share links to embed URLs (fast, no network)
    url = toTikTokEmbedFast(url);
      const caption = String(payload?.caption || "").trim().slice(0, 140);
      if (!url) return cbErr(cb, "E_BAD_DATA", "Нужна ссылка или файл");

      room.locked = true;

      const idx = room.memes.findIndex(m => m.ownerId === p.id);
      const memeObj = {
        id: idx >= 0 ? room.memes[idx].id : `${Date.now()}_${Math.random().toString(16).slice(2)}`,
        url,
        caption,
        submittedAt: idx >= 0 ? (room.memes[idx].submittedAt || Date.now()) : Date.now(),
        ownerId: p.id,
        nickname: p.nickname,
        votes: idx >= 0 ? Number(room.memes[idx].votes || 0) : 0,
      };
      if (idx >= 0) room.memes[idx] = memeObj; else room.memes.push(memeObj);

      p.hasMeme = true;
      room.updatedAt = Date.now();

      cbOk(cb);
      incTotal("memesSubmitted", 1);
      logAdmin("meme_submitted", { roomCode, nickname: p.nickname, playerId: p.id });

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
      incTotal("votesCast", 1);
      logAdmin("vote", { roomCode, voter: p.nickname, memeId, ownerId: meme.ownerId });
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
      logAdmin("game_finished", { roomCode, resultsCount: results.length, top: results[0] || null });
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
      logAdmin("new_game", { roomCode });
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
