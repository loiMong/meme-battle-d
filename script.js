/* Meme Battle фронт (анонимность мемов на экране хоста до reveal/голосования) */

const SERVER_URL = window.location.origin;

const $ = (id) => document.getElementById(id);



/* === Media helpers: render without cropping; different approach for YT vs TikTok === */
function detectMediaType(url){
  const u = String(url || "").trim();
  if(!u) return { type: "empty" };

  // Data URLs
  if(u.startsWith("data:")){
    const head = u.slice(0, 60).toLowerCase();
    if(head.includes("video/")) return { type: "video_data" };
    if(head.includes("image/")) return { type: "image_data" };
    return { type: "data" };
  }

  // YouTube
  if(/(youtube\.com|youtu\.be)/i.test(u)){
    const isShorts = /\/shorts\//i.test(u);
    // Extract id
    let id = "";
    const m1 = u.match(/[?&]v=([^&]+)/i);
    const m2 = u.match(/youtu\.be\/([^?&#/]+)/i);
    const m3 = u.match(/\/shorts\/([^?&#/]+)/i);
    const m4 = u.match(/\/embed\/([^?&#/]+)/i);
    id = (m1 && m1[1]) || (m2 && m2[1]) || (m3 && m3[1]) || (m4 && m4[1]) || "";
    if(id) id = id.split(/[?&#]/)[0];
    return { type: "youtube", id, isShorts };
  }

  // TikTok
  if(/tiktok\.com/i.test(u)){
    // Try to get numeric video id from /video/123...
    const m1 = u.match(/\/video\/(\d+)/i);
    const m2 = u.match(/\/embed\/v2\/(\d+)/i);
    const m3 = u.match(/\/embed\/(\d+)/i);
    const id = (m1 && m1[1]) || (m2 && m2[1]) || (m3 && m3[1]) || "";
    return { type: "tiktok", id, url: u };
  }

  // File extensions
  if(/\.(mp4|webm|ogg)(\?|#|$)/i.test(u)) return { type: "video_url" };
  if(/\.(gif)(\?|#|$)/i.test(u)) return { type: "gif_url" };
  if(/\.(png|jpe?g|webp)(\?|#|$)/i.test(u)) return { type: "image_url" };

  // Default: treat as image-ish url
  return { type: "url", url: u };
}

function renderMediaHTML(url){
  const info = detectMediaType(url);

  if(info.type === "empty"){
    return `<div class="muted">—</div>`;
  }

  // YouTube: responsive wrapper by ratio, no crop
  if(info.type === "youtube"){
    const ratio = info.isShorts ? "9 / 16" : "16 / 9";
    const src = info.id ? `https://www.youtube.com/embed/${info.id}?rel=0&modestbranding=1` : "";
    if(!src) return `<div class="muted">Некорректная ссылка YouTube</div>`;
    return `
      <div class="mediaFrame ytFrame" style="aspect-ratio:${ratio}">
        <iframe src="${src}" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" allowfullscreen></iframe>
      </div>
    `;
  }

  // TikTok: per-device crop/zoom profiles (see DEBUG panel)
  if (meta.type === "tiktok") {
    return `
      <div class="mediaFrame ttFrame">
        <div class="ttViewport">
          <iframe
            src="${meta.embedUrl}"
            loading="lazy"
            allowfullscreen
            referrerpolicy="no-referrer-when-downgrade"
            allow="autoplay; encrypted-media"
          ></iframe>
        </div>
      </div>
    `;
  }


  // Video (uploaded as data URL or direct url): do not crop, keep contain
  if(info.type === "video_data" || info.type === "video_url"){
    return `
      <div class="mediaFrame">
        <video src="${String(url)}" controls playsinline></video>
      </div>
    `;
  }

  // Images/GIF: do not crop
  if(info.type.startsWith("image") || info.type.endsWith("_url") || info.type === "data" || info.type === "url"){
    return `
      <div class="mediaFrame">
        <img src="${String(url)}" alt="meme"/>
      </div>
    `;
  }

  return `
    <div class="mediaFrame">
      <a href="${String(url)}" target="_blank" rel="noopener">Открыть</a>
    </div>
  `;
}
/* === End media helpers === */

const LS_NICK = "mb_nick";
const LS_ROOM = "mb_room";

function now() { return new Date().toLocaleTimeString(); }
function safeJson(x){ try{ return JSON.stringify(x); } catch{ return String(x); } }

function pushDebug(tag, detail){
  const body = $("debug-body");
  if(!body) return;
  const row = document.createElement("div");
  row.className = "dbg";
  row.innerHTML = `<span class="t">[${now()}]</span> <b>${tag}</b> <span class="d">${typeof detail === "string" ? detail : safeJson(detail)}</span>`;
  body.prepend(row);
}
async 
// ===== TikTok player profiles (per-device) =====
const LS_TT = "tt_profiles_v1";
const LS_TT_MODE = "tt_video_only_v1";
const LS_TT_FORCED = "tt_forced_profile_v1";

const TT_DEFAULTS = {
  desktop:         { cropX: 0, zoom: 1.30, x: 6,  y: -2, cropBottom: 0 },
  mobilePortrait:  { cropX: 0, zoom: 1.00, x: 0,  y: 0,  cropBottom: 0 },
  mobileLandscape: { cropX: 0, zoom: 1.00, x: 0,  y: 0,  cropBottom: 0 }
};

function cloneTTDefaults(){
  return {
    desktop: { ...TT_DEFAULTS.desktop },
    mobilePortrait: { ...TT_DEFAULTS.mobilePortrait },
    mobileLandscape: { ...TT_DEFAULTS.mobileLandscape }
  };
}

function loadTTProfiles(){
  try{
    const raw = localStorage.getItem(LS_TT);
    if(!raw) return cloneTTDefaults();
    const data = JSON.parse(raw);
    return {
      desktop:         { ...TT_DEFAULTS.desktop,         ...(data.desktop||{}) },
      mobilePortrait:  { ...TT_DEFAULTS.mobilePortrait,  ...(data.mobilePortrait||{}) },
      mobileLandscape: { ...TT_DEFAULTS.mobileLandscape, ...(data.mobileLandscape||{}) }
    };
  }catch(e){
    return cloneTTDefaults();
  }
}

function saveTTProfiles(p){ localStorage.setItem(LS_TT, JSON.stringify(p)); }

function loadVideoOnly(){
  const raw = localStorage.getItem(LS_TT_MODE);
  if(raw === null) return true; // default ON
  return raw === "1";
}
function saveVideoOnly(v){ localStorage.setItem(LS_TT_MODE, v ? "1" : "0"); }

let ttProfiles = loadTTProfiles();
let ttVideoOnly = loadVideoOnly();

function autoTTProfileKey(){
  const w = window.innerWidth || 1024;
  const isPortrait = window.matchMedia && window.matchMedia("(orientation: portrait)").matches;
  const isMobile = w <= 820; // heuristic
  if(!isMobile) return "desktop";
  return isPortrait ? "mobilePortrait" : "mobileLandscape";
}

function getActiveTTProfileKey(){
  return localStorage.getItem(LS_TT_FORCED) || autoTTProfileKey();
}

function applyTTVars(){
  const key = getActiveTTProfileKey();
  const p = ttProfiles[key] || TT_DEFAULTS.desktop;
  const root = document.documentElement;

  root.style.setProperty("--tt-crop-x", `${p.cropX||0}px`);
  root.style.setProperty("--tt-crop-bottom", `${p.cropBottom||0}px`);
  root.style.setProperty("--tt-zoom", String(p.zoom||1));
  root.style.setProperty("--tt-x", `${p.x||0}px`);
  root.style.setProperty("--tt-y", `${p.y||0}px`);

  root.classList.toggle("tt-video-only", !!ttVideoOnly);

  const active = $("tt-active");
  if(active){
    active.textContent = `Активный: ${key} | cropX:${p.cropX||0}px | zoom:${Number(p.zoom||1).toFixed(2)} | x:${p.x||0}px | y:${p.y||0}px | низ:${p.cropBottom||0}px`;
  }
}

function bindTTControls(){
  const elMode = $("tt-video-only");
  const elProfile = $("tt-profile");
  if(!elProfile || !elMode){
    applyTTVars();
    return;
  }

  elMode.checked = !!ttVideoOnly;

  // init profile selector (forced or auto)
  elProfile.value = getActiveTTProfileKey();

  function setVal(id, v){
    const out = $(id + "-val");
    if(out) out.textContent = String(v);
  }

  function syncUIFromProfile(key){
    const p = ttProfiles[key] || TT_DEFAULTS.desktop;

    $("tt-crop-x").value = String(p.cropX||0);
    $("tt-zoom").value = String(p.zoom||1);
    $("tt-x").value = String(p.x||0);
    $("tt-y").value = String(p.y||0);
    $("tt-crop-bottom").value = String(p.cropBottom||0);

    setVal("tt-crop-x", p.cropX||0);
    setVal("tt-zoom", Number(p.zoom||1).toFixed(2));
    setVal("tt-x", p.x||0);
    setVal("tt-y", p.y||0);
    setVal("tt-crop-bottom", p.cropBottom||0);
  }

  syncUIFromProfile(elProfile.value);

  elMode.addEventListener("change", () => {
    ttVideoOnly = !!elMode.checked;
    saveVideoOnly(ttVideoOnly);
    applyTTVars();
  });

  elProfile.addEventListener("change", () => {
    const key = elProfile.value;
    localStorage.setItem(LS_TT_FORCED, key);
    syncUIFromProfile(key);
    applyTTVars();
  });

  function onSlider(id, field, format){
    const input = $(id);
    if(!input) return;
    input.addEventListener("input", () => {
      const key = elProfile.value;
      const p = ttProfiles[key] || (ttProfiles[key] = { ...TT_DEFAULTS[key] });
      const val = (field === "zoom") ? Number(input.value) : Number(input.value);
      p[field] = val;
      saveTTProfiles(ttProfiles);
      setVal(id, format ? format(val) : val);
      applyTTVars();
    });
  }

  onSlider("tt-crop-x", "cropX");
  onSlider("tt-zoom", "zoom", (v)=>Number(v).toFixed(2));
  onSlider("tt-x", "x");
  onSlider("tt-y", "y");
  onSlider("tt-crop-bottom", "cropBottom");

  $("tt-reset")?.addEventListener("click", () => {
    const key = elProfile.value;
    ttProfiles[key] = { ...TT_DEFAULTS[key] };
    saveTTProfiles(ttProfiles);
    syncUIFromProfile(key);
    applyTTVars();
  });

  $("tt-copy")?.addEventListener("click", async () => {
    try{
      const data = {
        videoOnly: ttVideoOnly,
        forcedProfile: localStorage.getItem(LS_TT_FORCED) || null,
        profiles: ttProfiles
      };
      await navigator.clipboard.writeText(JSON.stringify(data, null, 2));
      alert("Настройки скопированы в буфер обмена");
    }catch(e){
      alert("Не удалось скопировать. Открой DEBUG и скопируй вручную.");
    }
  });

  // keep in sync on resize/orientation
  window.addEventListener("resize", () => applyTTVars());
  if(window.matchMedia){
    try{
      window.matchMedia("(orientation: portrait)").addEventListener("change", () => applyTTVars());
    }catch(e){}
  }

  applyTTVars();
}
// ===== END TikTok profiles =====

async function normalizeVideoLink(inputUrl){ // PATCH: TikTok normalize
  const rawUrl = String(inputUrl || "").trim();
  if(!rawUrl) return { url: rawUrl };
  pushDebug("normalize-link", { in: rawUrl });
  try{
    if (/(youtube\.com|youtu\.be)/i.test(rawUrl)) {
      const info = detectMediaType(rawUrl);
      if (info.type === "youtube" && info.id) {
        return { url: `https://www.youtube.com/embed/${info.id}?rel=0&modestbranding=1` };
      }
      return { url: rawUrl };
    }
    if (!/tiktok\.com/i.test(rawUrl)) {
      return { url: rawUrl };
    }
    const res = await fetch("/api/normalize-video-link", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: rawUrl }),
    });
    const data = await res.json();
    const normalized = data?.embedUrl || data?.finalUrl || data?.browserUrl || rawUrl;
    pushDebug("normalize-link", { ok: data?.ok, out: normalized, id: data?.videoId || "" });
    return { url: normalized, data };
  }catch(e){
    pushDebug("normalize-link", { error: String(e) });
    return { url: rawUrl, error: e };
  }
}
function setDebug(open){ $("debug-panel")?.classList.toggle("hidden", !open); }
$("debug-toggle")?.addEventListener("click", () => setDebug($("debug-panel")?.classList.contains("hidden")));
$("debug-close")?.addEventListener("click", () => setDebug(false));
if (new URLSearchParams(location.search).get("debug") === "1") setDebug(true);
  bindTTControls();


// -------- Screen switching
const screens = ["mode","host","player"].reduce((acc,k)=>{
  acc[k] = $(`screen-${k}`);
  return acc;
}, {});
function showScreen(name){
  Object.entries(screens).forEach(([k,el])=>{
    if(!el) return;
    el.classList.toggle("hidden", k !== name);
  });
  pushDebug("screen", name);
}
$("btn-mode-host")?.addEventListener("click", () => showScreen("host"));
$("btn-mode-player")?.addEventListener("click", () => showScreen("player"));

// -------- Socket
const socket = (typeof io === "function")
  ? io(SERVER_URL, { transports: ["websocket","polling"] })
  : { on:()=>{}, emit:()=>{} };

if (typeof io !== "function"){
  pushDebug("socket.io missing", "Не загрузился /socket.io/socket.io.js");
  setDebug(true);
}

function setPill(id, ok){
  const el = $(id);
  if(!el) return;
  el.textContent = ok ? "online" : "offline";
  el.classList.toggle("ok", !!ok);
  el.classList.toggle("bad", !ok);
}

socket.on("connect", () => {
  pushDebug("socket", { event:"connect", id: socket.id });
  setPill("host-conn", true);
  setPill("player-conn", true);

  // auto-rejoin for player if we have session and player screen visible
  const room = localStorage.getItem(LS_ROOM) || "";
  const nick = localStorage.getItem(LS_NICK) || "";
  if (room && nick && !playerState.joined && !screens.player?.classList.contains("hidden")){
    joinRoom(room, nick, true);
  }
});
socket.on("disconnect", (r) => {
  pushDebug("socket", { event:"disconnect", reason: r });
  setPill("host-conn", false);
  setPill("player-conn", false);
});

// -------- Shared state
let currentRoom = "";
let hostState = { totalRounds: 5, tasks: [], round: 0, scores: {} };
let playerState = { joined: false, playerId: "", nickname: "", roomCode: "" };

let hostLatestMemes = [];
let hostMemesCount = 0;
let hostMemesRevealed = false;
let hostPhase = "lobby";

// -------- Host UI
function hostSetRoom(code){
  currentRoom = code;
  $("host-room-code").textContent = code || "—";
  const link = `${location.origin}/?room=${encodeURIComponent(code)}`;
  $("host-room-link").textContent = link;
}
$("host-copy-link")?.addEventListener("click", async () => {
  const link = $("host-room-link").textContent || "";
  try{ await navigator.clipboard.writeText(link); pushDebug("copy", "ok"); }catch(e){ pushDebug("copy", String(e)); }
});
$("host-create-room")?.addEventListener("click", () => {
  socket.emit("host-create-room", (res) => {
    pushDebug("host-create-room", res);
    if(!res?.ok) return alert(res?.error || "Ошибка");
    hostSetRoom(res.roomCode);
    $("host-start-game").disabled = false;
    $("host-end-game").disabled = false;
  });
});

function parseTasks(){
  const total = Number($("host-total-rounds").value || 5);
  const raw = String($("host-tasks").value || "");
  const tasks = raw.split("\n").map(s=>s.trim()).filter(Boolean);
  hostState.totalRounds = Math.max(1, Math.min(20, total));
  hostState.tasks = tasks;
}
function getTaskForRound(n){
  if (hostState.tasks.length === 0) return `Раунд ${n}`;
  return hostState.tasks[(n-1) % hostState.tasks.length];
}
function hostUpdateRoundInfo(){
  $("host-round-info").textContent = hostState.round ? `Раунд: ${hostState.round} / ${hostState.totalRounds}` : "Раунд: —";
}
function ensureRoom(){
  if(!currentRoom){ alert("Сначала создай комнату"); return false; }
  return true;
}

$("host-start-game")?.addEventListener("click", () => {
  if(!ensureRoom()) return;
  parseTasks();
  hostState.round = 1;
  hostState.scores = {};
  hostUpdateRoundInfo();
  renderResults();

  const task = getTaskForRound(hostState.round);
  socket.emit("host-task-update", { roomCode: currentRoom, roundNumber: hostState.round, task }, (res)=>{
    pushDebug("host-task-update", res);
    if(!res?.ok) return alert(res?.error || "Ошибка");
    $("host-next-round").disabled = false;
    $("host-end-game").disabled = false;
    $("host-start-vote").disabled = true;
  });
});

$("host-start-vote")?.addEventListener("click", () => {
  if(!ensureRoom()) return;
  if (hostPhase !== "collect") return alert("Голосование можно начать только во время сбора мемов.");
  socket.emit("host-start-vote", { roomCode: currentRoom }, (res)=>{
    pushDebug("host-start-vote", res);
    if(!res?.ok) return alert(res?.error || "Ошибка");
    $("host-start-vote").disabled = true;
  });
});

function computeRoundPoints(memelist){
  const points = {};
  if(!Array.isArray(memelist) || memelist.length===0) return { points };
  memelist.forEach(m=>{
    const nick = m.nickname || "Игрок";
    const votePts = Number(m.votes||0) * 10;
    points[nick] = (points[nick]||0) + votePts;
  });
  // +20% bonus to unique winner
  let max = -1;
  memelist.forEach(m => { max = Math.max(max, Number(m.votes||0)); });
  const winners = memelist.filter(m => Number(m.votes||0) === max);
  if (winners.length === 1){
    const w = winners[0];
    const nick = w.nickname || "Игрок";
    const winVotePts = Number(w.votes||0) * 10;
    const bonus = Math.round(winVotePts * 0.2);
    points[nick] = (points[nick]||0) + bonus;
  }
  return { points };
}
function addPointsToScores(points){
  Object.entries(points).forEach(([nick, pts])=>{
    hostState.scores[nick] = (hostState.scores[nick]||0) + (Number(pts)||0);
  });
}
function renderResults(){
  const list = Object.entries(hostState.scores)
    .map(([nickname, score])=>({ nickname, score }))
    .sort((a,b)=>b.score-a.score);
  const box = $("host-results");
  box.innerHTML = "";
  if(list.length===0){ box.innerHTML = `<div class="muted">Пока нет очков.</div>`; return; }
  const max = list[0].score;
  list.forEach((r)=>{
    const el = document.createElement("div");
    el.className = "res" + (r.score===max ? " win" : "");
    el.innerHTML = `<b>${r.nickname}</b><span>${r.score}</span>`;
    box.appendChild(el);
  });
}

$("host-next-round")?.addEventListener("click", () => {
  if(!ensureRoom()) return;

  // add points from current memes (only if they were revealed)
  if (hostLatestMemes.length > 0){
    const { points } = computeRoundPoints(hostLatestMemes);
    addPointsToScores(points);
    renderResults();
  }

  if (hostState.round >= hostState.totalRounds){
    const results = Object.entries(hostState.scores).map(([nickname, score])=>({ nickname, score }));
    socket.emit("host-final-results", { roomCode: currentRoom, results }, (res)=> pushDebug("host-final-results", res));
    $("host-next-round").disabled = true;
    $("host-end-game").disabled = true;
    $("host-start-vote").disabled = true;
    $("host-new-game").classList.remove("hidden");
    return;
  }

  hostState.round += 1;
  hostUpdateRoundInfo();
  const task = getTaskForRound(hostState.round);
  socket.emit("host-task-update", { roomCode: currentRoom, roundNumber: hostState.round, task }, (res)=>{
    pushDebug("host-task-update", res);
    if(!res?.ok) alert(res?.error || "Ошибка");
  });
});

$("host-end-game")?.addEventListener("click", () => {
  if(!ensureRoom()) return;
  const results = Object.entries(hostState.scores).map(([nickname, score])=>({ nickname, score }));
  socket.emit("host-final-results", { roomCode: currentRoom, results }, (res)=>{
    pushDebug("host-final-results", res);
    $("host-next-round").disabled = true;
    $("host-end-game").disabled = true;
    $("host-start-vote").disabled = true;
    $("host-new-game").classList.remove("hidden");
  });
});

$("host-new-game")?.addEventListener("click", () => {
  if(!ensureRoom()) return;
  if(!confirm("Начать новую игру в этой комнате? Очки будут сброшены.")) return;

  socket.emit("host-new-game", { roomCode: currentRoom }, (res)=>{
    pushDebug("host-new-game", res);
    if(!res?.ok) return alert(res?.error || "Ошибка");
    hostState.round = 0;
    hostState.scores = {};
    renderResults();
    hostUpdateRoundInfo();
    $("host-new-game").classList.add("hidden");
    $("host-next-round").disabled = true;
    $("host-end-game").disabled = false;
    $("host-start-vote").disabled = true;
    showScreen("mode");
  });
});

// -------- Player UI
const urlRoom = new URLSearchParams(location.search).get("room") || "";
$("player-room").value = (urlRoom || localStorage.getItem(LS_ROOM) || "").toUpperCase();
$("player-nick").value = (localStorage.getItem(LS_NICK) || "");
$("player-room")?.addEventListener("input", () => $("player-room").value = $("player-room").value.toUpperCase());
$("player-nick")?.addEventListener("change", () => {
  const v = $("player-nick").value.trim().slice(0,24);
  $("player-nick").value = v;
  if(v) localStorage.setItem(LS_NICK, v);
});

function joinRoom(room, nick, silent=false){
  const roomCode = String(room||"").trim().toUpperCase();
  const nickname = String(nick||"").trim().slice(0,24);
  if(!roomCode || !nickname){
    if(!silent) $("player-join-status").textContent = "Нужен код комнаты и ник";
    return;
  }
  socket.emit("player-join", { roomCode, nickname }, (res)=>{
    pushDebug("player-join", res);
    if(!res?.ok){ $("player-join-status").textContent = res?.error || "Ошибка"; return; }
    playerState.joined = true;
    playerState.playerId = res.playerId || "";
    playerState.nickname = res.nickname || nickname;
    playerState.roomCode = roomCode;
    localStorage.setItem(LS_NICK, playerState.nickname);
    localStorage.setItem(LS_ROOM, roomCode);
    $("player-join-status").textContent = res.rejoined ? "✅ Возврат в игру" : "✅ Вошёл";
    if (res.task) $("player-task").textContent = res.task;
    $("player-sent").classList.add("hidden");
    $("player-voted").classList.add("hidden");
  });
}
$("player-join")?.addEventListener("click", () => joinRoom($("player-room").value, $("player-nick").value));

async function fileToDataUrl(file){
  return new Promise((resolve, reject)=>{
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result||""));
    fr.onerror = () => reject(fr.error || new Error("File read error"));
    fr.readAsDataURL(file);
  });
}
$("player-send-meme")?.addEventListener("click", async () => {
  if(!playerState.joined){ $("player-join-status").textContent = "Сначала войди в комнату"; return; }
  const file = $("player-meme-file").files?.[0] || null;
  let url = "";
  if(file){
    if(file.size > 8 * 1024 * 1024){ alert("Файл слишком большой. Лимит ~8MB."); return; }
    url = await fileToDataUrl(file);
  }else{
    url = String($("player-meme-url").value || "").trim();
    const normalized = await normalizeVideoLink(url); // PATCH: TikTok normalize
    url = normalized.url || url; // PATCH: TikTok normalize
  }
  const caption = String($("player-meme-caption").value || "").trim();
  socket.emit("player-send-meme", { roomCode: playerState.roomCode, url, caption }, (res)=>{
    pushDebug("player-send-meme", res);
    if(!res?.ok){ alert(res?.error || "Ошибка отправки"); return; }
    $("player-sent").classList.remove("hidden");
  });
});

// -------- Live updates
socket.on("memes-ready", (p) => {
  // only host cares
  if (p?.roomCode === currentRoom){
    pushDebug("memes-ready", p);
    // memes are now revealed on host screen (still collect), enable "start vote"
    $("host-start-vote").disabled = false;
  }
});

socket.on("room-status", (st) => {
  // host view
  if (st?.roomCode && st.roomCode === currentRoom){
    hostPhase = st.phase || "—";
    hostMemesCount = Number(st.memesCount || 0);
    hostMemesRevealed = !!st.memesRevealed;
    $("host-phase").textContent = `Фаза: ${st.phase || "—"}`;

    // players list with indicators
    const box = $("host-players");
    if (box){
      box.innerHTML = "";
      (st.players||[]).forEach(p=>{
        const el = document.createElement("div");
        el.className = "pl";
        const s1 = p.connected ? "" : `<span class="offline">(offline)</span>`;
        const s2 = p.hasMeme ? "✅ мем" : "… мем";
        const s3 = p.hasVoted ? "✅ голос" : "… голос";
        el.innerHTML = `<div><b>${p.nickname}</b> ${s1}</div><div class="st">${s2} • ${s3}</div>`;
        box.appendChild(el);
      });
    }

    // IMPORTANT: host should NOT see memes during collect until revealed
    hostLatestMemes = Array.isArray(st.memes) ? st.memes : [];
    const memesBox = $("host-memes");
    if (memesBox){
      memesBox.innerHTML = "";
      if (st.phase === "collect" && !st.memesRevealed){
        memesBox.innerHTML = `<div class="muted">Мемы скрыты до начала голосования. Получено мемов: <b>${hostMemesCount}</b></div>`;
      } else if (hostLatestMemes.length === 0){
        memesBox.innerHTML = `<div class="muted">Мемов пока нет.</div>`;
      } else {
        hostLatestMemes.forEach(m=>{
          const el = document.createElement("div");
          el.className = "meme";
          el.innerHTML = `
            ${renderMediaHTML(m.url)}
            <div class="cap">${m.caption ? m.caption : ""}</div>
            <div class="meta"><span>${m.nickname||""}</span><b>${Number(m.votes||0)} 👍</b></div>
          `;
          memesBox.appendChild(el);
        });
      }
    }

    // "Start vote" button visibility/enable
    if ($("host-start-vote")){
      const canShow = (st.phase === "collect");
      $("host-start-vote").classList.toggle("hidden", !canShow);
      // enable if at least 1 meme exists (early start) OR all ready event already fired (memesRevealed true)
      $("host-start-vote").disabled = !(hostMemesCount > 0);
      if (st.phase === "collect" && st.memesRevealed) $("host-start-vote").disabled = false;
    }
  }

  // player view task
  if (playerState.joined && st?.roomCode === playerState.roomCode){
    if (st.task) $("player-task").textContent = st.task;
  }
});

socket.on("round-task", (p) => {
  if (playerState.joined && p?.roomCode === playerState.roomCode){
    $("player-task").textContent = p.task || "—";
    $("player-sent").classList.add("hidden");
    $("player-voted").classList.add("hidden");
    $("player-meme-url").value = "";
    $("player-meme-caption").value = "";
    $("player-meme-file").value = "";
  }
  if (p?.roomCode === currentRoom){
    $("host-phase").textContent = "Фаза: collect";
    if ($("host-start-vote")) { $("host-start-vote").classList.remove("hidden"); $("host-start-vote").disabled = true; }
  }
});

socket.on("voting-started", ({ roomCode, memes }) => {
  if (playerState.joined && roomCode === playerState.roomCode){
    const box = $("player-vote");
    box.innerHTML = "";
    $("player-voted").classList.add("hidden");

    (memes||[]).forEach(m=>{
      const el = document.createElement("div");
      el.className = "meme";
      const btn = document.createElement("button");
      btn.className = "primary";
      btn.textContent = "Голосовать";
      btn.addEventListener("click", ()=>{
        socket.emit("player-vote", { roomCode: playerState.roomCode, memeId: m.id }, (res)=>{
          pushDebug("player-vote", res);
          if(!res?.ok) return alert(res?.error || "Ошибка");
          $("player-voted").classList.remove("hidden");
          box.querySelectorAll("button").forEach(b=>b.disabled=true);
        });
      });
      el.innerHTML = `${renderMediaHTML(m.url)}<div class="cap">${m.caption||""}</div>`;
      el.appendChild(btn);
      box.appendChild(el);
    });
  }
});

socket.on("game-finished", ({ roomCode, results }) => {
  const list = Array.isArray(results) ? results : [];
  if (roomCode === currentRoom){
    $("host-new-game").classList.remove("hidden");
    hostState.scores = {};
    list.forEach(r=> hostState.scores[r.nickname] = r.score );
    renderResults();
    $("host-start-vote")?.classList.add("hidden");
  }
  if (playerState.joined && roomCode === playerState.roomCode){
    const box = $("player-final");
    box.innerHTML = "";
    if (list.length===0){ box.innerHTML = `<div class="muted">Игра завершена.</div>`; return; }
    list.forEach(r=>{
      const el = document.createElement("div");
      el.className = "res";
      el.innerHTML = `<b>${r.nickname}</b><span>${r.score}</span>`;
      box.appendChild(el);
    });
  }
});

socket.on("room-closed", ({ roomCode }) => {
  if (roomCode === currentRoom || roomCode === playerState.roomCode){
    alert("Комната закрыта (ведущий вышел).");
    location.href = location.origin;
  }
});

// Start on mode screen
showScreen("mode");
