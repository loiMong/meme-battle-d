/* Meme Battle фронт (анонимность мемов на экране хоста до reveal/голосования) */

/* =====================================================================
   [MB-ANCHORS] Frontend quick map (поиск по файлу)
   - [ANCHOR] MB:F:AI
   - [ANCHOR] MB:F:MEDIA
   - [ANCHOR] MB:F:SCREENS
   - [ANCHOR] MB:F:DEBUG
   - [ANCHOR] MB:F:HOST_SETUP
   - [ANCHOR] MB:F:HOST_ROUND
   - [ANCHOR] MB:F:HOST_VOTING
   - [ANCHOR] MB:F:WINNER_OVERLAY
   - [ANCHOR] MB:F:PLAYER
   - [ANCHOR] MB:F:ADMIN
   - [ANCHOR] MB:F:SOCKET:ROOM_STATUS / ROUND_TASK / VOTING_*
   ===================================================================== */


const SERVER_URL = window.location.origin;


// [ANCHOR] MB:F:DEBUG_TOGGLE — single switch for client-side debug logs/panel
// Set DEBUG=false to disable pushDebug() noise.
let DEBUG = true;


// TikTok calibration video (used in Admin mode preview)
const CALIBRATION_TIKTOK_URL = "https://www.tiktok.com/@prokendol112/video/7508817190636752146?is_from_webapp=1&sender_device=pc&web_id=7584888569203066390";


// [ANCHOR] MB:F:AI — generation UI + state
// === AI tasks presets ===
const AI_PRESET_THEMES = [
  "Anime", "Movies", "Games", "Office", "Pets", "Food",
  "Sports", "Music", "Travel", "Technology", "Art", "History",
  "Science", "Nature", "Fashion", "Cooking", "Fitness", "Books",
  "Comedy", "Horror", "Romance", "Mystery", "Fantasy", "SciFi",
  "Superheroes", "Zombies", "Pirates", "Ninjas", "Robots", "Aliens",
  "Medieval", "Western", "Cyberpunk", "Steampunk", "Space", "Ocean",
  "Dinosaurs", "Magic", "School", "Work", "Family", "Friends"
];

let aiState = {
  enabled: false,
  edgeLevel: 2,
  selectedThemes: [],
  customThemes: [],
  lastGenerated: [],
  lastUsage: null,
  lastModel: null,
};

const $ = (id) => document.getElementById(id);

// [ANCHOR] MB:F:DOM:DELEGATE — event delegation helpers (фикс кликов для элементов, которые идут после <script>)
function delegateClick(selector, handler){
  document.addEventListener("click", (ev) => {
    const t = ev.target;
    if(!t || !t.closest) return;
    const el = t.closest(selector);
    if(!el) return;
    try{ handler(ev, el); }catch(e){}
  });
}

// Small helper for +/- buttons around range inputs
function nudgeRange(id, delta, min, max){
  const el = $(id);
  if(!el) return;
  const cur = Number(el.value);
  const next = Math.max(min, Math.min(max, cur + delta));
  el.value = String(next);
  el.dispatchEvent(new Event("input", { bubbles:true }));
}




// [ANCHOR] MB:F:MEDIA — detect/render YouTube/TikTok/images/video
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
    // Support many share formats:
    // - https://www.tiktok.com/@user/video/123...
    // - https://www.tiktok.com/embed/v2/123...
    // - ...?item_id=123...
    const id =
      (u.match(/\/video\/(\d{10,})/i)?.[1]) ||
      (u.match(/\/embed\/v2\/(\d{10,})/i)?.[1]) ||
      (u.match(/\/embed\/(\d{10,})/i)?.[1]) ||
      (u.match(/[?&](?:item_id|share_item_id|aweme_id)=(\d{10,})/i)?.[1]) ||
      "";
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
  // TikTok: ALWAYS render as embed (normal TikTok pages are blocked in iframes on mobile)
  if(info.type === "tiktok"){
    let inIframe = false;
    try{ inIframe = window.self !== window.top; }catch(e){ inIframe = true; }
    pushDebug("render:tiktok", { in: String(url||""), id: info.id || null, parsedUrl: info.url || "", inIframe });
    if(!info.id){
      const href = String(info.url || "");
      pushDebug("render:tiktok:no_id", { href, reason: "no_video_id_in_url" });
      return `
        <div class="mediaFrame">
          <div class="muted">TikTok: встроить не удалось</div>
          ${inIframe ? `<div class="muted" style="margin-top:6px">⚠️ В режиме Preview/встроенного браузера TikTok часто блокируется. Открой страницу в обычном браузере.</div>` : ``}
          <a class="ghost" href="${href}" target="_blank" rel="noopener">Открыть в TikTok</a>
        </div>
      `;
    }
    const src = `https://www.tiktok.com/embed/v2/${info.id}`;
    pushDebug("render:tiktok:embed", { src });
    return `
      <div class="mediaFrame ttFrame" data-mb-tt="1">
        <div class="ttViewport">
          <iframe
            src="${src}"
            data-mb-iframe="tiktok"
            data-mb-src="${src}"
            scrolling="no"
            referrerpolicy="no-referrer-when-downgrade"
            allow="encrypted-media; picture-in-picture; autoplay"
            allowfullscreen
            onload="window.__mbDbgOnIframeLoad && window.__mbDbgOnIframeLoad(this)"
            onerror="window.__mbDbgOnIframeError && window.__mbDbgOnIframeError(this)"
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

  // AUDIO: keep simple
  if(info.type === "audio_data" || info.type === "audio_url"){
    return `
      <div class="mediaFrame">
        <audio src="${String(url)}" controls></audio>
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
const LS_HOST_ROOM = "mb_host_room";
const LS_HOST_TOKEN = "mb_host_token";
const LS_PLAYER_CARD = "mb_player_card_v1";

function now() { return new Date().toLocaleTimeString(); }
function safeJson(x){ try{ return JSON.stringify(x); } catch{ return String(x); } }

function dbgValueShort(v){
  const s = String(v ?? "");
  if (s.startsWith("data:")) {
    return { kind: "data", len: s.length, head: s.slice(0, 48) + "..." };
  }
  return { kind: "url", len: s.length, head: s.slice(0, 200) + (s.length > 200 ? "..." : "") };
}

function escapeHtml(s){
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

// [ANCHOR] MB:F:RENDER_MEME_HTML — supports text-only memes
function renderMemeHTML(m){
  try{
    if(m && typeof m.text === 'string' && m.text.trim()){
      const safe = escapeHtml(String(m.text)).replace(/\n/g,'<br>');
      return `<div class="textMeme"><div class="textMemeInner">${safe}</div></div>`;
    }
  }catch(e){}
  return renderMediaHTML(m && m.url ? m.url : '');
}


// ===== Debug log store (so you can copy diagnostics) =====
const DBG_MAX = 400;
window.__MB_DBG = window.__MB_DBG || [];

// [ANCHOR] MB:F:DEBUG_TIMELINE — server timeline (host)
let serverTimeline = [];
function renderServerTimeline(){
  const box = $("debug-timeline");
  if(!box) return;
  box.innerHTML = "";
  const items = Array.isArray(serverTimeline) ? serverTimeline : [];
  items.slice(0, 120).forEach(e=>{
    const row = document.createElement("div");
    row.className = "debugTLRow";
    const t = e?.ts ? String(e.ts).slice(11,19) : now();
    const tag = e?.tag ? String(e.tag) : "evt";
    const det = (e && (e.detail !== undefined)) ? e.detail : null;
    row.innerHTML = `<span class="t">[${t}]</span> <b>${tag}</b> <span>${det ? safeJson(det) : ""}</span>`;
    box.appendChild(row);
  });
}

function setDebugEnabled(v){
  DEBUG = !!v;
  try{ localStorage.setItem("MB_DEBUG", DEBUG ? "1" : "0"); }catch(e){}
  const cb = $("debug-enabled");
  if(cb) cb.checked = !!DEBUG;
}

function getStoredDebugEnabled(){
  try{
    const v = localStorage.getItem("MB_DEBUG");
    if(v === null) return true;
    return v === "1" || v === "true" || v === "on";
  }catch(e){
    return true;
  }
}




// [ANCHOR] MB:F:DEBUG — client-side log + report-to-server
function pushDebug(tag, detail){
    if(!DEBUG) return;
const entry = {
    ts: new Date().toISOString(),
    t: now(),
    tag: String(tag),
    detail
  };
  try{
    window.__MB_DBG.unshift(entry);
    if(window.__MB_DBG.length > DBG_MAX) window.__MB_DBG.length = DBG_MAX;
  }catch(e){}
  const body = $("debug-body");
  if(!body) return;
  const row = document.createElement("div");
  row.className = "dbg";
  row.innerHTML = `<span class="t">[${now()}]</span> <b>${tag}</b> <span class="d">${typeof detail === "string" ? detail : safeJson(detail)}</span>`;
  body.prepend(row);

  // Bound DOM list size to keep mobile from choking
  const DOM_MAX = 200;
  while (body.children.length > DOM_MAX) body.removeChild(body.lastChild);
}

function getDebugDump(){
  const env = {
    href: location.href,
    origin: location.origin,
    referrer: document.referrer,
    ua: navigator.userAgent,
    inIframe: window.self !== window.top,
    viewport: { w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio },
  };

  const logs = Array.isArray(window.__MB_DBG) ? window.__MB_DBG.slice(0, DBG_MAX) : [];

  let state = {};
  try{
    const socketConnected = !!(window.socket && window.socket.connected);
    const last = (typeof lastRoomStatus !== "undefined") ? lastRoomStatus : null;

    const timerEl = (typeof getPlayerTimerEl === "function") ? getPlayerTimerEl() : null;
    const timerRect = timerEl ? timerEl.getBoundingClientRect() : null;
    const timerCS = timerEl ? window.getComputedStyle(timerEl) : null;

    const pts = (typeof playerTimerState !== "undefined") ? playerTimerState : null;

    let playerTimerSec = null;
    try{
      if(pts && pts.endsAt){
        const alignedNow = (typeof playerTimerAlignedNow === "function")
          ? playerTimerAlignedNow()
          : (Date.now() - (Number(pts.serverOffsetMs)||0));
        playerTimerSec = Math.max(0, Math.ceil((Number(pts.endsAt) - alignedNow)/1000));
      }
    }catch(e){}

    state = {
      version: window.__MB_VERSION || null,
      screen: (typeof currentScreenName !== "undefined") ? currentScreenName : null,
      socket: {
        connected: socketConnected,
        id: (window.socket && window.socket.id) ? window.socket.id : null,
      },
      player: {
        joined: !!(window.playerState && playerState.joined),
        roomCode: (window.playerState && playerState.roomCode) || null,
        nickname: (window.playerState && playerState.nickname) || null,
        id: (window.playerState && (playerState.playerId || playerState.id)) || null,
        meVoted: !!(window.playerState && playerState.hasVotedLocal),
        readyNext: !!(window.playerState && playerState.readyNextLocal),
      },
      host: {
        joined: !!(window.hostState && hostState.joined),
        roomCode: (window.hostState && hostState.roomCode) || null,
        id: (window.hostState && hostState.id) || null,
        started: !!(window.hostState && hostState.started),
        roundNumber: (window.hostState && hostState.roundNumber) || null,
      },
      room: last ? {
        roomCode: last.roomCode,
        phase: last.phase,
        roundNumber: last.roundNumber,
        totalRounds: last.totalRounds,
        task: last.task,
        collectEndsAt: last.collectEndsAt,
        voteEndsAt: last.voteEndsAt,
        serverNow: last.serverNow,
        memesCount: last.memesCount,
        playersCount: last.playersCount,
      } : null,
      playerTimer: {
        hasEl: !!timerEl,
        inDom: timerEl ? document.body.contains(timerEl) : null,
        id: timerEl ? (timerEl.id || null) : null,
        hidden: timerEl ? timerEl.classList.contains("hidden") : null,
        text: timerEl ? timerEl.textContent : null,
        classes: timerEl ? Array.from(timerEl.classList) : null,
        rect: timerRect ? { x: timerRect.x, y: timerRect.y, w: timerRect.width, h: timerRect.height } : null,
        css: timerCS ? {
          display: timerCS.display,
          visibility: timerCS.visibility,
          opacity: timerCS.opacity,
          position: timerCS.position,
          top: timerCS.top,
          left: timerCS.left,
          zIndex: timerCS.zIndex,
          transform: timerCS.transform,
        } : null,
        state: pts ? {
          active: !!pts.active,
          phase: pts.phase,
          endsAt: pts.endsAt,
          offsetMs: pts.serverOffsetMs,
          tick: !!pts.tickHandle,
          lastSec: pts.lastSec,
          secComputed: playerTimerSec,
          lastSig: pts.lastSig,
        } : null,
      },
    };
  }catch(e){
    state = { error: String((e && e.message) || e) };
  }

  return { env, state, logs };
}

async function copyDebugToClipboard(){
  try{
    const dump = getDebugDump();
    await navigator.clipboard.writeText(JSON.stringify(dump, null, 2));
    pushDebug("debug", "copied to clipboard");
    alert("Debug скопирован в буфер (JSON)");
  }catch(e){
    pushDebug("debug", { copyError: String(e) });
    alert("Не удалось скопировать (возможно, запрет браузера). Открой DEBUG и скопируй вручную.");
  }
}


function formatDebugTsLocal(){
  // [ANCHOR] MB:DEBUG:FILENAME_TS — local device time, dd.MM.yy-HH-mm
  const d = new Date();
  const dd = String(d.getDate()).padStart(2,'0');
  const mm = String(d.getMonth()+1).padStart(2,'0');
  const yy = String(d.getFullYear()).slice(-2);
  const HH = String(d.getHours()).padStart(2,'0');
  const MI = String(d.getMinutes()).padStart(2,'0');
  return `${dd}.${mm}.${yy}-${HH}-${MI}`;
}

function getDebugFilePrefix(){
  try{
    // Keep names short (<=25 chars total with timestamp + ext)
    const isHost = (typeof currentScreenName !== "undefined" && currentScreenName === "host")
      || (typeof hostView !== "undefined" && !!hostView && (typeof playerState === "undefined" || !playerState?.joined));
    return isHost ? "dbgH_" : "dbgP_";
  }catch(e){
    return "dbg_";
  }
}

function downloadDebugFile(){
  try{
    const dump = getDebugDump();
    const json = JSON.stringify(dump, null, 2);
    const blob = new Blob([json], { type: "application/json;charset=utf-8" });

    const ts = formatDebugTsLocal();
    const fname = `${getDebugFilePrefix()}${ts}.json`;

    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = fname;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      try{ URL.revokeObjectURL(a.href); }catch(e){}
      try{ a.remove(); }catch(e){}
    }, 0);

    pushDebug("debug", { downloaded: fname, bytes: json.length });
  }catch(e){
    pushDebug("debug", { downloadError: String(e) });
    alert("Не удалось скачать debug JSON");
  }
}


// [ANCHOR] MB:DEBUG:ZIP — minimal ZIP (STORE, no compression) for bundling debug files
function crc32Bytes(u8){
  let crc = 0 ^ (-1);
  for(let i=0;i<u8.length;i++){
    crc = (crc >>> 8) ^ CRC32_TABLE[(crc ^ u8[i]) & 0xFF];
  }
  return (crc ^ (-1)) >>> 0;
}
const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for(let i=0;i<256;i++){
    let c = i;
    for(let k=0;k<8;k++){
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function u16(n){ const a = new Uint8Array(2); new DataView(a.buffer).setUint16(0, n, true); return a; }
function u32(n){ const a = new Uint8Array(4); new DataView(a.buffer).setUint32(0, n>>>0, true); return a; }

function concatU8(chunks){
  let len = 0;
  for(const c of chunks) len += c.length;
  const out = new Uint8Array(len);
  let off = 0;
  for(const c of chunks){ out.set(c, off); off += c.length; }
  return out;
}

// files: [{name:string, data:Uint8Array}]
function mbZipStore(files){
  const enc = new TextEncoder();
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for(const f of files){
    const nameBytes = enc.encode(String(f.name||"file"));
    const dataBytes = (f.data instanceof Uint8Array) ? f.data : enc.encode(String(f.data||""));
    const crc = crc32Bytes(dataBytes);
    const compSize = dataBytes.length;
    const uncompSize = dataBytes.length;

    // Local file header
    const localHeader = concatU8([
      u32(0x04034b50), // signature
      u16(20),         // version needed
      u16(0),          // flags
      u16(0),          // method 0 = store
      u16(0), u16(0),  // time/date (0)
      u32(crc),
      u32(compSize),
      u32(uncompSize),
      u16(nameBytes.length),
      u16(0)           // extra len
    ]);
    localParts.push(localHeader, nameBytes, dataBytes);

    // Central directory header
    const centralHeader = concatU8([
      u32(0x02014b50), // signature
      u16(20),         // version made by
      u16(20),         // version needed
      u16(0),          // flags
      u16(0),          // method
      u16(0), u16(0),  // time/date
      u32(crc),
      u32(compSize),
      u32(uncompSize),
      u16(nameBytes.length),
      u16(0),          // extra
      u16(0),          // comment
      u16(0),          // disk
      u16(0),          // int attr
      u32(0),          // ext attr
      u32(offset)
    ]);
    centralParts.push(centralHeader, nameBytes);

    offset += localHeader.length + nameBytes.length + dataBytes.length;
  }

  const centralDir = concatU8(centralParts);
  const centralOffset = offset;
  const centralSize = centralDir.length;

  const end = concatU8([
    u32(0x06054b50),
    u16(0), u16(0),
    u16(files.length),
    u16(files.length),
    u32(centralSize),
    u32(centralOffset),
    u16(0)
  ]);

  return concatU8([...localParts, centralDir, end]);
}

function downloadBlob(blob, fname){
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = fname;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    try{ URL.revokeObjectURL(a.href); }catch(e){}
    try{ a.remove(); }catch(e){}
  }, 0);
}


async function downloadDebugZipBundle(){
  // IMPORTANT:
  // Many browsers block downloads that happen after async/await (user-gesture is lost).
  // We use a server-side ZIP endpoint and open it synchronously.
  try{
    const isHost = (typeof currentScreenName !== "undefined" && currentScreenName === "host");
    if(!isHost){
      alert("ZIP доступен только у хоста (Host экран).");
      return;
    }

    // Resolve room + host token (must be in localStorage)
    const sess = hostSessionLoad();
    const roomCode = (typeof currentRoom !== "undefined" && currentRoom)
      ? String(currentRoom).toUpperCase().trim()
      : String(sess?.roomCode || "").toUpperCase().trim();
    const hostToken = String(sess?.hostToken || "").trim();

    if(!roomCode || !hostToken){
      alert("Нет данных ведущего (room/token). Создай комнату заново.");
      return;
    }

    const ts = formatDebugTsLocal();
    const url = `/api/debug-zip?room=${encodeURIComponent(roomCode)}&token=${encodeURIComponent(hostToken)}&ts=${encodeURIComponent(ts)}`;
    pushDebug("debug:zip", { action: "open", roomCode, ts });

    // Open in new tab (works even if inside iframe); fallback: same tab.
    const a = document.createElement("a");
    a.href = url;
    a.target = "_blank";
    a.rel = "noopener";
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    setTimeout(()=>{ try{ a.remove(); }catch(e){} }, 0);
  }catch(e){
    pushDebug("debug:zip", { error: String((e && e.message) || e) });
    alert("Не удалось скачать ZIP (debug bundle)");
  }
}

function clearDebug(){
  try{ window.__MB_DBG = []; }catch(e){}
  const body = $("debug-body");
  if(body) body.innerHTML = "";
  pushDebug("debug", "cleared");
}

// Iframe load/error hooks (best-effort; browsers often don't fire onerror)
window.__mbDbgOnIframeLoad = (el) => {
  try{
    el.dataset.mbLoaded = "1";
    pushDebug("iframe:load", { src: el.src, w: el.clientWidth, h: el.clientHeight });
    // Layout may finalize only after iframe load; re-apply TT vars using real viewport size
    if (String(el?.dataset?.mbIframe || "") === "tiktok") {
      applyTTVars("iframe-load");
    }
  }catch(e){}
};
window.__mbDbgOnIframeError = (el) => {
  try{
    pushDebug("iframe:error", { src: el?.src || "" });
  }catch(e){}
};

// ===== TikTok crop/zoom profiles (per-device) =====
// Stored in localStorage so you can tune once per device.
const LS_TT_PROFILES = "mb_tt_profiles_v1";
const LS_TT_FORCED = "mb_tt_forced_profile_v1";

const TT_DEFAULTS = {
  // values are tuned for a typical 9:16 viewport; they will be scaled to the actual card size
  desktop:        { cropX: 0, zoom: 1.30, x: 6,  y: -2, cropBottom: 0 },
  mobilePortrait: { cropX: 0, zoom: 1.00, x: 0,  y: 0,  cropBottom: 0 },
  mobileLandscape:{ cropX: 0, zoom: 1.00, x: 0,  y: 0,  cropBottom: 0 },
};

function cloneTTDefaults(){
  return {
    desktop: { ...TT_DEFAULTS.desktop },
    mobilePortrait: { ...TT_DEFAULTS.mobilePortrait },
    mobileLandscape: { ...TT_DEFAULTS.mobileLandscape },
  };
}

function loadTTProfiles(){
  try{
    const raw = localStorage.getItem(LS_TT_PROFILES);
    if(!raw) return cloneTTDefaults();
    const data = JSON.parse(raw);
    return {
      desktop: { ...TT_DEFAULTS.desktop, ...(data.desktop||{}) },
      mobilePortrait: { ...TT_DEFAULTS.mobilePortrait, ...(data.mobilePortrait||{}) },
      mobileLandscape: { ...TT_DEFAULTS.mobileLandscape, ...(data.mobileLandscape||{}) },
    };
  }catch(e){
    return cloneTTDefaults();
  }
}

function saveTTProfiles(profiles){
  try{ localStorage.setItem(LS_TT_PROFILES, JSON.stringify(profiles)); }catch(e){}
}

function getTTForcedProfileKey(){
  try{
    const v = (new URLSearchParams(location.search).get("tt" )||"").trim();
    if(v) return v;
  }catch(e){}
  try{ return localStorage.getItem(LS_TT_FORCED) || ""; }catch(e){ return ""; }
}

function setTTForcedProfileKey(key){
  try{
    if(!key) localStorage.removeItem(LS_TT_FORCED);
    else localStorage.setItem(LS_TT_FORCED, key);
  }catch(e){}
}

function getTTAutoProfileKey(){
  const w = window.innerWidth || 0;
  const h = window.innerHeight || 0;
  const isPortrait = h >= w;
  const isMobile = w <= 820; // rough; Bonsai WebView is usually < 500
  if(isMobile && isPortrait) return "mobilePortrait";
  if(isMobile && !isPortrait) return "mobileLandscape";
  return "desktop";
}

function getTTViewportSize(){
  // Prefer the actual rendered TikTok viewport; fallback to window size.
  const el = document.querySelector(".ttViewport");
  if(el && el.clientWidth && el.clientHeight) return { w: el.clientWidth, h: el.clientHeight };
  const w = Math.max(1, window.innerWidth || 360);
  // for 9:16 media, approximate height from width
  const h = Math.max(1, Math.round(w * 16 / 9));
  return { w, h };
}

function applyTTVars(reason = ""){ 
  const profiles = loadTTProfiles();
  const forced = getTTForcedProfileKey();
  const key = (forced && profiles[forced]) ? forced : getTTAutoProfileKey();
  const p = profiles[key] || TT_DEFAULTS.desktop;

  const { w, h } = getTTViewportSize();
  const baseW = 360;
  const baseH = 640;
  const sx = w / baseW;
  const sy = h / baseH;

  const scaled = {
    cropX: Math.round((p.cropX||0) * sx),
    x: Math.round((p.x||0) * sx),
    y: Math.round((p.y||0) * sy),
    cropBottom: Math.round((p.cropBottom||0) * sy),
    zoom: Number(p.zoom||1),
  };

  const root = document.documentElement;
  root.style.setProperty("--ttCropX", `${scaled.cropX}px`);
  root.style.setProperty("--ttX", `${scaled.x}px`);
  root.style.setProperty("--ttY", `${scaled.y}px`);
  root.style.setProperty("--ttCropBottom", `${scaled.cropBottom}px`);
  root.style.setProperty("--ttZoom", String(scaled.zoom));

  // Avoid spamming debug: log only when something реально изменилось
  const sig = `${key}|${forced ? 1 : 0}|${w}x${h}|${scaled.cropX}|${scaled.zoom}|${scaled.x}|${scaled.y}|${scaled.cropBottom}`;
  if (window.__mbTTLastSig !== sig) {
    window.__mbTTLastSig = sig;
    pushDebug("tt:apply", { reason, profile: key, forced: !!forced, viewport: { w, h }, raw: p, scaled });
  }
}

// ===== Player card calibration (box-based, no zoom) =====
// cardWidthPx is a max-width cap for the TikTok viewport inside the card.
// If the surrounding layout is narrower, it will still shrink naturally.
const DEFAULT_PLAYER_CARD = { cardWidthPx: 520, cardHeightPx: 520, cropSidePx: 0, cropBottomPx: 60, anchorY: "top", scale: 1.0 };

function normalizePlayerCard(pc){
  const o = pc || {};
  const cardWidthPx = Math.max(240, Math.min(1200, Number(o.cardWidthPx ?? DEFAULT_PLAYER_CARD.cardWidthPx)));
  const cardHeightPx = Math.max(180, Math.min(1200, Number(o.cardHeightPx ?? DEFAULT_PLAYER_CARD.cardHeightPx)));
  // Positive values crop more (hide side UI). Negative values zoom out (show more / add side bars).
  const cropSidePx = Math.max(-600, Math.min(600, Number(o.cropSidePx ?? DEFAULT_PLAYER_CARD.cropSidePx ?? 0)));
  const cropBottomPx = Math.max(0, Math.min(400, Number(o.cropBottomPx ?? DEFAULT_PLAYER_CARD.cropBottomPx)));
  const anchorY = ["top","center","bottom"].includes(String(o.anchorY)) ? String(o.anchorY) : DEFAULT_PLAYER_CARD.anchorY;
  const scale = Math.max(0.1, Math.min(2.0, Number(o.scale ?? DEFAULT_PLAYER_CARD.scale ?? 1)));
  return { cardWidthPx, cardHeightPx, cropSidePx, cropBottomPx, anchorY, scale };
}

function playerCardToCssVars(pc){
  const p = normalizePlayerCard(pc);
  let top = "0%";
  let ty = "0%";
  if (p.anchorY === "center"){ top = "50%"; ty = "-50%"; }
  if (p.anchorY === "bottom"){ top = "100%"; ty = "-100%"; }
  return {
    "--ttBoxW": `${p.cardWidthPx}px`,
    "--ttBoxH": `${p.cardHeightPx}px`,
    "--ttCropBottomBox": `${p.cropBottomPx}px`,
    "--ttCropSide2": `${Math.round((p.cropSidePx||0) * 2)}px`,
    "--ttAnchorTop": top,
    "--ttAnchorTranslateY": ty,
    "--ttScale": String(p.scale ?? 1),
    "--ttOriginY": (p.anchorY === "bottom" ? "100%" : (p.anchorY === "center" ? "50%" : "0%")),

    // Keep legacy vars neutral (we don't use zoom anymore)
    "--ttZoom": "1",
    "--ttX": "0px",
    "--ttY": "0px",
    "--ttCropX": "0px",
    "--ttCropBottom": "0px",
  };
}

function applyPlayerCardVars(pc, reason=""){
  const vars = playerCardToCssVars(pc);
  const root = document.documentElement;
  Object.entries(vars).forEach(([k,v]) => root.style.setProperty(k, v));
  pushDebug("pc:apply", { reason, pc: normalizePlayerCard(pc), vars });
}

function loadLocalPlayerCard(){
  try{
    const raw = localStorage.getItem(LS_PLAYER_CARD);
    if(!raw) return null;
    return normalizePlayerCard(JSON.parse(raw));
  }catch(e){
    return null;
  }
}
function saveLocalPlayerCard(pc){
  try{ localStorage.setItem(LS_PLAYER_CARD, JSON.stringify(normalizePlayerCard(pc))); }catch(e){}
}

function ensureTTDebugControls(){
  const panel = document.getElementById("debug-panel");
  const body = document.getElementById("debug-body");
  if(!panel || !body) return;
  if(document.getElementById("debug-tt")) return;

  const wrap = document.createElement("div");
  wrap.id = "debug-tt";
  wrap.className = "debug-tt";
  wrap.innerHTML = `
    <div class="debug-tt-title">TikTok crop</div>
    <div class="debug-tt-row">
      <label>Профиль</label>
      <select id="tt-prof" class="debug-tt-select">
        <option value="desktop">ПК / большой экран</option>
        <option value="mobilePortrait">Мобилка — вертикаль</option>
        <option value="mobileLandscape">Мобилка — горизонталь</option>
      </select>
      <button id="tt-force" class="debug-tt-btn" title="Зафиксировать этот профиль">fix</button>
      <button id="tt-unforce" class="debug-tt-btn" title="Снять фиксацию">auto</button>
    </div>

    <div class="debug-tt-row"><label>Обрезка по бокам</label><input id="tt-cropX" type="range" min="0" max="60" step="1"><span id="tt-cropXv" class="debug-tt-val"></span></div>
    <div class="debug-tt-row"><label>Zoom</label><input id="tt-zoom" type="range" min="0.8" max="1.8" step="0.01"><span id="tt-zoomv" class="debug-tt-val"></span></div>
    <div class="debug-tt-row"><label>Сдвиг X</label><input id="tt-x" type="range" min="-80" max="80" step="1"><span id="tt-xv" class="debug-tt-val"></span></div>
    <div class="debug-tt-row"><label>Сдвиг Y</label><input id="tt-y" type="range" min="-120" max="120" step="1"><span id="tt-yv" class="debug-tt-val"></span></div>
    <div class="debug-tt-row"><label>Crop снизу</label><input id="tt-cropB" type="range" min="0" max="240" step="1"><span id="tt-cropBv" class="debug-tt-val"></span></div>

    <div class="debug-tt-row">
      <button id="tt-reset" class="debug-tt-btn wide">reset профиля</button>
      <button id="tt-copy" class="debug-tt-btn wide">copy JSON</button>
    </div>
  `;

  // insert above logs
  panel.insertBefore(wrap, body);

  const profSel = document.getElementById("tt-prof");
  const cropX = document.getElementById("tt-cropX");
  const zoom = document.getElementById("tt-zoom");
  const x = document.getElementById("tt-x");
  const y = document.getElementById("tt-y");
  const cropB = document.getElementById("tt-cropB");

  const vCropX = document.getElementById("tt-cropXv");
  const vZoom = document.getElementById("tt-zoomv");
  const vX = document.getElementById("tt-xv");
  const vY = document.getElementById("tt-yv");
  const vCropB = document.getElementById("tt-cropBv");

  const fill = () => {
    const profiles = loadTTProfiles();
    const key = profSel.value;
    const p = profiles[key] || TT_DEFAULTS.desktop;
    cropX.value = String(p.cropX||0);
    zoom.value = String(p.zoom||1);
    x.value = String(p.x||0);
    y.value = String(p.y||0);
    cropB.value = String(p.cropBottom||0);
    vCropX.textContent = `${cropX.value}px`;
    vZoom.textContent = String(Number(zoom.value).toFixed(2));
    vX.textContent = `${x.value}px`;
    vY.textContent = `${y.value}px`;
    vCropB.textContent = `${cropB.value}px`;
  };

  const commit = () => {
    const profiles = loadTTProfiles();
    const key = profSel.value;
    profiles[key] = {
      cropX: Number(cropX.value),
      zoom: Number(zoom.value),
      x: Number(x.value),
      y: Number(y.value),
      cropBottom: Number(cropB.value),
    };
    saveTTProfiles(profiles);
    fill();
    applyTTVars("controls");
  };

  profSel.addEventListener("change", () => { fill(); applyTTVars("profile-change"); });
  [cropX, zoom, x, y, cropB].forEach(el => el.addEventListener("input", commit));

  document.getElementById("tt-reset")?.addEventListener("click", () => {
    const profiles = loadTTProfiles();
    profiles[profSel.value] = { ...TT_DEFAULTS[profSel.value] };
    saveTTProfiles(profiles);
    fill();
    applyTTVars("reset");
  });
  document.getElementById("tt-copy")?.addEventListener("click", async () => {
    try{
      const text = JSON.stringify(loadTTProfiles(), null, 2);
      await navigator.clipboard.writeText(text);
      pushDebug("tt:copy", "ok");
      alert("Скопировано в буфер обмена");
    }catch(e){
      pushDebug("tt:copy", { error: String(e) });
      alert("Не удалось скопировать. Открой DEBUG -> посмотри логи.");
    }
  });
  document.getElementById("tt-force")?.addEventListener("click", () => {
    setTTForcedProfileKey(profSel.value);
    applyTTVars("force");
  });
  document.getElementById("tt-unforce")?.addEventListener("click", () => {
    setTTForcedProfileKey("");
    applyTTVars("auto");
  });

  // set initial profile dropdown to the auto (or forced) one
  const profiles = loadTTProfiles();
  const forced = getTTForcedProfileKey();
  const auto = (forced && profiles[forced]) ? forced : getTTAutoProfileKey();
  profSel.value = auto;
  fill();
  applyTTVars("init");
}

// Keep vars in sync if viewport/card size changes
window.addEventListener("resize", () => applyTTVars("resize"));
try{
  window.matchMedia("(orientation: portrait)").addEventListener("change", () => applyTTVars("orientation"));
}catch(e){}

async function normalizeVideoLink(inputUrl){
  const rawUrl = String(inputUrl || "").trim();
  if(!rawUrl) return { url: rawUrl };

  pushDebug("normalize:input", rawUrl);

  try{
    // YouTube: pass through (renderMediaHTML handles embedding)
    if (/(youtube\.com|youtu\.be)/i.test(rawUrl)) {
      pushDebug("normalize:youtube", rawUrl);
      return { url: rawUrl };
    }

    // TikTok: try fast id extraction first
    if (/tiktok\.com/i.test(rawUrl)) {
      pushDebug("normalize:tiktok:detected", rawUrl);
      const id =
        rawUrl.match(/\/video\/(\d{10,})/i)?.[1] ||
        rawUrl.match(/\/embed\/v2\/(\d{10,})/i)?.[1] ||
        rawUrl.match(/[?&](?:item_id|share_item_id|aweme_id)=(\d{10,})/i)?.[1] ||
        "";
      if (id) {
        const embedUrl = `https://www.tiktok.com/embed/v2/${id}`;
        pushDebug("normalize:tiktok:direct_id", { id, embedUrl });
        return { url: embedUrl, videoId: id, ok: true, fast: true };
      }

      // For vm/vt short links: ask server to resolve -> embed
      pushDebug("normalize:tiktok:request", { endpoint: "/api/normalize-video-link", url: rawUrl });
      const res = await fetch("/api/normalize-video-link", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: rawUrl }),
      });
      pushDebug("normalize:tiktok:response", { status: res.status, ok: res.ok });
      const data = await res.json().catch(() => ({}));
      pushDebug("normalize:tiktok:json", data);
      if (data?.ok && data?.embedUrl) {
        pushDebug("normalize:tiktok:out", { out: data.embedUrl, via: "server", videoId: data?.videoId || null });
        return { url: data.embedUrl, data, ok: true };
      }
      // Fallback: try TikTok oEmbed directly from the browser (can help if server fetch is blocked)
      try{
        const oembedUrl = "https://www.tiktok.com/oembed?url=" + encodeURIComponent(rawUrl);
        const o = await fetch(oembedUrl);
        pushDebug("normalize:tiktok:oembed_resp", { status: o.status, ok: o.ok, oembedUrl });
        const j = await o.json().catch(() => ({}));
        pushDebug("normalize:tiktok:oembed_json", j);
        const html = j && j.html ? String(j.html) : "";
        const mm = html.match(/data-video-id=['"](\d{10,})['"]/i) || html.match(/embed\/v2\/(\d{10,})/i);
        const vid = mm ? mm[1] : "";
        if(vid){
          const embedUrl = `https://www.tiktok.com/embed/v2/${vid}`;
          pushDebug("normalize:tiktok:out", { out: embedUrl, via: "oembed", videoId: vid });
          return { url: embedUrl, videoId: vid, ok: true, via: "oembed" };
        }
      }catch(e){
        pushDebug("normalize:tiktok:oembed_error", String(e));
      }

      return { url: rawUrl, data, ok: false };
    }

    pushDebug("normalize:non_tiktok", rawUrl);
    return { url: rawUrl };
  }catch(e){
    return { url: rawUrl, error: e };
  }
}

function setDebug(open){ $("debug-panel")?.classList.toggle("hidden", !open); }
$("debug-toggle")?.addEventListener("click", () => setDebug($("debug-panel")?.classList.contains("hidden")));
$("debug-close")?.addEventListener("click", () => setDebug(false));
$("debug-copy")?.addEventListener("click", () => copyDebugToClipboard());
$("debug-download")?.addEventListener("click", () => downloadDebugFile());
$("debug-download-zip")?.addEventListener("click", () => downloadDebugZipBundle());
$("debug-clear")?.addEventListener("click", () => clearDebug());

// [ANCHOR] MB:DEBUG:init
try{ setDebugEnabled(getStoredDebugEnabled()); }catch(e){}

function setSettings(open){ $("settings-panel")?.classList.toggle("hidden", !open); }
$("settings-toggle")?.addEventListener("click", () => setSettings($("settings-panel")?.classList.contains("hidden")));
$("settings-close")?.addEventListener("click", () => setSettings(false));
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape"){
    if (!$("settings-panel")?.classList.contains("hidden")) setSettings(false);
    if (!$("debug-panel")?.classList.contains("hidden")) setDebug(false);
  }
});
if (new URLSearchParams(location.search).get("debug") === "1") setDebug(true);

// Log environment once (helps understand why TikTok embeds may be blocked)
pushDebug("env", {
  href: location.href,
  origin: location.origin,
  referrer: document.referrer || "",
  ua: navigator.userAgent,
  inIframe: window.self !== window.top,
  secure: window.isSecureContext,
  dpr: window.devicePixelRatio,
  viewport: { w: window.innerWidth, h: window.innerHeight },
  screen: { w: screen.width, h: screen.height }
});

// Init TT controls + initial vars (will re-apply after embeds load/render)
try{ initTTDebugControls(); }catch(e){}
try{ applyPlayerCardVars(loadLocalPlayerCard()||DEFAULT_PLAYER_CARD, "init"); }catch(e){}
try{ applyTTVars("init"); }catch(e){}
setTimeout(() => {
  try{ applyTTVars("init:delayed"); }catch(e){}
}, 0);


// [ANCHOR] MB:F:SCREENS — mode/host/player/admin navigation
// -------- Screen switching
const screens = ["mode","host","player","admin"].reduce((acc,k)=>{
  acc[k] = $(`screen-${k}`);
  return acc;
}, {});
let currentScreenName = "mode"; // [ANCHOR] MB:STATE:CURRENT_SCREEN
function setHostView(view){
  const setup = $("host-view-setup");
  const round = $("host-view-round");
  const voting = $("host-view-voting");
  const game = $("host-view-game");
  if(!setup || !game) return;
  const v = view || "setup";

  // clean up view-specific timers/loops
  const prev = hostView;
  if(prev && prev !== v){
    if(prev === "round") hostRoundStopTimer();
    if(prev === "voting") try{ hostVoteStop(); }catch(e){}
  }

  setup.classList.toggle("hidden", v !== "setup");
  if(round) round.classList.toggle("hidden", v !== "round");
  if(voting) voting.classList.toggle("hidden", v !== "voting");
  game.classList.toggle("hidden", v !== "game");
  hostView = v;
  if(v === "round"){ try{ scheduleFitHostRoundLayout(); }catch(e){} }
}

let hostView = "setup";
let hostRoundState = {
  secondsTotal: 120,
  secondsLeft: 120,
  interval: null,
  forcedVote: false,
  task: "",
  round: 1,
  totalRounds: 1,
};

function fmtMMSS(sec){
  const s = Math.max(0, Number(sec)||0);
  const mm = String(Math.floor(s/60)).padStart(2,'0');
  const ss = String(Math.floor(s%60)).padStart(2,'0');
  return `${mm}:${ss}`;
}


// --- Host Round: auto-fit task text (<= 6 lines) + ensure no scroll ---
var hostRoundFitRaf = 0;

function scheduleFitHostRoundLayout(){
  try{
    if(hostRoundFitRaf) cancelAnimationFrame(hostRoundFitRaf);
    hostRoundFitRaf = requestAnimationFrame(()=>{
      hostRoundFitRaf = 0;
      try{ fitHostRoundLayout(); }catch(e){}
    });
  }catch(e){}
}

function __hostRoundCountLines(el){
  if(!el) return 999;
  const cs = getComputedStyle(el);
  const lh = parseFloat(cs.lineHeight) || (parseFloat(cs.fontSize)||16) * 1.05;
  const h = el.scrollHeight || 0;
  return lh ? Math.max(1, Math.round(h / lh)) : 999;
}

function __hostRoundHasScroll(){
  const sc = document.scrollingElement || document.documentElement;
  if(!sc) return false;
  return (Math.ceil(sc.scrollHeight) - Math.ceil(window.innerHeight)) > 2;
}

function fitHostRoundLayout(){
  const box = $("host-view-round");
  if(!box || box.classList.contains("hidden")) return;
  const theme = $("host-round-theme");
  if(!theme) return;

  // Reset
  box.classList.remove("hr-compact","hr-ultra","hr-overlong");
  theme.style.removeProperty("--hostThemeFont");

  const textLen = (theme.textContent || "").trim().length;
  if(textLen > 130) box.classList.add("hr-overlong");

  const MAX_LINES = 6;

  function tryMode(mode){
    box.classList.toggle("hr-compact", mode >= 1);
    box.classList.toggle("hr-ultra", mode >= 2);

    // reset font var so we can read the baseline size for this mode
    theme.style.removeProperty("--hostThemeFont");
    // force reflow
    void theme.offsetWidth;

    const basePx = parseFloat(getComputedStyle(theme).fontSize) || 40;
    const minPx = Math.max(14, Math.min(22, basePx * 0.55));
    const maxPx = Math.max(minPx, basePx);

    // If it already fits at max, keep it.
    theme.style.setProperty("--hostThemeFont", `${maxPx}px`);
    void theme.offsetWidth;
    let lines = __hostRoundCountLines(theme);
    if(lines <= MAX_LINES && !__hostRoundHasScroll()){
      return true;
    }

    // Binary search best size that fits
    let lo = minPx, hi = maxPx, best = minPx;
    for(let i=0;i<14;i++){
      const mid = (lo + hi) / 2;
      theme.style.setProperty("--hostThemeFont", `${mid}px`);
      void theme.offsetWidth;
      lines = __hostRoundCountLines(theme);
      const ok = (lines <= MAX_LINES) && !__hostRoundHasScroll();
      if(ok){
        best = mid;
        lo = mid;
      }else{
        hi = mid;
      }
    }
    theme.style.setProperty("--hostThemeFont", `${best}px`);
    void theme.offsetWidth;

    lines = __hostRoundCountLines(theme);
    return (lines <= MAX_LINES) && !__hostRoundHasScroll();
  }

  // Try normal -> compact -> ultra
  if(tryMode(0)) return;
  if(tryMode(1)) return;
  tryMode(2);
}
// --- END Host Round auto-fit ---

function hostRoundSetTimerVisual(sec){
  const el = $("host-round-timer");
  if(!el) return;
  const s = Number(sec)||0;
  el.textContent = fmtMMSS(s);
  el.classList.remove('ok','warn','crit','bounce');
  if(s <= 5) el.classList.add('crit');
  else if(s <= 10) el.classList.add('warn');
  else el.classList.add('ok');
  if(s <= 10 && s > 0){
    // retrigger bounce each tick
    void el.offsetWidth;
    el.classList.add('bounce');
  }
}

function hostRoundStopTimer(){
  if(hostRoundState.interval){
    clearInterval(hostRoundState.interval);
    hostRoundState.interval = null;
  }
}


// [ANCHOR] MB:F:HOST_ROUND:TIMER
function hostRoundStartTimer(seconds){
  hostRoundStopTimer();
  hostRoundState.secondsTotal = Math.max(5, Number(seconds)||120);
  hostRoundState.secondsLeft = hostRoundState.secondsTotal;
  hostRoundState.forcedVote = false;
  hostRoundSetTimerVisual(hostRoundState.secondsLeft);
  hostRoundState.interval = setInterval(()=>{
    hostRoundState.secondsLeft = Math.max(0, (hostRoundState.secondsLeft||0) - 1);
    hostRoundSetTimerVisual(hostRoundState.secondsLeft);
    if(hostRoundState.secondsLeft <= 0){
      hostRoundStopTimer();
      // force voting if still collecting
      try{
        const st = lastRoomStatus;
        if(!hostRoundState.forcedVote && currentRoom && st && st.phase === 'collect'){
          hostRoundState.forcedVote = true;
          socket.emit('host-start-vote', { roomCode: currentRoom }, ()=>{});
        }
      }catch(e){}
    }
  }, 1000);
}

function hostRoundSetTask(task, roundNum, totalRounds){
  hostRoundState.task = String(task || hostRoundState.task || '').trim();
  hostRoundState.round = Number(roundNum || hostRoundState.round || 1);
  hostRoundState.totalRounds = Number(totalRounds || hostRoundState.totalRounds || 1);
  const ind = $("host-round-indicator");
  if(ind) ind.textContent = `ROUND ${hostRoundState.round} / ${hostRoundState.totalRounds}`;
  const theme = $("host-round-theme");
  if(theme) theme.textContent = hostRoundState.task || '—';
  try{ scheduleFitHostRoundLayout(); }catch(e){}
}

function hostRoundUpdateProgress(st){
  const box = $("host-view-round");
  if(!box || box.classList.contains('hidden')) return;
  if(!st) return;
  const players = Array.isArray(st.players) ? st.players : [];
  const connected = players.filter(p => p && p.connected);
  const total = connected.length;
  const sent = connected.filter(p => p.hasMeme).length;
  const missing = Math.max(0, total - sent);

  $("host-round-sent") && ($("host-round-sent").textContent = String(sent));
  $("host-round-missing") && ($("host-round-missing").textContent = String(missing));
  $("host-round-total") && ($("host-round-total").textContent = `${sent}/${total} total`);
  const bar = $("host-round-bar");
  if(bar){
    const pct = total ? Math.round((sent/total)*100) : 0;
    bar.style.width = `${pct}%`;
  }
  const wait = $("host-round-wait");
  if(wait){
    wait.classList.toggle('hidden', !(st.phase === 'collect' && sent < total));
  }
}


// [ANCHOR] MB:F:HOST_VOTING — masonry + timer + autoscroll
// -------- HOST voting view (fixed timer + masonry + auto-scroll)
const HOST_VOTE_SECONDS_DEFAULT = 30;
let hostVoteState = {
  secondsTotal: HOST_VOTE_SECONDS_DEFAULT,
  voteStartAt: 0,
  voteEndsAt: 0,
  lastShown: null,
  interval: null,
  progressCirc: null,
  lastRenderKey: "",
  auto: {
    enabled: false,
    direction: "down",
    interval: null,
    pauseTimeout: null,
    resumeTimeout: null,
    lastProgAt: 0,
    scrollingEl: null,
    onScroll: null,
  }
};

function hostVoteSetTimerVisual(timeLeft){
  const el = $("host-vote-timer");
  if(!el) return;

  const left = Math.max(0, Math.floor(Number(timeLeft)||0));

  // state class: ok / warn / crit (like Host Round timer)
  el.classList.remove("ok","warn","crit");
  if(left <= 5) el.classList.add("crit");
  else if(left <= 10) el.classList.add("warn");
  else el.classList.add("ok");

  // update only when second changes
  if(hostVoteState.lastShown !== left){
    hostVoteState.lastShown = left;
    el.textContent = fmtMMSS(left);

    // bounce near the end (like Task screen)
    el.classList.remove("bounce");
    void el.offsetWidth;
    if(left > 0 && left <= 10) el.classList.add("bounce");
  }
}

function hostVoteStopTimer(){
  if(hostVoteState.interval){
    clearInterval(hostVoteState.interval);
    hostVoteState.interval = null;
  }
}

function hostVoteStartTimer(secondsTotal){
  hostVoteStopTimer();
  hostVoteState.secondsTotal = Math.max(5, Number(secondsTotal)||HOST_VOTE_SECONDS_DEFAULT);
  hostVoteState.lastShown = null;

  const tick = ()=>{
    // [ANCHOR] MB:F:HOST_VOTE_TIMER:STOP_ON_COMPLETE — if vote already завершено (voteComplete=true), stop timer to avoid "00:00 stuck" + redundant force-finish
    try{
      const st0 = (typeof lastRoomStatus !== "undefined") ? lastRoomStatus : null;
      if(st0 && st0.phase === "vote" && st0.voteComplete){
        hostVoteSetTimerVisual(0);
        hostVoteStopTimer();
        return;
      }
    }catch(e){}

    const endsAt = Number(hostVoteState.voteEndsAt || 0);
    let left = 0;

    if (Number.isFinite(endsAt) && endsAt > 0) {
      left = Math.max(0, Math.ceil((endsAt - Date.now()) / 1000));
    } else {
      if(!hostVoteState.voteStartAt) hostVoteState.voteStartAt = Date.now();
      const elapsed = Math.floor((Date.now() - (hostVoteState.voteStartAt||Date.now())) / 1000);
      left = Math.max(0, hostVoteState.secondsTotal - elapsed);
    }


    // [BUGWATCH] Если таймер дошёл до 00:00, а voteComplete не приходит — шлём host-force-finish-vote.
    // Detect classic bug: UI shows 00:00 but server doesn't finish vote (missing endsAt/timer)
    try{
      const inVoting = (typeof hostView !== "undefined" && hostView === "voting");
      const st = (typeof lastRoomStatus !== "undefined") ? lastRoomStatus : null;

      // Only "stuck" if server STILL doesn't have voteComplete.
      if(inVoting && left === 0 && !st?.voteComplete){
        const nowMs = Date.now();
        const key = String(hostVoteState.voteEndsAt || 0) + "|" + String(hostVoteState.voteStartAt || 0);

        if(hostVoteState._zeroKey !== key){
          hostVoteState._zeroKey = key;
          hostVoteState._zeroSince = nowMs;
          hostVoteState._zeroReported = false;
        }
        if(!hostVoteState._zeroSince) hostVoteState._zeroSince = nowMs;

        if(!hostVoteState._zeroReported && (nowMs - (hostVoteState._zeroSince||nowMs)) > 1500){
          hostVoteState._zeroReported = true;
          const detail = {
            left,
            clientNow: nowMs,
            voteEndsAt: hostVoteState.voteEndsAt || 0,
            secondsTotal: hostVoteState.secondsTotal || 0,
            roomStatus: {
              phase: st?.phase || null,
              voteComplete: !!st?.voteComplete,
              serverNow: st?.serverNow || null,
              voteEndsAt: st?.voteEndsAt || 0,
              voteSeconds: st?.voteSeconds || null,
              debugTimers: st?.debugTimers || null,
            }
          };
          pushDebug("vote_timer_zero_stuck", detail);
          dbgReport("vote_timer_zero_stuck", detail);
          if(!hostVoteState._forceFinishSent){
            hostVoteState._forceFinishSent = true;
            try{
              if(typeof socket !== "undefined" && socket && currentRoom){
                // Server already supports this event; use it as a failsafe when the vote timer data is missing/stuck.
                socket.emit("host-force-finish-vote", { roomCode: currentRoom, reason: "timer_stuck" }, (res)=>{
                  try{ pushDebug("host-force-finish-vote", res || {}); }catch(e){}
                });
              }
            }catch(e){}
          }

        }
      } else {
        hostVoteState._zeroSince = 0;
        hostVoteState._zeroReported = false;
      }
    }catch(e){}

    hostVoteSetTimerVisual(left);
  };

  tick();
  hostVoteState.interval = setInterval(tick, 250);
}

function hostVoteStopAutoScroll(){
  const a = hostVoteState.auto;
  a.enabled = false;
  if(a.interval){ clearInterval(a.interval); a.interval = null; }
  if(a.pauseTimeout){ clearTimeout(a.pauseTimeout); a.pauseTimeout = null; }
  if(a.resumeTimeout){ clearTimeout(a.resumeTimeout); a.resumeTimeout = null; }
  if(a.scrollingEl && a.onScroll){
    a.scrollingEl.removeEventListener('scroll', a.onScroll);
  }
  a.scrollingEl = null;
  a.onScroll = null;
}

function hostVoteStartAutoScroll(){
  hostVoteStopAutoScroll();
  const el = $("host-vote-scroll");
  if(!el) return;
  // only if overflow
  if(el.scrollHeight <= el.clientHeight + 4) return;

  const a = hostVoteState.auto;
  a.enabled = true;
  a.direction = "down";
  a.scrollingEl = el;

  const speedPx = 0.5;
  const intervalMs = 30;
  const pauseMs = 2000;
  const edgePad = 5;

  const startInterval = ()=>{
    if(!a.enabled || !a.scrollingEl) return;
    if(a.interval) clearInterval(a.interval);
    a.interval = setInterval(()=>{
      if(!a.enabled || !a.scrollingEl) return;
      const node = a.scrollingEl;
      a.lastProgAt = Date.now();
      if(a.direction === "down") node.scrollTop += speedPx;
      else node.scrollTop -= speedPx;

      const atBottom = (node.scrollTop + node.clientHeight) >= (node.scrollHeight - edgePad);
      const atTop = node.scrollTop <= edgePad;
      if(a.direction === "down" && atBottom){
        clearInterval(a.interval); a.interval = null;
        a.pauseTimeout = setTimeout(()=>{ a.direction = "up"; startInterval(); }, pauseMs);
      }
      if(a.direction === "up" && atTop){
        clearInterval(a.interval); a.interval = null;
        a.pauseTimeout = setTimeout(()=>{ a.direction = "down"; startInterval(); }, pauseMs);
      }
    }, intervalMs);
  };

  // Manual scroll detection (ignore programmatic ticks)
  let manualDebounce = null;
  a.onScroll = ()=>{
    if(!a.enabled) return;
    if(Date.now() - (a.lastProgAt||0) < 80) return; // programmatic tick
    if(manualDebounce) clearTimeout(manualDebounce);
    manualDebounce = setTimeout(()=>{
      if(!a.enabled) return;
      // pause auto-scroll
      if(a.interval){ clearInterval(a.interval); a.interval = null; }
      if(a.pauseTimeout){ clearTimeout(a.pauseTimeout); a.pauseTimeout = null; }
      if(a.resumeTimeout) clearTimeout(a.resumeTimeout);
      a.resumeTimeout = setTimeout(()=>{
        startInterval();
      }, 3000);
    }, 100);
  };

  el.addEventListener('scroll', a.onScroll, { passive: true });
  startInterval();
}

function hostVoteRender(st){
  const box = $("host-view-voting");
  if(!box) return;

  const task = (st && st.task) ? String(st.task) : (hostRoundState.task || "—");
  const themeEl = $("host-vote-theme");
  if(themeEl) themeEl.textContent = task || "—";

  const statusEl = $("host-vote-status");
  if(statusEl){
    const memes = Array.isArray(st?.memes) ? st.memes : [];
    if(st?.voteComplete) statusEl.textContent = "Voting finished.";
    else if(!memes.length) statusEl.textContent = "Waiting for memes…";
    else statusEl.textContent = "Voting in progress…";
  }

  const memes = Array.isArray(st?.memes) ? st.memes : [];
  const key = memes.map(m => `${m?.id||''}:${m?.url||''}`).join('|');
  if(key && hostVoteState.lastRenderKey === key) return;
  hostVoteState.lastRenderKey = key;

  const grid = $("host-vote-grid");
  if(!grid) return;
  grid.innerHTML = "";

  memes.forEach((m, idx) => {
    const item = document.createElement('div');
    item.className = 'hostVoteItem';
    item.style.animationDelay = `${idx * 0.1}s`;

    const badge = document.createElement('div');
    badge.className = 'hostVoteBadge';
    const b = document.createElement('span');
    b.textContent = String(idx + 1);
    badge.appendChild(b);

    const card = document.createElement('div');
    card.className = 'hostVoteCard';

    // Media
    const url = String(m?.url || "").trim();
    const mt = detectMediaType(url);
    if(mt?.type && (mt.type.startsWith('image') || mt.type.startsWith('gif'))){
      const media = document.createElement('div');
      media.className = 'hostVoteMedia';

      const img = document.createElement('img');
      img.loading = 'lazy';
      img.alt = m?.caption ? String(m.caption) : 'Meme';
      img.src = url;
      img.addEventListener('load', () => {
        try{
          if(img.naturalWidth && img.naturalHeight){
            media.style.aspectRatio = `${img.naturalWidth} / ${img.naturalHeight}`;
          }
        }catch(e){}
      }, { once: true });

      media.appendChild(img);
      card.appendChild(media);
    }else{
      // fallback to existing embed renderer
      const wrap = document.createElement('div');
      wrap.innerHTML = renderMediaHTML(url);
      const node = wrap.firstElementChild;
      if(node) card.appendChild(node);
    }

    // Caption area (optional)
    const cap = String(m?.caption || '').trim();
    if(cap){
      const capWrap = document.createElement('div');
      capWrap.className = 'hostVoteCapWrap';
      const capEl = document.createElement('div');
      capEl.className = 'hostVoteCap';
      capEl.textContent = cap;
      capWrap.appendChild(capEl);
      card.appendChild(capWrap);
    }

    item.appendChild(badge);
    item.appendChild(card);
    grid.appendChild(item);
  });

  // Apply TikTok vars after rendering
  setTimeout(() => {
    try{ applyTTVars('host-voting:render'); }catch(e){}
  }, 0);

  // auto-scroll only when needed
  setTimeout(() => {
    try{ hostVoteStartAutoScroll(); }catch(e){}
  }, 200);
}

function hostVoteEnter(st){
  hostVoteState._forceFinishSent = false;
  // when entering voting: prefer server-authoritative deadline (prevents 00:00 hang due to desync)
  try{
    const ve = Number(st?.voteEndsAt || 0);
    if(Number.isFinite(ve) && ve > 0){
      hostVoteState.voteEndsAt = ve;
      hostVoteState.voteStartAt = 0;
    } else {
      // fallback (should be rare)
      hostVoteState.voteStartAt = Date.now();
      hostVoteState.voteEndsAt = 0;
    }
    const vs = Number(st?.voteSeconds || 0);
    if(Number.isFinite(vs) && vs > 0) hostVoteState.secondsTotal = Math.max(5, vs);
  }catch(e){
    hostVoteState.voteStartAt = Date.now();
    hostVoteState.voteEndsAt = 0;
  }

  hostVoteState.lastShown = null;
  hostVoteState.lastRenderKey = "";
  hostVoteRender(st);
  hostVoteStartTimer(hostVoteState.secondsTotal || HOST_VOTE_SECONDS_DEFAULT);
}


function hostVoteStop(){
  hostVoteStopTimer();
  hostVoteStopAutoScroll();
  hostVoteState.voteStartAt = 0;
  hostVoteState.voteEndsAt = 0;

  hostVoteState._zeroSince = 0;
  hostVoteState._zeroReported = false;
  hostVoteState._zeroKey = "";
}


function showScreen(name){
  currentScreenName = name;
  try{ document.body.classList.toggle("is-role-selection", name === "mode"); }catch(e){}
  Object.entries(screens).forEach(([k,el])=>{
    if(!el) return;
    el.classList.toggle("hidden", k !== name);
  });
  // Settings button only after selecting role
  const sb = $("settings-toggle");
  if(sb) sb.classList.toggle("hidden", name === "mode");
  if(name === "mode") { try{ setSettings(false); }catch(e){} }
  if(name === "host") { try{ setHostView("setup"); }catch(e){} }
  if(name === "host") { try{ hostTryRejoin("show_host"); }catch(e){} }
  try{ playerTimerUpdate(true); }catch(e){}
  pushDebug("screen", name);
}
$("btn-mode-host")?.addEventListener("click", () => showScreen("host"));
$("btn-mode-player")?.addEventListener("click", () => showScreen("player"));
$("btn-fullscreen")?.addEventListener("click", () => {
  try{
    if(!document.fullscreenElement){ document.documentElement.requestFullscreen(); }
    else{ document.exitFullscreen(); }
  }catch(error){ console.log("Fullscreen not available:", error); }
});
$("btn-mode-admin")?.addEventListener("click", () => showScreen("admin"));

// -------- Socket
const socket = (typeof io === "function")
  ? io(SERVER_URL, { transports: ["websocket","polling"] })
  : { on:()=>{}, emit:()=>{} };

function dbgReport(tag, detail){
  try{
    const roomCode = (typeof currentRoom !== "undefined" && currentRoom) ? currentRoom
      : ((typeof playerState !== "undefined" && playerState && playerState.roomCode) ? playerState.roomCode : null);
    socket.emit("debug-report", {
      tag: String(tag || ""),
      detail: detail ?? null,
      roomCode: roomCode,
      clientNow: Date.now(),
      hostView: (typeof hostView !== "undefined") ? hostView : null,
      hostPhase: (typeof hostPhase !== "undefined") ? hostPhase : null,
      playerJoined: (typeof playerState !== "undefined" && playerState) ? !!playerState.joined : null,
    });
  }catch(e){}
}


// [ANCHOR] MB:F:DEBUG:SNAPSHOT_RESPONSE — respond with local debug dump for ZIP bundling
socket.on("debug:snapshot-request", (p) => {
  try{
    const reqId = String(p?.requestId || "");
    const roomCode = String(p?.roomCode || (typeof currentRoom !== "undefined" ? currentRoom : "") || "").toUpperCase().trim();
    const dump = getDebugDump();
    const role = (typeof currentScreenName !== "undefined" && currentScreenName) ? String(currentScreenName) : null;
    const nick = (typeof playerState !== "undefined" && playerState?.nickname) ? String(playerState.nickname) : null;
    socket.emit("debug:snapshot-response", {
      requestId: reqId,
      roomCode,
      role,
      nick,
      clientNow: Date.now(),
      dump
    });
  }catch(e){}
});

// Server timer diagnostics (schedule/fire/clear/watchdog)

// [ANCHOR] MB:F:SOCKET:TIMER_DEBUG
socket.on("timer-debug", (p) => {
  try{
    const action = p?.action ? String(p.action) : "timer";
    pushDebug(`timer:${action}`, p);
  }catch(e){}
});


// [ANCHOR] MB:F:DEBUG_ROOM_SYNC — unified DEBUG toggle + room timeline tools (host)
function canRoomDebug(){
  return screens?.host && !screens.host.classList.contains("hidden") && !!currentRoom;
}
function requestDebugSnapshot(){
  if(!canRoomDebug()) return;
  socket.emit("host-debug-snapshot", { roomCode: currentRoom }, (res)=> pushDebug("host-debug-snapshot", res));
}
function setRoomDebugEnabled(enabled){
  if(!canRoomDebug()) return;
  socket.emit("host-debug-set", { roomCode: currentRoom, enabled: !!enabled }, (res)=> pushDebug("host-debug-set", res));
}
function clearRoomTimeline(){
  if(!canRoomDebug()) return;
  socket.emit("host-debug-clear", { roomCode: currentRoom }, (res)=> pushDebug("host-debug-clear", res));
}

// UI buttons
$("debug-enabled")?.addEventListener("change", (e)=>{
  const v = !!e?.target?.checked;
  setDebugEnabled(v);
  if(canRoomDebug()) setRoomDebugEnabled(v);
});
$("debug-snapshot")?.addEventListener("click", ()=> requestDebugSnapshot());
$("debug-tl-clear")?.addEventListener("click", ()=> clearRoomTimeline());

// Server signals
socket.on("debug-state", (p)=>{
  try{
    const t = $("debug-room-state");
    if(t) t.textContent = `Room debug: ${p?.debugEnabled ? "ON" : "OFF"} · TL: ${Number(p?.timelineSize||0)}`;
  }catch(e){}
});
socket.on("debug-snapshot", (p)=>{
  try{
    serverTimeline = Array.isArray(p?.timeline) ? p.timeline : [];
    const t = $("debug-room-state");
    if(t) t.textContent = `Room debug: ${p?.debugEnabled ? "ON" : "OFF"} · TL: ${serverTimeline.length}`;
    renderServerTimeline();
  }catch(e){}
});
socket.on("debug-timeline", (entry)=>{
  try{
    if(!entry) return;
    serverTimeline.unshift(entry);
    if(serverTimeline.length > 320) serverTimeline.length = 320;
    renderServerTimeline();
  }catch(e){}
});



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


// [ANCHOR] MB:F:SOCKET:CONNECT
socket.on("connect", () => {
  pushDebug("socket", { event:"connect", id: socket.id });
  setPill("host-conn", true);
  setPill("host-conn2", true);
  setPill("player-conn", true);
  setPill("admin-conn", true);

  // auto-rejoin for player if we have session and player screen visible
  const room = localStorage.getItem(LS_ROOM) || "";
  const nick = localStorage.getItem(LS_NICK) || "";
  if (room && nick && !playerState.joined && !screens.player?.classList.contains("hidden")){
    joinRoom(room, nick, true);
  }
  // auto-rejoin for host if we have host session and host screen is visible
  try{ hostTryRejoin("socket_connect"); }catch(e){}
});

// [ANCHOR] MB:F:SOCKET:DISCONNECT
socket.on("disconnect", (r) => {
  pushDebug("socket", { event:"disconnect", reason: r });
  setPill("host-conn", false);
  setPill("host-conn2", false);
  setPill("player-conn", false);
  setPill("admin-conn", false);
});

// -------- Shared state
let currentRoom = "";
let hostState = { totalRounds: 5, tasks: [], round: 0, scores: {} };
let playerState = { joined: false, playerId: "", nickname: "", roomCode: "", hasVotedLocal: false, readyNextLocal: false };
// [ANCHOR] MB:F:PLAYER_SCORE_STATE — last known score for debug + UI sync
let playerLastScore = null;
let lastRoomStatus = null;
let nextUiDelayDone = false;
let nextUiRoundNumber = 0;
let hostAutoNextLock = false;

// [ANCHOR] MB:F:PLAYER_TIMER — yellow pill timer on player submit screen
let playerTimerState = {
  active: false,
  phase: "",
  endsAt: 0,
  serverOffsetMs: 0,
  tickHandle: null,
  lastSec: null,
  lastSig: ""
};

function getPlayerTimerEl(){
  return document.getElementById("player-round-timer") ||
         document.getElementById("pTimerPill") ||
         document.getElementById("player-timer");
}

function isPlayerScreenVisible(){
  try{ return screens.player && !screens.player.classList.contains("hidden"); }catch(e){ return false; }
}

function playerTimerAlignedNow(){
  return Date.now() - (Number(playerTimerState.serverOffsetMs) || 0);
}

function playerTimerStop(reason){
  const wasActive = !!playerTimerState.active || !!playerTimerState.tickHandle;
  try{ if(playerTimerState.tickHandle){ clearInterval(playerTimerState.tickHandle); } }catch(e){}
  playerTimerState.tickHandle = null;
  playerTimerState.active = false;
  playerTimerState.phase = "";
  playerTimerState.endsAt = 0;
  playerTimerState.lastSec = null;
  const el = getPlayerTimerEl();
  if(el) el.classList.add("hidden");
  if(wasActive && reason){ pushDebug("playerTimer:stop", { reason }); }
}

function playerTimerUpdate(force){
  const el = getPlayerTimerEl();
  if(!el){
    if(force) pushDebug("playerTimer:missing_el", {});
    return;
  }
  if(!isPlayerScreenVisible()){
    el.classList.add("hidden");
    return;
  }
  const endsAt = Number(playerTimerState.endsAt || 0);
  if(!endsAt){
    el.classList.add("hidden");
    return;
  }
  const leftMs = endsAt - playerTimerAlignedNow();
  let sec = Math.ceil(leftMs/1000);
  if(!Number.isFinite(sec)) sec = 0;
  sec = Math.max(0, sec);

  if(!force && sec === playerTimerState.lastSec) return;
  playerTimerState.lastSec = sec;

  el.textContent = String(sec);
  el.classList.remove("ok","warn","crit","bounce");
  if(sec <= 10) el.classList.add("crit");
  else if(sec <= 20) el.classList.add("warn");
  else el.classList.add("ok");

  el.classList.toggle("hidden", sec <= 0);

  // bounce each tick when <=10
  if(sec <= 10 && sec > 0){
    el.classList.remove("bounce");
    void el.offsetWidth;
    el.classList.add("bounce");
  }
}

function playerTimerStart(){
  if(playerTimerState.tickHandle) return;
  playerTimerState.tickHandle = setInterval(()=>playerTimerUpdate(false), 1000);
}

function playerTimerSyncFromStatus(st){
  try{
    if(!st) return;
    if(!playerState.joined) return;
    if(st.roomCode && playerState.roomCode && String(st.roomCode) !== String(playerState.roomCode)) return;

    const phase = String(st.phase || "");
    const serverNow = Number(st.serverNow || 0);
    if(serverNow > 0){
      playerTimerState.serverOffsetMs = Date.now() - serverNow;
    }

    const collectEndsAt = Number(st.collectEndsAt || 0);
    const sig = `${phase}|${st.roundNumber||0}|${collectEndsAt}|${serverNow}`;
    if(sig !== playerTimerState.lastSig){
      playerTimerState.lastSig = sig;
      pushDebug("playerTimer:status", {
        phase,
        roundNumber: st.roundNumber,
        collectEndsAt,
        serverNow,
        offsetMs: playerTimerState.serverOffsetMs
      });
    }

    if(phase === "collect" && collectEndsAt > 0){
      playerTimerState.active = true;
      playerTimerState.phase = phase;
      playerTimerState.endsAt = collectEndsAt;
      const el = getPlayerTimerEl();
      if(el) el.classList.remove("hidden");
      playerTimerUpdate(true);
      playerTimerStart();
    } else {
      playerTimerStop(`phase:${phase || "?"}`);
    }
  }catch(e){
    pushDebug("playerTimer:error", { msg: String((e && e.message) || e) });
  }
}

window.__mbPlayerTimerState = playerTimerState;

function getMandatoryReadyStats(st){
  const players = Array.isArray(st?.players) ? st.players : [];
  const mandatory = players.filter(p => p && p.connected && p.hasVoted);
  const total = mandatory.length;
  const ready = mandatory.filter(p => !!p.readyNext).length;
  return { mandatory, total, ready };
}


// [ANCHOR] MB:F:HOST_MINI_STATUS — voted/ready/missed shown on host voting + winner
function updateHostMiniStatus(st){
  const isHost = screens?.host && !screens.host.classList.contains("hidden");
  if(!isHost) return;

  const players = Array.isArray(st?.players) ? st.players : [];
  const connected = players.filter(p => p && p.connected);
  const voted = connected.filter(p => !!p.hasVoted);
  const missed = connected.filter(p => !!p.missedVote);
  const mandatory = connected.filter(p => !!p.hasVoted);
  const ready = mandatory.filter(p => !!p.readyNext);

  // Host voting HUD
  const stats = $("host-vote-mini-stats");
  const list = $("host-vote-mini-list");
  const btnForce = $("host-vote-force-next");

  if(st?.phase === "vote"){
    if(stats){
      if(mandatory.length <= 0){
        stats.textContent = st.voteComplete
          ? "0 проголосовавших — авто-переход OFF (только хост)"
          : `Проголосовало: 0 / ${connected.length}`;
      } else {
        stats.textContent = `Voted ${voted.length}/${connected.length} · Ready ${ready.length}/${mandatory.length} · Missed ${missed.length}`;
      }
    }
    if(btnForce){
      // Emergency next round only after winner exists (voteComplete)
      btnForce.disabled = !st.voteComplete;
    }
    if(list){
      list.innerHTML = "";
      players.forEach(p=>{
        const tags = [];
        if(!p.connected) tags.push("📡");
        if(p.hasVoted) tags.push("🗳️");
        if(p.readyNext) tags.push("✅");
        if(p.missedVote) tags.push("💤");
        const el = document.createElement("div");
        el.className = "hostVoteMiniItem";
        el.textContent = `${p.nickname} ${tags.join("")}`;
        list.appendChild(el);
      });
    }
  } else {
    if(stats) stats.textContent = "";
    if(list) list.innerHTML = "";
    if(btnForce) btnForce.disabled = true;
  }

  // Winner overlay host controls (counts only)
  const wstats = $("winner-host-mini-stats");
  if(wstats){
    wstats.textContent = mandatory.length > 0
      ? `Ready ${ready.length}/${mandatory.length} · Missed ${missed.length}`
      : `0 проголосовавших`;
  }
}


function updateNextRoundUI() {
  const st = lastRoomStatus;

  // Host: show readiness after voteComplete (phase-agnostic for compatibility)
  const hostReady = $("host-ready-next");
  if (hostReady) {
    if (st && st.voteComplete) {
      const { total, ready } = getMandatoryReadyStats(st);
      hostReady.textContent = total > 0
        ? `Готовы к следующему раунду (обязательные): ${ready}/${total}`
        : `Никто не голосовал — авто-переход выключен (только хост)`;
      hostReady.classList.remove("hidden");
    } else {
      hostReady.classList.add("hidden");
    }
  }

  // Player: next-round button must live inside Winner overlay (mobile-friendly).
  const isPlayerScreen = !!(screens?.player && !screens.player.classList.contains("hidden"));
  const ov = $("winner-overlay");
  const overlayVisible = !!(ov && !ov.classList.contains("hidden"));

  const wrap = $("player-next-wrap");
  const btn = $("player-next-round");
  const wait = $("player-next-wait");

  const wWrap = $("winner-player-controls");
  const wBtn = $("winner-player-next-round");
  const wWait = $("winner-player-next-wait");

  // voteComplete compatibility: older server versions could switch phase to "finished"
  const voteDone = !!(st && (st.voteComplete || ["finished", "winner", "end"].includes(String(st.phase || ""))));

  // We consider it "winner context" if overlay is open OR we've already received voting-finished.
  const inWinnerContext = overlayVisible || (nextUiRoundNumber > 0);

  const me = (st && Array.isArray(st.players))
    ? st.players.find(p => p.id === playerState.playerId)
    : null;

  const meConnected = (me && typeof me.connected === "boolean") ? me.connected : true; // if missing -> assume true
  const meVoted = (me && typeof me.hasVoted === "boolean") ? me.hasVoted : !!playerState.hasVotedLocal;
  const meMissed = (me && typeof me.missedVote === "boolean") ? me.missedVote : false;
  const meReady = (me && typeof me.readyNext === "boolean") ? me.readyNext : !!playerState.readyNextLocal;

  const canSee = !!(
    isPlayerScreen &&
    voteDone &&
    inWinnerContext &&
    meConnected &&
    meVoted &&
    !meMissed
  );

  const { total, ready } = (st ? getMandatoryReadyStats(st) : { total: 0, ready: 0 });
  const waitText = (!voteDone)
    ? "Ожидание победителя…"
    : (total > 0
      ? `Ожидание игроков: ${ready}/${total} готовы`
      : "Никто не голосовал — авто-переход выключен (только хост)");

  // --- Winner overlay button (primary path)
  if (wWrap && wBtn && wWait) {
    if (!isPlayerScreen) {
      wWrap.classList.add("hidden");
    } else if (overlayVisible && canSee) {
      wWrap.classList.remove("hidden");
      wBtn.disabled = meReady;
      wBtn.textContent = meReady ? "✅ Готов" : "Готов";
      wWait.textContent = waitText;
    } else {
      wWrap.classList.add("hidden");
      wBtn.disabled = false;
      wBtn.textContent = "Готов";
      wWait.textContent = "";
    }
  }

  // --- Legacy button (fallback)
  if (wrap && btn && wait) {
    if (overlayVisible) {
      // legacy will be under overlay; hide to avoid confusion
      wrap.classList.add("hidden");
      btn.disabled = false;
      btn.textContent = "Готов";
      wait.textContent = "";
    } else if (canSee) {
      wrap.classList.remove("hidden");
      btn.disabled = meReady;
      btn.textContent = meReady ? "✅ Готов" : "Готов";
      wait.textContent = waitText;
    } else {
      wrap.classList.add("hidden");
      btn.disabled = false;
      btn.textContent = "Готов";
      wait.textContent = "";
    }
  }

  // [ANCHOR] MB:F:WINNER_NEXT:DEBUG — small, non-spammy debug about visibility decisions
  try{
    const key = JSON.stringify({ overlayVisible, canSee, voteDone, meVoted: !!meVoted, meMissed: !!meMissed, meConnected: !!meConnected, meReady: !!meReady });
    if (window.__mb_lastNextUiKey !== key) {
      window.__mb_lastNextUiKey = key;
      pushDebug("winner-next-ui", { overlayVisible, canSee, voteDone, meVoted: !!meVoted, meMissed: !!meMissed, meConnected: !!meConnected, meReady: !!meReady });
    }
  }catch(e){}
}



// [ANCHOR] MB:F:WINNER_OVERLAY — winner/tie celebration (no auto-close if displayMs<=0)
function showWinnerOverlay(payloadOrWinner = {}) {
  const ov = $("winner-overlay");
  if (!ov) return Promise.resolve();

  // Host-only controls
  try{
    // [BUGWATCH] Rely on currentRoom (host-created) instead of screen visibility.
    const isHostClient = !!currentRoom;
    $("winner-host-controls")?.classList.toggle("hidden", !isHostClient);
  }catch(e){}

  // Accept both formats:
  // 1) payload: { winners, winner, maxVotes, displayMs, tie }
  // 2) direct winner object: { url, caption, nickname, votes }
  const looksLikePayload = payloadOrWinner && typeof payloadOrWinner === "object" && (
    Array.isArray(payloadOrWinner.winners) ||
    payloadOrWinner.winner ||
    payloadOrWinner.maxVotes !== undefined ||
    payloadOrWinner.displayMs !== undefined ||
    payloadOrWinner.tie !== undefined
  );

  const payload = looksLikePayload ? payloadOrWinner : { winner: payloadOrWinner };

  let winners = Array.isArray(payload.winners)
    ? payload.winners
    : (payload.winner ? [payload.winner] : []);

  let displayMs = Number.isFinite(Number(payload.displayMs)) ? Number(payload.displayMs) : 3000;
  if (!Number.isFinite(displayMs)) displayMs = 3000;
  displayMs = Math.max(0, Math.round(displayMs));

  // Build fallback meme map from latest room-status (revealed during vote) and host cache
  const fallbackMemes = []
    .concat(Array.isArray(lastRoomStatus?.memes) ? lastRoomStatus.memes : [])
    .concat(Array.isArray(hostLatestMemes) ? hostLatestMemes : []);

  const byId = new Map();
  for (const m of fallbackMemes) {
    const id = m && (m.id || m.memeId);
    if (id) byId.set(String(id), m);
  }

  // Derive winners from fallback votes (handles ties even if server only sent single winner)
  if (byId.size > 0 && String(payload?.reason || "") !== "no_votes") {
    let maxVotes = -Infinity;
    for (const m of byId.values()) {
      const v = Number(m?.votes ?? 0);
      if (Number.isFinite(v) && v > maxVotes) maxVotes = v;
    }
    if (Number.isFinite(maxVotes) && maxVotes >= 0) {
      const derived = Array.from(byId.values())
        .filter(m => Number(m?.votes ?? 0) === maxVotes)
        .map(m => ({ id: m.id || m.memeId, url: m.url || m.memeUrl, caption: m.caption || "", nickname: m.nickname || "", votes: Number(m.votes || 0) }));

      if (winners.length === 0) winners = derived;
      else if (winners.length === 1 && derived.length > 1) winners = derived;
    }
  }

  const norm = (w) => {
    if (!w) return null;
    const id = w.id ?? w.memeId ?? null;
    const src = id ? byId.get(String(id)) : null;

    const url =
      w.url || w.memeUrl || w.src || w.dataUrl ||
      (src ? (src.url || src.memeUrl || src.src || src.dataUrl) : null);

    const caption = (w.caption ?? (src ? src.caption : "")) || "";
    const nickname = (w.nickname ?? (src ? src.nickname : "")) || "";
    const votesRaw = (w.votes ?? (src ? src.votes : null));
    const votes = Number.isFinite(Number(votesRaw)) ? Number(votesRaw) : 0;

    return { id, url, caption, nickname, votes };
  };

  const list = winners.map(norm).filter(Boolean);
  const isTie = list.length > 1;

  // Apply mode + sizing
  ov.classList.toggle("ws-tie", isTie);
  ov.classList.toggle("ws-win", !isTie);
  ov.style.setProperty("--wsMaxH", isTie ? "25vh" : "30vh");

  // Title + emoji
  const titleEl = $("winner-title");
  const reasonStr = String(payload?.reason || "");
  if (titleEl){
    if(list.length === 0){
      if(reasonStr === "no_memes") titleEl.textContent = "NO MEMES";
      else if(reasonStr === "no_votes") titleEl.textContent = "NO VOTES";
      else if(reasonStr === "no_players") titleEl.textContent = "NO PLAYERS";
      else titleEl.textContent = "ROUND ENDED";
    } else {
      titleEl.textContent = isTie ? "IT'S A TIE!" : "ROUND WINNER";
    }
  }

  const emojiEl = $("winner-emoji");
  if (emojiEl) emojiEl.textContent = isTie ? "🤝" : "🏆";

  // Confetti regen
  const confBox = $("winner-confetti");
  if (confBox) {
    confBox.innerHTML = "";
    for (let i = 0; i < 20; i++) {
      const el = document.createElement("div");
      el.className = "wsConf";
      el.style.setProperty("--x", `${Math.random() * 100}%`);
      el.style.setProperty("--delay", `${(Math.random() * 0.5).toFixed(2)}s`);
      el.style.setProperty("--dur", `${(2 + Math.random() * 2).toFixed(2)}s`);
      confBox.appendChild(el);
    }
  }

  // Cards
  const cardsBox = $("winner-cards");
  if (cardsBox) {
    cardsBox.innerHTML = "";

    const makeCard = (w, idx) => {
      const wrap = document.createElement("div");
      wrap.className = "wsCardWrap";
      wrap.style.setProperty("--wsRot", isTie ? (idx % 2 === 0 ? "-10deg" : "10deg") : "0deg");

      // Glow
      const glow = document.createElement("div");
      glow.className = "wsGlow";
      wrap.appendChild(glow);

      // TIE badge (only if tie)
      if (isTie) {
        const tie = document.createElement("div");
        tie.className = "wsTieBadge";
        tie.textContent = "TIE";
        tie.style.transitionDelay = `${0.7 + idx * 0.1}s`;
        wrap.appendChild(tie);
      }

      const card = document.createElement("div");
      card.className = "wsCard";
      card.style.transitionDelay = `${0.5 + idx * 0.1}s`;

      // WINNER pill
      const pill = document.createElement("div");
      pill.className = "wsWinnerPill";
      pill.innerHTML = `<span aria-hidden="true">🏆</span> WINNER`;
      card.appendChild(pill);

      // Media
      const media = document.createElement("div");
      media.className = "wsMedia";
      if (w && w.url) {
        media.innerHTML = renderMemeHTML(w);
      } else {
        media.innerHTML = `<div class="muted" style="padding:12px">Нет медиа</div>`;
      }
      card.appendChild(media);

      // Meta
      const meta = document.createElement("div");
      meta.className = "wsMeta";
      const name = document.createElement("div");
      name.className = "wsName";
      name.textContent = w && w.nickname ? String(w.nickname) : "PLAYER";

      const cap = document.createElement("div");
      cap.className = "wsCaption";
      const capTxt = (w && w.caption) ? String(w.caption) : "";
      const vTxt = Number.isFinite(Number(w?.votes)) ? String(Number(w.votes)) : "0";
      cap.textContent = capTxt ? capTxt : (vTxt ? `Votes: ${vTxt}` : "");

      meta.appendChild(name);
      meta.appendChild(cap);
      card.appendChild(meta);

      wrap.appendChild(card);
      return wrap;
    };

    if (list.length === 0) {
      let emptyCap = "Нет данных";
      const r = String(payload?.reason || "");
      if(r === "no_memes") emptyCap = "Никто не отправил мем";
      else if(r === "no_players") emptyCap = "Нет игроков";
      else if(r === "no_votes") emptyCap = "Никто не проголосовал";
      else if(r === "timer" && (payload?.stats?.votedOnline === 0)) emptyCap = "Никто не проголосовал";
      cardsBox.appendChild(makeCard({ nickname: "—", caption: emptyCap, url: "" }, 0));
    } else {
      list.forEach((w, idx) => cardsBox.appendChild(makeCard(w, idx)));
    }
  }

  // Ensure TikTok vars are applied inside overlay (if any)
  try { applyTTVars && applyTTVars(); } catch (e) {}

  // Cancel previous timers (if overlay is retriggered)
  if (window.__MB_WIN_TO) clearTimeout(window.__MB_WIN_TO);
  if (window.__MB_WIN_TO2) clearTimeout(window.__MB_WIN_TO2);

  ov.classList.remove("hidden");
  ov.setAttribute("aria-hidden", "false");

  // Restart entrance animation
  ov.classList.remove("ws-leave");
  ov.classList.remove("ws-on");
  void ov.offsetWidth;
  ov.classList.add("ws-on");

  // If displayMs <= 0 => keep overlay visible (it will be hidden on next round start).
  if (displayMs <= 0) return Promise.resolve();

  return new Promise((resolve) => {
    window.__MB_WIN_TO = setTimeout(() => {
      ov.classList.remove("ws-on");
      ov.classList.add("ws-leave");
      window.__MB_WIN_TO2 = setTimeout(() => {
        ov.classList.add("hidden");
        ov.classList.remove("ws-leave");
        ov.setAttribute("aria-hidden", "true");
        resolve();
      }, 240);
    }, displayMs);
  });
}


function hideWinnerOverlay(){
  const ov = $("winner-overlay");
  if(!ov) return;
  if (window.__MB_WIN_TO) clearTimeout(window.__MB_WIN_TO);
  if (window.__MB_WIN_TO2) clearTimeout(window.__MB_WIN_TO2);
  ov.classList.add("hidden");
  ov.classList.remove("ws-on");
  ov.classList.remove("ws-leave");
  ov.setAttribute("aria-hidden", "true");
}


// =====================================================================
// [ANCHOR] MB:F:FINAL_OVERLAY — Host Final Results full-screen stage
// =====================================================================
function hideFinalOverlay(){
  const ov = $("final-overlay");
  if(!ov) return;
  ov.classList.add("hidden");
  ov.classList.remove("fs-on");
  // [ANCHOR] MB:F:FINAL_OVERLAY_PLAYER_RESET — clear player-mode styling (prevents sticky UI)
  ov.classList.remove("fs-player");
  ov.setAttribute("aria-hidden", "true");
}

// =====================================================================
// [ANCHOR] MB:F:FINAL_OVERLAY_SHOW — supports host + player (score-only)
// =====================================================================
function showFinalOverlay(results = [], opts = {}){
  const ov = $("final-overlay");
  if(!ov) return;

  const mode = String(opts?.mode || (currentRoom ? "host" : "player"));
  const isPlayerMode = (mode === "player");
  // Apply player-only styling (score-only final screen)
  ov.classList.toggle("fs-player", isPlayerMode);

  // Host-only button should never be visible for players
  try{ $("final-host-new-game")?.classList.toggle("hidden", isPlayerMode); }catch(e){}

  // Ensure other full-screen stages are not blocking interaction
  try{ hideWinnerOverlay(); }catch(e){}

  const raw = Array.isArray(results) ? results : [];
  const players = raw
    .map(r => ({
      name: String(r?.name || r?.nickname || "").trim(),
      score: Number(r?.score || 0)
    }))
    .map(p => ({ name: p.name || "PLAYER", score: Number.isFinite(p.score) ? p.score : 0 }))
    .sort((a,b)=> b.score - a.score);

  const winner = players[0] || { name: "—", score: 0 };
  const topScore = Number.isFinite(winner.score) ? Number(winner.score) : 0;
  const tiedPlayers = players.filter(p => Number(p.score) === topScore);
  const isTie = tiedPlayers.length > 1;
  const topThree = players.slice(0,3);
  const restPlayers = players.slice(3);

  // Winner fields
  const wn = $("final-winner-name");
  const ws = $("final-winner-score");
  if(wn){
    if(isTie){
      const names = tiedPlayers.map(p => String(p.name || "PLAYER")).filter(Boolean);
      const shown = names.slice(0, 3);
      let label = shown.join(" • ");
      if(names.length > 3) label += ` +${names.length - 3}`;
      wn.textContent = label || "—";
    } else {
      wn.textContent = String(winner.name || "—");
    }
  }
  if(ws) ws.textContent = String(Number(winner.score || 0));

  // Player-only: show "ПОБЕДИТЕЛЬ" label and tie state.
  // Host should remain unchanged.
  const champEl = ov.querySelector?.('.fsChampion');
  if(champEl){
    if(isPlayerMode) champEl.textContent = isTie ? "НИЧЬЯ" : "ПОБЕДИТЕЛЬ";
    else champEl.textContent = "CHAMPION";
  }

  // TOP 3 (host only). Player mode is score-only.
  const topBox = $("final-top3");
  if(topBox) topBox.innerHTML = "";
  if(!isPlayerMode && topBox){
    const medals = ["🥇","🥈","🥉"];
    topThree.forEach((p, idx)=>{
      const row = document.createElement("div");
      row.className = `fsTopRow place${idx+1}`;
      row.style.setProperty("--d", `${0.3 + idx*0.1}s`);

      const medal = document.createElement("div");
      medal.className = "fsMedal";
      medal.textContent = medals[idx] || "🏅";

      const pos = document.createElement("div");
      pos.className = "fsPosBadge";
      pos.textContent = String(idx+1);

      const name = document.createElement("div");
      name.className = "fsPName";
      name.textContent = String(p.name || "PLAYER");

      const pts = document.createElement("div");
      pts.className = "fsScorePill";
      pts.textContent = String(Number(p.score || 0));

      row.appendChild(medal);
      row.appendChild(pos);
      row.appendChild(name);
      row.appendChild(pts);
      topBox.appendChild(row);
    });
  }

  // Rest
  const restWrap = $("final-rest-wrap");
  const restBox = $("final-rest");
  if(restWrap && restBox){
    restBox.innerHTML = "";
    restWrap.classList.toggle("hidden", restPlayers.length === 0);

    // Player mode: keep it hidden no matter what
    if(isPlayerMode) restWrap.classList.add("hidden");

    if(!isPlayerMode) restPlayers.forEach((p, idx)=>{
      const row = document.createElement("div");
      row.className = "fsRestRow";
      row.style.setProperty("--d", `${0.6 + idx*0.05}s`);

      const pos = document.createElement("div");
      pos.className = "fsRestPos";
      pos.textContent = String(idx + 4);

      const name = document.createElement("div");
      name.className = "fsRestName";
      name.textContent = String(p.name || "PLAYER");

      const score = document.createElement("div");
      score.className = "fsRestScore";
      score.textContent = String(Number(p.score || 0));

      row.appendChild(pos);
      row.appendChild(name);
      row.appendChild(score);
      restBox.appendChild(row);
    });
  }

  ov.classList.remove("hidden");
  ov.setAttribute("aria-hidden", "false");

  // Restart entrance animations
  ov.classList.remove("fs-on");
  void ov.offsetWidth;
  ov.classList.add("fs-on");

  pushDebug("final-overlay:show", { mode, players: players.length, winner: winner.name, winnerScore: winner.score, isTie, tied: tiedPlayers.map(p=>p.name).slice(0,6) });
}



let hostLatestMemes = [];
let hostMemesCount = 0;
let hostMemesRevealed = false;
let hostPhase = "lobby";


// [ANCHOR] MB:F:HOST_SETUP — create room, tasks, start game
// -------- Host UI
function hostSetRoom(code){
  currentRoom = code;
  try{ if(code) localStorage.setItem(LS_HOST_ROOM, String(code).toUpperCase().trim()); }catch(e){}
  const c = String(code || "").trim().toUpperCase();

  $("host-room-code").textContent = c || "—";
  if ($("host-room-code-mini")) $("host-room-code-mini").textContent = c || "—";

  const link = c ? `${location.origin}/?room=${encodeURIComponent(c)}` : "";
  if ($("host-room-link")) $("host-room-link").textContent = link;
  if ($("host-room-link-input")) $("host-room-link-input").value = link;

  // QR
  const qrData = encodeURIComponent(link || "");
  const qrSrc = `https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=${qrData}`;
  const img = $("host-qr-img");
  const imgBig = $("qr-overlay-img");
  if (img) img.src = qrSrc;
  if (imgBig) imgBig.src = `https://api.qrserver.com/v1/create-qr-code/?size=520x520&data=${qrData}`;

  const fullBtn = $("host-qr-full");
  if (fullBtn) fullBtn.disabled = !c;

  // Toggle setup blocks
  $("host-room-pre")?.classList.toggle("hidden", !!c);
  $("host-setup-steps")?.classList.toggle("hidden", !!c);
  $("host-room-post")?.classList.toggle("hidden", !c);

  // Buttons
  if ($("host-start-game")) $("host-start-game").disabled = !c;
  if ($("ai-generate")) $("ai-generate").disabled = !c || !aiState.enabled;

  // [ANCHOR] MB:DEBUG:hostSetRoom — sync room debug toggle + fetch snapshot
  try{
    if(c && DEBUG){ setRoomDebugEnabled(true); requestDebugSnapshot(); }
    if(c && !DEBUG){ setRoomDebugEnabled(false); }
  }catch(e){}
}

$("host-copy-link")?.addEventListener("click", async () => {
  const btn = $("host-copy-link");
  const link = $("host-room-link-input")?.value || $("host-room-link")?.textContent || "";
  if(!link) return;
  try{
    await navigator.clipboard.writeText(link);
    if(btn){ const t = btn.textContent; btn.textContent = "✓"; setTimeout(()=>{ btn.textContent = t; }, 2000); }
    pushDebug("copy:link", "ok");
  }catch(e){
    pushDebug("copy:link", String(e));
  }
});


$("host-copy-code")?.addEventListener("click", async () => {
  const btn = $("host-copy-code");
  const code = $("host-room-code")?.textContent || "";
  if(!code || code === "—") return;
  try{
    await navigator.clipboard.writeText(code);
    if(btn){ const t = btn.textContent; btn.textContent = "✓"; setTimeout(()=>{ btn.textContent = t; }, 2000); }
    pushDebug("copy:code", "ok");
  }catch(e){
    pushDebug("copy:code", String(e));
  }
});

// --- QR overlay
$("host-qr-full")?.addEventListener("click", () => {
  const link = $("host-room-link-input")?.value || $("host-room-link")?.textContent || "";
  $("qr-overlay-link").textContent = link || "—";
  $("qr-overlay").classList.remove("hidden");
});
$("qr-close")?.addEventListener("click", () => $("qr-overlay").classList.add("hidden"));
$("qr-overlay")?.addEventListener("click", (e) => {
  if (e.target && e.target.id === "qr-overlay") $("qr-overlay").classList.add("hidden");
});
$("qr-copy")?.addEventListener("click", async () => {
  const link = $("host-room-link-input")?.value || $("host-room-link")?.textContent || "";
  try{ await navigator.clipboard.writeText(link); pushDebug("qr:copy", "ok"); }catch(e){ pushDebug("qr:copy", String(e)); }
});
$("host-create-room")?.addEventListener("click", () => {
  socket.emit("host-create-room", (res) => {
    pushDebug("host-create-room", res);
    if(!res?.ok) return alert(res?.error || "Ошибка");
    hostSetRoom(res.roomCode);
    try{ if(res?.roomCode) localStorage.setItem(LS_HOST_ROOM, String(res.roomCode).toUpperCase().trim()); }catch(e){}
    try{ if(res?.hostToken) localStorage.setItem(LS_HOST_TOKEN, String(res.hostToken)); }catch(e){}
    $("host-start-game").disabled = false;
    $("host-end-game").disabled = false;
  });
});

// --- Admin mode (player card calibration)
function setAdminVisible(on){
  // Keep header visible; toggle only the controls grid
  document.querySelector("#admin-panel .admin-grid")?.classList.toggle("hidden", !on);
}

// Persist admin mode UI state (per device)
try{
  const saved = localStorage.getItem("mb_admin_enabled");
  if(saved === "1") $("admin-enabled") && ($("admin-enabled").checked = true);
}catch(e){}
setAdminVisible(!!$("admin-enabled")?.checked);
$("admin-enabled")?.addEventListener("change", ()=>{
  const on = !!$("admin-enabled")?.checked;
  try{ localStorage.setItem("mb_admin_enabled", on ? "1" : "0"); }catch(e){}
  setAdminVisible(on);
});
function renderCalibrationPreview(){
  const box = $("cal-preview");
  if(!box) return;
  // Render a fixed TikTok video so the host can tune height/anchor/crop
  box.innerHTML = renderMediaHTML(CALIBRATION_TIKTOK_URL);
  refreshCalibRangesSoon();
}

$("cal-zoom-minus")?.addEventListener("click", () => nudgeRange("cal-zoom", -0.05, 0.1, 2.0));
$("cal-zoom-plus")?.addEventListener("click", () => nudgeRange("cal-zoom", 0.05, 0.1, 2.0));

$("cal-open-video")?.addEventListener("click", () => {
  try{ window.open(CALIBRATION_TIKTOK_URL, "_blank", "noopener"); }catch(e){}
});

function fillAdminFrom(pc){
  const p = normalizePlayerCard(pc || DEFAULT_PLAYER_CARD);
  if ($("cal-card-w")) $("cal-card-w").value = String(p.cardWidthPx);
  if ($("cal-card-wv")) $("cal-card-wv").textContent = String(p.cardWidthPx);
  if ($("cal-card-h")) $("cal-card-h").value = String(p.cardHeightPx);
  if ($("cal-card-hv")) $("cal-card-hv").textContent = String(p.cardHeightPx);
  if ($("cal-crop-x")) $("cal-crop-x").value = String(p.cropSidePx ?? 0);
  if ($("cal-crop-xv")) $("cal-crop-xv").textContent = String(p.cropSidePx ?? 0);
  if ($("cal-crop-b")) $("cal-crop-b").value = String(p.cropBottomPx);
  if ($("cal-crop-bv")) $("cal-crop-bv").textContent = String(p.cropBottomPx);
  if ($("cal-anchor-y")) $("cal-anchor-y").value = p.anchorY;
  if ($("cal-zoom")) $("cal-zoom").value = String(p.scale ?? 1);
  if ($("cal-zoomv")) $("cal-zoomv").textContent = String(Number(p.scale ?? 1).toFixed(2));
}

function readAdminCalib(){
  const cardWidthPx = Number($("cal-card-w")?.value || DEFAULT_PLAYER_CARD.cardWidthPx);
  const cardHeightPx = Number($("cal-card-h")?.value || DEFAULT_PLAYER_CARD.cardHeightPx);
  const cropSidePx = Number($("cal-crop-x")?.value || DEFAULT_PLAYER_CARD.cropSidePx || 0);
  const cropBottomPx = Number($("cal-crop-b")?.value || DEFAULT_PLAYER_CARD.cropBottomPx);
  const anchorY = String($("cal-anchor-y")?.value || DEFAULT_PLAYER_CARD.anchorY);
  const scale = Number($("cal-zoom")?.value || DEFAULT_PLAYER_CARD.scale || 1);
  return normalizePlayerCard({ cardWidthPx, cardHeightPx, cropSidePx, cropBottomPx, anchorY, scale });
}

let adminDraftPlayerCard = null;

function flashSaved(id){
  const el = $(id);
  if(!el) return;
  try{ el.textContent = "Сохранено ✓"; }catch(e){}
  clearTimeout(el._t);
  el._t = setTimeout(()=>{ try{ el.textContent=""; }catch(e){} }, 1600);
}

function computeAnyTTWrapperWidth(){
  let max = 0;
  document.querySelectorAll(".mediaFrame.ttFrame").forEach(el=>{
    const w = el.getBoundingClientRect().width;
    if(w > max) max = w;
  });
  return Math.floor(max || 0);
}

function computeWrapperWidthIn(containerId){
  const c = $(containerId);
  if(c){
    const el = c.querySelector?.(".mediaFrame.ttFrame") || c;
    const w = el.getBoundingClientRect?.().width || 0;
    if(w > 50) return Math.floor(w);
  }
  const any = computeAnyTTWrapperWidth();
  if(any > 50) return any;
  return Math.floor((c?.getBoundingClientRect?.().width || 0));
}

let _calibRangeTimer = null;
function refreshCalibRangesSoon(){
  clearTimeout(_calibRangeTimer);
  _calibRangeTimer = setTimeout(()=>{
    const adminAvail = computeWrapperWidthIn("cal-preview");
    const adminW = $("cal-card-w");
    if(adminW){
      const min = Number(adminW.min || 240);
      const max = Math.max(min, Math.min(1200, adminAvail || Number(adminW.max || 900)));
      adminW.max = String(max);
      if(Number(adminW.value) > max) adminW.value = String(max);
      $("cal-card-wv") && ($("cal-card-wv").textContent = String(adminW.value));
    }

    const playerAvail = computeWrapperWidthIn("player-cal-preview");
    const pW = $("player-cal-card-w");
    if(pW){
      const min = Number(pW.min || 240);
      const max = Math.max(min, Math.min(1200, playerAvail || Number(pW.max || 900)));
      pW.max = String(max);
      if(Number(pW.value) > max) pW.value = String(max);
      $("player-cal-card-wv") && ($("player-cal-card-wv").textContent = String(pW.value));
    }
  }, 60);
}

window.addEventListener("resize", refreshCalibRangesSoon);

function adminApplyPlayerCard(pc, reason=""){
  const p = normalizePlayerCard(pc);
  adminDraftPlayerCard = p;
  applyPlayerCardVars(p, "admin:"+reason);
  refreshCalibRangesSoon();
}

function adminApplyFromUI(reason="live"){
  adminApplyPlayerCard(readAdminCalib(), reason);
}


function updateAdminRangeLabels(){
  $("cal-card-wv") && ($("cal-card-wv").textContent = String($("cal-card-w")?.value || ""));
  $("cal-card-hv") && ($("cal-card-hv").textContent = String($("cal-card-h")?.value || ""));
  $("cal-crop-xv") && ($("cal-crop-xv").textContent = String($("cal-crop-x")?.value || ""));
  $("cal-crop-bv") && ($("cal-crop-bv").textContent = String($("cal-crop-b")?.value || ""));
  $("cal-zoomv") && ($("cal-zoomv").textContent = String(Number($("cal-zoom")?.value || 1).toFixed(2)));
}

["cal-card-w","cal-card-h","cal-crop-x","cal-crop-b","cal-zoom"].forEach(id=>{
  $(id)?.addEventListener("input", () => {
    updateAdminRangeLabels();
    adminApplyFromUI("input:"+id);
  });
});
$("cal-anchor-y")?.addEventListener("change", () => adminApplyFromUI("anchor"));

$("cal-save")?.addEventListener("click", () => {
  const pc = adminDraftPlayerCard || readAdminCalib();
  saveLocalPlayerCard(pc);
  flashSaved("cal-save-status");
});

$("cal-reset")?.addEventListener("click", () => {
  const def = { ...DEFAULT_PLAYER_CARD };
  fillAdminFrom(def);
  updateAdminRangeLabels();
  adminApplyPlayerCard(def, "reset");
});

$("cal-preset-desktop")?.addEventListener("click", () => {
  const preset = { cardWidthPx: 520, cardHeightPx: 520, cropSidePx: 0, cropBottomPx: 60, anchorY: "top", scale: 1.0 };
  fillAdminFrom(preset);
  updateAdminRangeLabels();
  adminApplyPlayerCard(preset, "preset:desktop");
});
$("cal-preset-mobile")?.addEventListener("click", () => {
  const preset = { cardWidthPx: 360, cardHeightPx: 420, cropSidePx: 0, cropBottomPx: 70, anchorY: "top", scale: 0.85 };
  fillAdminFrom(preset);
  updateAdminRangeLabels();
  adminApplyPlayerCard(preset, "preset:mobile");
});

refreshCalibRangesSoon();
const localPc = loadLocalPlayerCard();
if(localPc) {
  fillAdminFrom(localPc);
  applyPlayerCardVars(localPc, "local");
} else {
  fillAdminFrom(DEFAULT_PLAYER_CARD);
  applyPlayerCardVars(DEFAULT_PLAYER_CARD, "default");
}

// Show calibration TikTok embed inside admin panel
renderCalibrationPreview();

// === AI tasks UI + generation ===
function aiGetRoundsLimit(){
  const total = Number($("host-total-rounds")?.value || 5);
  return Math.max(1, Math.min(20, total));
}
function aiAllThemes(){
  const all = [...AI_PRESET_THEMES, ...(aiState.customThemes || [])].map(s => String(s||"").trim()).filter(Boolean);
  // Unique, preserve order
  const seen = new Set();
  return all.filter(t => (seen.has(t.toLowerCase()) ? false : (seen.add(t.toLowerCase()), true)));
}
function aiGetSelectedThemes(){
  const sel = (aiState.selectedThemes || []).map(s => String(s||"").trim()).filter(Boolean);
  // Unique, preserve order
  const seen = new Set();
  return sel.filter(t => (seen.has(t.toLowerCase()) ? false : (seen.add(t.toLowerCase()), true)));
}

function aiUpdateCounters(){
  $("ai-themes-limit") && ($("ai-themes-limit").textContent = String(aiGetRoundsLimit()));
  $("ai-themes-count") && ($("ai-themes-count").textContent = String(aiGetSelectedThemes().length));
}

function aiSetStatus(text, mode){
  const el = $("ai-status");
  if(!el) return;
  el.textContent = text;
  el.classList.toggle("good", mode === "good");
  el.classList.toggle("warn", mode === "warn");
}

function aiRenderSelectedThemes(){
  const box = $("ai-selected");
  const empty = $("ai-no-themes");
  if(!box) return;
  const sel = aiGetSelectedThemes();
  box.innerHTML = "";
  if(empty) empty.classList.toggle("hidden", sel.length > 0);

  sel.forEach((theme)=>{
    const chip = document.createElement("div");
    chip.className = "selChip";
    chip.setAttribute("data-theme", theme);
    chip.innerHTML = `<span>${theme}</span><span class="x">×</span>`;
    chip.title = "Remove";
    chip.addEventListener("click", ()=>{
      aiState.selectedThemes = aiGetSelectedThemes().filter(t => t.toLowerCase() !== String(theme).toLowerCase());
      aiRenderThemeChips();
      aiUpdateCounters();
      aiPersist();
    });
    box.appendChild(chip);
  });
}

function aiApplyThemeFilter(){
  const q = String($("ai-theme-search")?.value || "").trim().toLowerCase();
  const box = $("ai-themes");
  if(!box) return;

  let shown = 0;
  [...box.children].forEach((el)=>{
    const t = String(el.getAttribute("data-theme") || "").toLowerCase();
    const ok = !q || t.includes(q);
    el.classList.toggle("hidden", !ok);
    if(ok) shown++;
  });

  const empty = $("ai-themes-empty");
  if(empty) empty.classList.toggle("hidden", shown !== 0);
}

function aiRenderThemeChips(){
  const box = $("ai-themes");
  if(!box) return;
  const lim = aiGetRoundsLimit();
  // If rounds decreased, drop extras
  const sel = aiGetSelectedThemes().slice(0, lim);
  aiState.selectedThemes = sel;

  const all = aiAllThemes();
  box.innerHTML = "";
  const selectedLower = new Set(sel.map(s => s.toLowerCase()));
  const selectedCount = sel.length;

  for(const theme of all){
    const isSelected = selectedLower.has(theme.toLowerCase());
    const isCustom = (aiState.customThemes || []).some(t => String(t).toLowerCase() === String(theme).toLowerCase());
    const disabled = !isSelected && selectedCount >= lim;

    const chip = document.createElement("div");
    chip.className = "themeChip" + (isSelected ? " selected" : "") + (disabled ? " disabled" : "");
    chip.setAttribute("data-theme", theme);

    const label = document.createElement("span");
    label.textContent = theme;
    chip.appendChild(label);

    if(isCustom){
      const x = document.createElement("span");
      x.className = "x";
      x.textContent = "×";
      x.title = "Удалить тему";
      x.addEventListener("click", (ev)=>{
        ev.stopPropagation();
        aiState.customThemes = (aiState.customThemes || []).filter(t => String(t).toLowerCase() !== String(theme).toLowerCase());
        aiState.selectedThemes = aiGetSelectedThemes().filter(t => String(t).toLowerCase() !== String(theme).toLowerCase());
        aiRenderThemeChips();
        aiUpdateCounters();
        aiPersist();
      });
      chip.appendChild(x);
    }

    chip.addEventListener("click", ()=>{
      if(disabled) return;
      const cur = aiGetSelectedThemes();
      const has = cur.some(t => t.toLowerCase() === theme.toLowerCase());
      let next = cur;
      if(has){
        next = cur.filter(t => t.toLowerCase() !== theme.toLowerCase());
      }else{
        next = [...cur, theme];
      }
      aiState.selectedThemes = next.slice(0, lim);
      aiRenderThemeChips();
      aiUpdateCounters();
      aiPersist();
    });

    box.appendChild(chip);
  }

  aiUpdateCounters();
  aiRenderSelectedThemes();
  aiApplyThemeFilter();
}

function aiSetEnabledUI(on){
  const controls = $("ai-controls");
  controls?.classList.toggle("hidden", !on);
  aiSetStatus(on ? "вкл" : "выкл", on ? "good" : "");
}

function emitAsync(event, payload){
  return new Promise((resolve)=> {
    try{
      socket.emit(event, payload, (res)=> resolve(res));
    }catch(e){
      resolve({ ok:false, error: String(e?.message || e) });
    }
  });
}

async function ensureSocketConnected(timeoutMs = 3500){
  try{
    if(socket && socket.connected) return true;
    try{ if(socket && typeof socket.connect === "function") socket.connect(); }catch(e){}
    return await new Promise((resolve)=>{
      let done = false;
      const finish = (v)=>{
        if(done) return;
        done = true;
        try{ socket?.off?.("connect", onConn); }catch(e){}
        clearTimeout(t);
        resolve(!!v);
      };
      const onConn = ()=> finish(true);
      try{ socket?.on?.("connect", onConn); }catch(e){}
      const t = setTimeout(()=> finish(false), Math.max(500, Number(timeoutMs)||3500));
    });
  }catch(e){
    return false;
  }
}

function hostSessionLoad(){
  try{
    const roomCode = String(localStorage.getItem(LS_HOST_ROOM) || "").toUpperCase().trim();
    const hostToken = String(localStorage.getItem(LS_HOST_TOKEN) || "").trim();
    return { roomCode, hostToken };
  }catch(e){
    return { roomCode:"", hostToken:"" };
  }
}

async function hostTryRejoin(reason = "auto"){
  try{
    const { roomCode, hostToken } = hostSessionLoad();
    if(!roomCode || !hostToken) return { ok:false, skipped:true };
    // only when host screen is visible OR we already have currentRoom
    const hostVisible = !!(screens?.host && !screens.host.classList.contains("hidden"));
    if(!hostVisible && !currentRoom) return { ok:false, skipped:true };

    const okConn = await ensureSocketConnected(3500);
    if(!okConn) return { ok:false, error:"no_socket" };

    const res = await emitAsync("host-rejoin", { roomCode, hostToken, reason });
    pushDebug("host-rejoin", res);
    if(res?.ok){
      if(!currentRoom || String(currentRoom).toUpperCase().trim() !== roomCode){
        hostSetRoom(roomCode);
      }
    }
    return res;
  }catch(e){
    return { ok:false, error:String(e?.message||e) };
  }
}


async function aiGenerateTasks(force = false){
  const lim = aiGetRoundsLimit();
  const themes = aiGetSelectedThemes();

  if(themes.length === 0){
    aiSetStatus("нет тем", "warn");
    alert("Выбери хотя бы одну тему для ИИ.");
    return { ok:false };
  }
  if(themes.length > lim){
    aiSetStatus("слишком много тем", "warn");
    alert("Тем не должно быть больше, чем раундов.");
    return { ok:false };
  }

  // if already have enough tasks for current settings
  if(!force && Array.isArray(aiState.lastGenerated) && aiState.lastGenerated.length >= lim){
    return { ok:true, tasks: aiState.lastGenerated.slice(0, lim), cached:true };
  }

  aiSetStatus("генерация…");
  $("ai-generate") && ($("ai-generate").disabled = true);

  const res = await emitAsync("host-generate-tasks", {
    roomCode: currentRoom,
    totalRounds: lim,
    themes,
    edgeLevelMax: Number($("ai-edge")?.value || 2),
  });

  $("ai-generate") && ($("ai-generate").disabled = false);

  if(!res?.ok){
    aiSetStatus("ошибка", "warn");
    $("ai-usage") && ($("ai-usage").textContent = `Ошибка: ${res?.error || "не удалось"}${res?.model ? (" | модель: " + res.model) : ""}${res?.details ? ("\n" + String(res.details).slice(0, 400)) : ""}\nЕсли ИИ не сработал — можно вписать задания вручную.`);
    return { ok:false, error: res?.error };
  }

  aiState.lastGenerated = Array.isArray(res.tasks) ? res.tasks : [];
  aiState.lastUsage = res.usage || null;
  aiState.lastModel = res.model || null;

  aiSetStatus("готово", "good");
  $("ai-to-textarea") && ($("ai-to-textarea").disabled = !(aiState.lastGenerated.length));
  if($("ai-usage")){
    const u = aiState.lastUsage;
    const t = u ? `Tokens: in ${u.input_tokens}, out ${u.output_tokens}, total ${u.total_tokens}` : "";
    $("ai-usage").textContent = `${aiState.lastModel ? ("Модель: " + aiState.lastModel + ". ") : ""}${t}`;
  }
  return { ok:true, tasks: aiState.lastGenerated.slice(0, lim), usage: aiState.lastUsage };
}

function aiInit(){
  // Only relevant on host screen
  if(!$("ai-enabled")) return;

  // Restore from localStorage
  try{
    const saved = JSON.parse(localStorage.getItem("mb_ai_state") || "null");
    if(saved && typeof saved === "object"){
      aiState.enabled = !!saved.enabled;
      // Migration: old builds stored humorLevel (1..5). Map -> edgeLevel (0..4).
      const legacyHumor = (saved.humorLevel != null) ? Number(saved.humorLevel) : null;
      const mappedEdge = (legacyHumor != null && Number.isFinite(legacyHumor)) ? Math.max(0, Math.min(4, Math.trunc(legacyHumor) - 1)) : null;
      aiState.edgeLevel = Number((saved.edgeLevel != null) ? saved.edgeLevel : (mappedEdge != null ? mappedEdge : 2));
      aiState.selectedThemes = Array.isArray(saved.selectedThemes) ? saved.selectedThemes : [];
      aiState.customThemes = Array.isArray(saved.customThemes) ? saved.customThemes : [];
    }
  }catch(e){}

  $("ai-enabled").checked = !!aiState.enabled;
  $("ai-edge") && ($("ai-edge").value = String((aiState.edgeLevel != null) ? aiState.edgeLevel : 2));

  aiSetEnabledUI(!!aiState.enabled);
  aiRenderThemeChips();
  aiUpdateCounters();

  // events
  $("ai-enabled").addEventListener("change", ()=>{
    aiState.enabled = !!$("ai-enabled").checked;
    aiSetEnabledUI(aiState.enabled);
    aiPersist();
  });

  $("ai-edge")?.addEventListener("change", ()=>{
    aiState.edgeLevel = Number($("ai-edge").value || 3);
    aiPersist();
  });

  $("host-total-rounds")?.addEventListener("input", ()=>{
    // drop extra selected themes if rounds decreased
    const lim = aiGetRoundsLimit();
    aiState.selectedThemes = aiGetSelectedThemes().slice(0, lim);
    aiRenderThemeChips();
    aiUpdateCounters();
    aiPersist();
  });

  $("ai-add-theme")?.addEventListener("click", ()=>{
    const inp = $("ai-custom-theme");
    const v = String(inp?.value || "").trim();
    if(!v) return;
    inp.value = "";
    aiState.customThemes = aiAllThemes().includes(v) ? (aiState.customThemes || []) : [...(aiState.customThemes || []), v];
    // auto-select
    const cur = aiGetSelectedThemes();
    if(!cur.some(t => t.toLowerCase() === v.toLowerCase())){
      cur.push(v);
      aiState.selectedThemes = cur.slice(0, aiGetRoundsLimit());
    }
    aiRenderThemeChips();
    aiUpdateCounters();
    aiPersist();
  });

  $("ai-clear-themes")?.addEventListener("click", ()=>{
    aiState.selectedThemes = [];
    aiState.customThemes = [];
    aiState.lastGenerated = [];
    aiState.lastUsage = null;
    aiState.lastModel = null;
    $("ai-to-textarea") && ($("ai-to-textarea").disabled = true);
    $("ai-usage") && ($("ai-usage").textContent = "");
    aiRenderThemeChips();
    aiUpdateCounters();
    aiPersist();
  });

  $("ai-random-themes")?.addEventListener("click", ()=>{
    const lim = aiGetRoundsLimit();
    const base = AI_PRESET_THEMES.slice();
    // pick up to min(lim, 5) random themes
    const pick = Math.max(1, Math.min(lim, 5));
    const out = [];
    while(out.length < pick && base.length){
      const i = Math.floor(Math.random()*base.length);
      out.push(base.splice(i,1)[0]);
    }
    aiState.selectedThemes = out;
    aiRenderThemeChips();
    aiUpdateCounters();
    aiPersist();
  });

  $("ai-generate")?.addEventListener("click", async ()=>{
    if(!currentRoom) return alert("Сначала создай комнату.");
    await aiGenerateTasks(true);
    aiPersist();
  });

  $("ai-to-textarea")?.addEventListener("click", ()=>{
    if(!aiState.lastGenerated?.length) return;
    $("host-tasks").value = aiState.lastGenerated.join("\n");
  });

  function aiPersist(){
    try{
      localStorage.setItem("mb_ai_state", JSON.stringify({
        enabled: aiState.enabled,
        edgeLevel: aiState.edgeLevel,
        selectedThemes: aiGetSelectedThemes(),
        customThemes: aiState.customThemes || [],
      }));
    }catch(e){}
  }
}
// === END AI tasks ===


function parseTasks(){
  const total = Number($("host-total-rounds").value || 5);
  const raw = String($("host-tasks").value || "");
  const tasks = raw.split(/\r?\n/).map(s=>s.trim()).filter(Boolean);

  hostState.totalRounds = Math.max(1, Math.min(20, total));
  hostState.tasks = tasks;

  // AI toggle state lives on the host device
  aiState.enabled = !!$("ai-enabled")?.checked;
  aiState.edgeLevel = Number($("ai-edge")?.value || 2);

  // If we already generated tasks for current settings, use them (fallback is manual tasks)
  if(aiState.enabled && Array.isArray(aiState.lastGenerated) && aiState.lastGenerated.length){
    hostState.tasks = aiState.lastGenerated.slice(0, hostState.totalRounds);
  }
}

function getTaskForRound(n){
  if (hostState.tasks.length === 0) return `Раунд ${n}`;
  const t = hostState.tasks[(n-1) % hostState.tasks.length];
  if(typeof t === "string") return t;
  if(t && typeof t.text === "string") return t.text;
  return String(t || `Раунд ${n}`);
}
function hostUpdateRoundInfo(){
  $("host-round-info").textContent = hostState.round ? `Раунд: ${hostState.round} / ${hostState.totalRounds}` : "Раунд: —";
}
function ensureRoom(){
  if(!currentRoom){ alert("Сначала создай комнату"); return false; }
  return true;
}


$("host-start-game")?.addEventListener("click", async () => {
  if(!ensureRoom()) return;


  parseTasks();

  // IMPORTANT: tasks generation is a separate button now.
  if (aiState.enabled){
    const need = Number(hostState.totalRounds || 0);
    const has = Array.isArray(aiState.lastGenerated) ? aiState.lastGenerated.length : 0;
    if (has < need){
      alert("Сначала нажми «Generate Tasks» (или выключи ИИ).");
      return;
    }
    hostState.tasks = aiState.lastGenerated.slice(0, need);
  }

  // Start the game by broadcasting the first task (server has no `host-start-game` event).
  hostState.round = 1;
  hostState.scores = {};
  renderResults();
  hostUpdateRoundInfo();

  $("host-next-round").disabled = false;
  $("host-end-game").disabled = false;
  $("host-start-vote").disabled = true;

  const task = getTaskForRound(hostState.round);

  socket.emit("host-task-update", { roomCode: currentRoom, roundNumber: hostState.round, task }, (res) => {
    pushDebug("host-task-update:first", res);
    if(!res?.ok) return alert(res?.error || "Ошибка");

    // Switch out of Setup into Round view; room-status keeps it synced afterward.
    setHostView("round");
    hostRoundSetTask(task, hostState.round, hostState.totalRounds);

    // Best-effort progress update using last known status
    if (lastRoomStatus && lastRoomStatus.roomCode === currentRoom){
      hostRoundUpdateProgress(lastRoomStatus);
    }
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
  if(!Array.isArray(memelist) || memelist.length === 0) return { points };

  // Eligibility rule: players who DID NOT vote get 0 points for the round.
  // We take eligibility from lastRoomStatus (server truth) when possible.
  const st = lastRoomStatus;
  const eligibleById = new Set();
  const eligibleByNick = new Set();
  if(st && Array.isArray(st.players)){
    st.players.forEach(p=>{
      if(!p) return;
      if(p.hasVoted){
        if(p.id) eligibleById.add(String(p.id));
        if(p.nickname) eligibleByNick.add(String(p.nickname));
      }
    });
  }

  const isEligible = (m)=>{
    if(!m) return false;
    const ownerId = m.ownerId ? String(m.ownerId) : "";
    const nick = m.nickname ? String(m.nickname) : "";
    if(eligibleById.size) return ownerId && eligibleById.has(ownerId);
    if(eligibleByNick.size) return nick && eligibleByNick.has(nick);
    // If we don't have status (should be rare), do not block scoring.
    return true;
  };

  // Vote points: 10 per vote (only if eligible)
  memelist.forEach(m=>{
    if(!isEligible(m)) return;
    const nick = m.nickname || "Игрок";
    const votePts = Number(m.votes || 0) * 10;
    points[nick] = (points[nick]||0) + votePts;
  });

  // +20% bonus to unique winner (only if eligible)
  let max = -1;
  memelist.forEach(m => { max = Math.max(max, Number(m?.votes || 0)); });
  const winners = memelist.filter(m => Number(m?.votes || 0) === max);
  if (winners.length === 1){
    const w = winners[0];
    if(isEligible(w)){
      const nick = w.nickname || "Игрок";
      const winVotePts = Number(w.votes||0) * 10;
      const bonus = Math.round(winVotePts * 0.2);
      points[nick] = (points[nick]||0) + bonus;
    }
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



// [ANCHOR] MB:F:HOST_FORCE_NEXT — shared handler for normal + emergency next round
function hostAdvanceRound(opts = {}){
  const forced = !!opts.forced;
  if(!ensureRoom()) return;

  // [ANCHOR] MB:F:HOST_NEXT:ROUND_SOURCE — trust server roundNumber if available
  try{
    const serverRound = Number(lastRoomStatus?.roundNumber || 0);
    if (Number.isFinite(serverRound) && serverRound > (hostState.round || 0)) {
      hostState.round = serverRound;
    }
  }catch(e){}

  if(forced) pushDebug("host-next-round:forced", { roomCode: currentRoom, round: hostState.round });

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
}

$("host-next-round")?.addEventListener("click", () => hostAdvanceRound({ forced:false }));

// [ANCHOR] MB:F:HOST_FORCE_NEXT:BTN — emergency next round buttons
$("host-vote-force-next")?.addEventListener("click", () => hostAdvanceRound({ forced:true }));
delegateClick("#winner-host-next-round", (ev)=>{ ev.preventDefault(); pushDebug("winner-host-next-round:click", { roomCode: currentRoom || null }); hostAdvanceRound({ forced:true }); });
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

// [ANCHOR] MB:F:HOST_NEW_GAME — reset scores + return host to setup
function hostRequestNewGame(source = "host"){
  if(!ensureRoom()) return;
  pushDebug("host-new-game:click", { source, roomCode: currentRoom });
  if(!confirm("Начать новую игру в этой комнате? Очки будут сброшены.")) return;

  socket.emit("host-new-game", { roomCode: currentRoom }, (res)=>{
    pushDebug("host-new-game", res);
    if(!res?.ok) return alert(res?.error || "Ошибка");

    // Local reset (server is the source of truth, this is UI-only)
    hostState.round = 0;
    hostState.scores = {};
    renderResults();
    hostUpdateRoundInfo();

    // Hide full-screen stages
    try{ hideFinalOverlay(); }catch(e){}
    try{ hideWinnerOverlay(); }catch(e){}

    // Disable/enable controls
    $("host-new-game")?.classList.add("hidden");
    $("host-next-round")?.setAttribute("disabled", "true");
    if($("host-next-round")) $("host-next-round").disabled = true;
    if($("host-start-vote")) $("host-start-vote").disabled = true;

    // Return to host setup (same room)
    try{ showScreen("host"); }catch(e){}
    try{ setHostView("setup"); }catch(e){}
  });
}

$("host-new-game")?.addEventListener("click", () => hostRequestNewGame("host-old-ui"));
// Final overlay button is rendered after scripts -> use delegated click
delegateClick("#final-host-new-game", (ev)=>{ ev.preventDefault(); hostRequestNewGame("host-final"); });


// [ANCHOR] MB:F:PLAYER — join, submit meme, vote, next round
// -------- Player UI (JOIN + SUBMIT V2)

const playerUi = {
  isJoining: false,
  showQR: false,
  memeType: null, // "file" | "link" | "text" | null
  roundActive: false,
  serverOffsetMs: 0,
  collectEndsAt: 0,
  timerTick: null,
};

function pShow(elId, on){
  const el = $(elId);
  if(!el) return;
  el.classList.toggle('hidden', !on);
}

function playerSetJoinError(msg){
  const e = $("player-join-error");
  if(!e) return;
  if(msg){ e.textContent = msg; e.classList.remove('hidden'); }
  else { e.textContent = ""; e.classList.add('hidden'); }
}

function playerJoinValid(){
  const code = String($("player-room")?.value || "").trim();
  const nick = String($("player-nick")?.value || "").trim();
  return code.length >= 4 && nick.length > 0;
}

function playerUpdateJoinBtn(){
  const btn = $("player-join");
  if(!btn) return;
  const valid = playerJoinValid();
  btn.classList.toggle('hidden', !valid);
  btn.disabled = playerUi.isJoining;
  btn.textContent = playerUi.isJoining ? "JOINING..." : "JOIN ROOM";
}

function handleRoomCodeChange(v){
  const cleaned = String(v||"").replace(/\s/g, "").toUpperCase().slice(0, 12);
  if($("player-room")) $("player-room").value = cleaned;
  playerSetJoinError("");
  playerUpdateJoinBtn();
}

function handleNicknameChange(v){
  const vv = String(v||"").slice(0, 20);
  if($("player-nick")) $("player-nick").value = vv;
  const c = $("player-nick-count");
  if(c) c.textContent = `${vv.length}/20`;
  playerSetJoinError("");
  playerUpdateJoinBtn();
}

function playerShowJoin(){
  pShow('player-view-join', true);
  pShow('player-view-game', false);
}

function playerShowSubmit(){
  pShow('player-view-join', false);
  pShow('player-view-game', true);
}

// Prefill room code: /join/ROOMCODE or ?room=ROOMCODE
(function initPlayerPrefill(){
  try{
    const sp = new URLSearchParams(location.search);
    let code = sp.get('room') || '';
    if(!code){
      const m = String(location.pathname||'').match(/\/join\/([A-Za-z0-9_-]{2,})/);
      if(m) code = m[1];
    }
    const saved = localStorage.getItem(LS_ROOM) || '';
    if($("player-room")) $("player-room").value = String(code || saved || '').toUpperCase();
  }catch(e){}
  try{ if($("player-nick")) $("player-nick").value = (localStorage.getItem(LS_NICK) || ''); }catch(e){}
  handleRoomCodeChange($("player-room")?.value || "");
  handleNicknameChange($("player-nick")?.value || "");
})();

$("player-room")?.addEventListener('input', (e)=> handleRoomCodeChange(e.target.value));
$("player-nick")?.addEventListener('input', (e)=> handleNicknameChange(e.target.value));

$("player-nick")?.addEventListener('keydown', (e)=>{
  if(e.key === 'Enter' && playerJoinValid()) joinRoom($("player-room").value, $("player-nick").value);
});

// QR mock
$("player-qr-btn")?.addEventListener('click', ()=>{
  if(playerUi.isJoining) return;
  playerUi.showQR = true;
  pShow('player-qr-overlay', true);
  setTimeout(()=>{
    if(!playerUi.showQR) return;
    handleRoomCodeChange('ABC123');
    playerUi.showQR = false;
    pShow('player-qr-overlay', false);
  }, 1500);
});
$("player-qr-cancel")?.addEventListener('click', ()=>{
  playerUi.showQR = false;
  pShow('player-qr-overlay', false);
});

function joinRoom(room, nick){
  const roomCode = String(room||"").trim().toUpperCase();
  const nickname = String(nick||"").trim().slice(0,20);
  if(roomCode.length < 4){ playerSetJoinError('Invalid room code'); return; }
  if(!nickname){ playerSetJoinError('Enter your name'); return; }

  playerUi.isJoining = true;
  playerSetJoinError('');
  playerUpdateJoinBtn();

  socket.emit('player-join', { roomCode, nickname }, (res)=>{
    pushDebug('player-join', res);
    playerUi.isJoining = false;
    playerUpdateJoinBtn();

    if(!res?.ok){
      playerSetJoinError(res?.error || 'Failed to join room. Please try again.');
      return;
    }

    playerState.joined = true;
    playerState.playerId = res.playerId || '';
    playerState.nickname = res.nickname || nickname;
    playerState.roomCode = roomCode;

    // [ANCHOR] MB:F:PLAYER_SCORE_SHOW_ON_JOIN — show score indicator immediately after join (prevents "missing" state)
    try{
      pShow('player-score-wrap', true);
      pShow('player-score-btn', true);
      $("player-leaderboard")?.classList.add('hidden');
    }catch(e){}

    localStorage.setItem(LS_NICK, playerState.nickname);
    localStorage.setItem(LS_ROOM, roomCode);

    $("player-join-status").textContent = res.rejoined ? '✅ Rejoined' : '✅ Joined';
    if(res.task) $("player-task").textContent = res.task;

    // Seed status snapshot (important for player timer + UI if first room-status is missed)
    try{
      const snap = {
        roomCode: roomCode,
        phase: res.phase || null,
        roundNumber: Number(res.roundNumber || 0),
        totalRounds: Number(res.totalRounds || 0),
        task: String(res.task || ''),
        currentTheme: String(res.task || ''),
        collectEndsAt: res.collectEndsAt ? Number(res.collectEndsAt) : null,
        voteEndsAt: res.voteEndsAt ? Number(res.voteEndsAt) : null,
        collectSeconds: res.collectSeconds ? Number(res.collectSeconds) : null,
        voteSeconds: res.voteSeconds ? Number(res.voteSeconds) : null,
        serverNow: res.serverNow ? Number(res.serverNow) : Date.now(),
      };
      lastRoomStatus = { ...(lastRoomStatus||{}), ...snap };
      playerTimerSyncFromStatus(snap);
      pushDebug('player-join:snap', { phase: snap.phase, collectEndsAt: snap.collectEndsAt, voteEndsAt: snap.voteEndsAt, serverNow: snap.serverNow });
    }catch(e){}

    // Reset per round UI
    pShow('player-sent', false);
    pShow('player-voted', false);
    pShow('player-vote-finished', false);

    playerShowSubmit();
  });
}
$("player-join")?.addEventListener('click', ()=> joinRoom($("player-room").value, $("player-nick").value));

// Settings panel
$("player-settings-btn")?.addEventListener('click', ()=>{
  pShow('player-settings-overlay', true);
  const st = $("player-settings-status");
  if(st) st.textContent = socket.connected ? 'ONLINE' : 'OFFLINE';
  const rm = $("player-settings-room");
  if(rm) rm.textContent = playerState.roomCode || $("player-room")?.value || '—';
});
$("player-settings-close")?.addEventListener('click', ()=> pShow('player-settings-overlay', false));
$("player-settings-reconnect")?.addEventListener('click', ()=>{ try{ socket.connect(); }catch(e){} });

// Score pill dropdown
$('player-score-btn')?.addEventListener('click', ()=>{
  const lb = $('player-leaderboard');
  if(!lb) return;
  lb.classList.toggle('hidden');
  // will be populated on room-status updates
});

function playerRenderLeaderboard(players){
  const lb = $('player-leaderboard');
  if(!lb) return;
  const ps = Array.isArray(players) ? players.slice() : [];
  ps.sort((a,b)=> Number(b.score||0) - Number(a.score||0));
  const rows = ps.map((p,i)=>{
    const rank = i+1;
    const isMe = String(p.id||'') === String(playerState.playerId||'') || String(p.nickname||'') === String(playerState.nickname||'');
    const nm = String(p.nickname||'PLAYER');
    const score = Number(p.score||0);
    return `<div class="pLbRow ${isMe?'me':''}"><div class="pLbLeft"><span class="pLbRank r${rank}">${rank}</span><span class="pLbName">${escapeHtml(nm)}${isMe?' <span class=\"pLbYou\">(YOU)</span>':''}</span></div><div class="pLbScore">${score}</div></div>`;
  }).join('');
  lb.innerHTML = `<div class="pLbHead">🏆 LEADERBOARD</div><div class="pLbList">${rows || '<div class=\"pLbEmpty\">—</div>'}</div>`;
}

function playerSetMemeType(type){
  playerUi.memeType = type;

  // chooser vs mode panels
  pShow('player-type-chooser', type === null);
  pShow('player-mode-file', type === 'file');
  pShow('player-mode-link', type === 'link');
  pShow('player-mode-text', type === 'text');

  // reset fields when switching types
  if(type === 'text'){
    if($("player-meme-url")) $("player-meme-url").value = '';
    if($("player-meme-file")) $("player-meme-file").value = '';
    if($("player-meme-caption")) $("player-meme-caption").value = '';
    if($("player-meme-url-link")) $("player-meme-url-link").value = '';
    if($("player-meme-caption-link")) $("player-meme-caption-link").value = '';
  }
  if(type === 'file'){
    if($("player-meme-text")) $("player-meme-text").value = '';
    if($("player-meme-url-link")) $("player-meme-url-link").value = '';
    if($("player-meme-caption-link")) $("player-meme-caption-link").value = '';
  }
  if(type === 'link'){
    if($("player-meme-text")) $("player-meme-text").value = '';
    if($("player-meme-url")) $("player-meme-url").value = '';
    if($("player-meme-file")) $("player-meme-file").value = '';
    if($("player-meme-caption")) $("player-meme-caption").value = '';
  }

  // hide captions by default (will be re-enabled by visibility update)
  pShow('player-caption-wrap', false);
  pShow('player-caption-wrap-link', false);

  // hide previews
  try{ const i=$("player-preview"); if(i){ i.classList.add('hidden'); i.removeAttribute('src'); } }catch(e){}
  try{ const i=$("player-preview-link"); if(i){ i.classList.add('hidden'); i.removeAttribute('src'); } }catch(e){}

  playerUpdateCaptionVisibility();
  playerUpdatePreview();
  playerUpdateSubmitBtn();
}

function playerCanSubmit(){
  if(!playerState.joined) return false;
  if(!playerUi.roundActive) return false;
  if(playerUi.memeType === 'text'){
    return !!String($("player-meme-text")?.value || '').trim();
  }
  if(playerUi.memeType === 'file'){
    const file = $("player-meme-file")?.files?.[0] || null;
    const url = String($("player-meme-url")?.value || '').trim();
    return !!file || !!url;
  }
  if(playerUi.memeType === 'link'){
    const url = String($("player-meme-url-link")?.value || '').trim();
    return !!url;
  }
  return false;
}

function playerUpdateSubmitBtn(){
  // sticky submit visible only when round active and type chosen
  pShow('player-submit-sticky', playerUi.roundActive && playerUi.memeType !== null);
  const btn = $("player-send-meme");
  if(!btn) return;
  btn.disabled = !playerCanSubmit();
}

$("player-type-file")?.addEventListener('click', ()=> playerSetMemeType('file'));
$("player-type-link")?.addEventListener('click', ()=> playerSetMemeType('link'));
$("player-type-text")?.addEventListener('click', ()=> playerSetMemeType('text'));

$("player-back-file")?.addEventListener('click', ()=> playerSetMemeType(null));
$("player-back-link")?.addEventListener('click', ()=> playerSetMemeType(null));
$("player-back-text")?.addEventListener('click', ()=> playerSetMemeType(null));

$("player-meme-url")?.addEventListener('input', ()=>{ playerUpdateCaptionVisibility(); playerUpdateSubmitBtn(); playerUpdatePreview(); });
$("player-meme-file")?.addEventListener('change', ()=>{ playerUpdateCaptionVisibility(); playerUpdateSubmitBtn(); });
$("player-meme-caption")?.addEventListener('input', playerUpdateSubmitBtn);

$("player-meme-url-link")?.addEventListener('input', ()=>{ playerUpdateCaptionVisibility(); playerUpdateSubmitBtn(); playerUpdatePreview(); });
$("player-meme-caption-link")?.addEventListener('input', playerUpdateSubmitBtn);

$("player-meme-text")?.addEventListener('input', playerUpdateSubmitBtn);

function playerUpdateCaptionVisibility(){
  // Text-only memes: no comment/caption
  if(playerUi.memeType === 'text'){
    pShow('player-caption-wrap', false);
    pShow('player-caption-wrap-link', false);
    return;
  }
  if(playerUi.memeType === 'file'){
    const file = $("player-meme-file")?.files?.[0] || null;
    const url = String($("player-meme-url")?.value || '').trim();
    pShow('player-caption-wrap', !!file || !!url);
    pShow('player-caption-wrap-link', false);
    return;
  }
  if(playerUi.memeType === 'link'){
    const url = String($("player-meme-url-link")?.value || '').trim();
    pShow('player-caption-wrap-link', !!url);
    pShow('player-caption-wrap', false);
    return;
  }
  pShow('player-caption-wrap', false);
  pShow('player-caption-wrap-link', false);
}

function playerUpdatePreview(){
  // FILE preview
  try{
    const img = $("player-preview");
    if(img){
      const url = String($("player-meme-url")?.value || '').trim();
      if(playerUi.memeType !== 'file' || !url || !/^https?:\/\//i.test(url)){
        img.classList.add('hidden');
        img.removeAttribute('src');
      }else{
        img.src = url;
        img.onerror = ()=>{ img.classList.add('hidden'); };
        img.onload = ()=>{ img.classList.remove('hidden'); };
      }
    }
  }catch(e){}

  // LINK preview
  try{
    const img = $("player-preview-link");
    if(img){
      const url = String($("player-meme-url-link")?.value || '').trim();
      if(playerUi.memeType !== 'link' || !url || !/^https?:\/\//i.test(url)){
        img.classList.add('hidden');
        img.removeAttribute('src');
      }else{
        img.src = url;
        img.onerror = ()=>{ img.classList.add('hidden'); };
        img.onload = ()=>{ img.classList.remove('hidden'); };
      }
    }
  }catch(e){}
}

function playerStopTimer(){
  if(playerUi.timerTick){ clearInterval(playerUi.timerTick); playerUi.timerTick = null; }
}
function playerStartTimer(){
  playerStopTimer();
  playerUi.timerTick = setInterval(()=>{
    if(!playerUi.collectEndsAt){ return; }
    const now = Date.now() + playerUi.serverOffsetMs;
    const left = Math.max(0, Math.ceil((playerUi.collectEndsAt - now)/1000));
    const pill = $("player-timer");
    if(pill){
      pill.textContent = String(left);
      pill.classList.remove('isOk','isWarn','isCrit','bounceOnce');
      if(left <= 10){ pill.classList.add('isCrit','bounceOnce'); }
      else if(left <= 20){ pill.classList.add('isWarn'); }
      else { pill.classList.add('isOk'); }
      if(left <= 10){ pill.classList.remove('bounceOnce'); void pill.offsetWidth; pill.classList.add('bounceOnce'); }
    }
  }, 1000);
}

// Initial view
playerShowJoin();
playerSetMemeType(null);
playerUpdateJoinBtn();

async function fileToDataUrl(file){

  return new Promise((resolve, reject)=>{
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result||""));
    fr.onerror = () => reject(fr.error || new Error("File read error"));
    fr.readAsDataURL(file);
  });
}

async function fileToArrayBuffer(file){
  return new Promise((resolve, reject)=>{
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => reject(fr.error || new Error("File read error"));
    fr.readAsArrayBuffer(file);
  });
}

// Very small GIF duration parser (sum of GCE delays), returns seconds or null
function gifDurationSeconds(arrayBuffer){
  try{
    const bytes = new Uint8Array(arrayBuffer);
    let totalCs = 0;
    for(let i=0;i<bytes.length-7;i++){
      if(bytes[i]===0x21 && bytes[i+1]===0xF9 && bytes[i+2]===0x04){
        const delay = bytes[i+4] | (bytes[i+5] << 8); // centiseconds
        totalCs += delay > 0 ? delay : 10; // treat 0 as 0.1s
        i += 7;
      }
    }
    const sec = totalCs / 100;
    return Number.isFinite(sec) && sec > 0 ? Math.round(sec*100)/100 : null;
  }catch(e){
    return null;
  }
}

function normalizeMemeKindFromDetect(detectType, url){
  const t = String(detectType || "");
  if(t.startsWith("image")) return "photo";
  if(t.startsWith("gif")) return "gif";
  if(t.startsWith("video") || t === "youtube" || t === "tiktok") return "video";
  if(t.startsWith("audio")) return "audio";
  const s = String(url||"").toLowerCase();
  if(/\.(mp3|wav|ogg|m4a|aac)(\?|#|$)/.test(s)) return "audio";
  return "unknown";
}

// Best-effort: duration for direct media URLs (not YouTube/TikTok)
async function mediaDurationFromUrl(url, kind){
  if(kind !== "video" && kind !== "audio") return null;
  return new Promise((resolve)=>{
    const el = document.createElement(kind === "audio" ? "audio" : "video");
    el.preload = "metadata";
    el.muted = true;
    let done = false;
    const finish = (v)=>{
      if(done) return;
      done = true;
      try{ el.removeAttribute("src"); el.load(); }catch(e){}
      resolve(v);
    };
    const t = setTimeout(()=>finish(null), 1500);
    el.onloadedmetadata = ()=>{
      clearTimeout(t);
      const d = Number(el.duration);
      finish(Number.isFinite(d) && d > 0 ? Math.round(d*100)/100 : null);
    };
    el.onerror = ()=>{
      clearTimeout(t);
      finish(null);
    };
    el.src = url;
  });
}
$("player-send-meme")?.addEventListener("click", async () => {
  if(!playerState.joined){ $("player-join-status").textContent = "Сначала войди в комнату"; return; }
  if(!playerUi.roundActive){ return; }

  // TEXT-ONLY
  if(playerUi.memeType === "text"){
    const text = String($("player-meme-text")?.value || "").trim();
    if(!text) return;
    const payload = { roomCode: playerState.roomCode, text };
    pushDebug("player:send:text:emit", { roomCode: playerState.roomCode, textLen: text.length });
    socket.emit("player-send-meme", payload, (res)=>{
      pushDebug("player-send-meme:text", res);
      if(!res?.ok){ alert(res?.error || "Ошибка отправки"); return; }
      $("player-sent")?.classList.remove("hidden");
    });
    return;
  }

  // FILE/LINK
  const isFileMode = playerUi.memeType === "file";
  const isLinkMode = playerUi.memeType === "link";
  const urlElId = isLinkMode ? "player-meme-url-link" : "player-meme-url";
  const captionElId = isLinkMode ? "player-meme-caption-link" : "player-meme-caption";

  const file = isFileMode ? ($("player-meme-file")?.files?.[0] || null) : null;
  let url = "";
  pushDebug("player:send:input", {
    roomCode: playerState.roomCode,
    memeType: playerUi.memeType,
    hasFile: Boolean(file),
    file: file ? { name: file.name, type: file.type, size: file.size } : null,
    rawUrl: dbgValueShort($(urlElId)?.value || "")
  });

  if(file){
    if(file.size > 8 * 1024 * 1024){ alert("Файл слишком большой. Лимит ~8MB."); return; }
    url = await fileToDataUrl(file);
    pushDebug("player:send:file_read", dbgValueShort(url));
  }else{
    url = String($(urlElId)?.value || "").trim();
    const normalized = await normalizeVideoLink(url);
    pushDebug("player:send:normalized", { in: url, out: normalized.url || url, meta: normalized });
    url = normalized.url || url;
  }

  const caption = String($(captionElId)?.value || "").trim();
  const dt = detectMediaType(url).type;
  const kind = normalizeMemeKindFromDetect(dt, url);
  let durationSec = null;
  if(kind === "gif" && file){
    try{ durationSec = gifDurationSeconds(await fileToArrayBuffer(file)); }catch(e){}
  }
  if(kind === "video" && dt === "video_url") durationSec = await mediaDurationFromUrl(url, "video");
  if(kind === "audio" && dt === "audio_url") durationSec = await mediaDurationFromUrl(url, "audio");

  const payload = { roomCode: playerState.roomCode, url, caption, meta: { kind, durationSec } };
  pushDebug("player:send:emit", { roomCode: playerState.roomCode, kind, durationSec, url: dbgValueShort(url), captionLen: caption.length });
  socket.emit("player-send-meme", payload, (res)=>{
    pushDebug("player-send-meme", res);
    if(!res?.ok){ alert(res?.error || "Ошибка отправки"); return; }
    $("player-sent")?.classList.remove("hidden");
  });
});
$("player-next-round")?.addEventListener("click", () => {
  if (!playerState.roomCode) return;
  pushDebug("player-ready-next:click", { roomCode: playerState.roomCode });
  socket.emit("player-ready-next", { roomCode: playerState.roomCode }, (res) => {
    if (!res || !res.ok) {
      pushDebug("player-ready-next:fail", res || {});
      return;
    }
    try{ playerState.readyNextLocal = true; }catch(e){}
    pushDebug("player-ready-next", { ok: true });
    try{ updateNextRoundUI(); }catch(e){}
    // UI updates via room-status
  });
});

// [ANCHOR] MB:F:WINNER_PLAYER_NEXT_BTN — player ready-next button inside winner overlay
delegateClick("#winner-player-next-round", (ev)=>{
  ev.preventDefault();
  if (!playerState.roomCode) return;
  pushDebug("winner-player-ready-next:click", { roomCode: playerState.roomCode });
  socket.emit("player-ready-next", { roomCode: playerState.roomCode }, (res) => {
    if (!res || !res.ok) {
      pushDebug("winner-player-ready-next:fail", res || {});
      return;
    }
    try{ playerState.readyNextLocal = true; }catch(e){}
    pushDebug("winner-player-ready-next", { ok: true });
    try{ updateNextRoundUI(); }catch(e){}
    // UI updates via room-status
  });
});


// -------- Live updates

// [ANCHOR] MB:F:SOCKET:MEMES_READY — reveal memes (end collect)
socket.on("memes-ready", (p) => {
  // only host cares
  if (p?.roomCode === currentRoom){
    pushDebug("memes-ready", p);
    // memes are now revealed on host screen (still collect), enable "start vote"
    $("host-start-vote").disabled = false;
  }
});

// [ANCHOR] MB:F:SOCKET:ROOM_STATUS — server snapshot (phase, timers, players)
socket.on("room-status", (st) => {
  // store status for waiting UI
  lastRoomStatus = st;

  // [ANCHOR] MB:F:VOTING_FINISHED:FALLBACK_FROM_STATUS — если событие "voting-finished" было пропущено (reload/reconnect),
  // показываем Winner overlay на основании room-status (memes+votes).
  try{
    const inVoteDone = !!(st && st.phase === "vote" && st.voteComplete);
    const rn = Number(st?.roundNumber || 0);
    if(inVoteDone && rn > 0){
      const ov = $("winner-overlay");
      const overlayVisible = !!(ov && !ov.classList.contains("hidden"));
      const shownFor = Number(window.__mbWinnerShownRound || 0);
      const alreadyCtx = overlayVisible || (typeof nextUiRoundNumber !== "undefined" && Number(nextUiRoundNumber || 0) === rn);

      if(!alreadyCtx && shownFor !== rn){
        const memes = Array.isArray(st.memes) ? st.memes : [];
        let maxVotes = 0;
        for(const m of memes){
          const v = Number(m?.votes || 0);
          if(Number.isFinite(v)) maxVotes = Math.max(maxVotes, v);
        }
        const winners = memes.length
          ? memes
              .filter(m => Number(m?.votes || 0) === maxVotes)
              .map(m => ({
                id: m?.id || null,
                memeId: m?.id || null,
                url: m?.url || null,
                caption: m?.caption || "",
                nickname: m?.nickname || "",
                votes: Number(m?.votes || 0),
              }))
          : [];

        const ps = Array.isArray(st.players) ? st.players : [];
        let reason = "status_fallback";
        if(memes.length === 0) reason = "no_memes";
        else if(ps.length && ps.every(p => !p?.hasVoted)) reason = "no_votes";

        const payload = {
          roomCode: String(st.roomCode || "").trim().toUpperCase(),
          roundNumber: rn,
          totalRounds: Number(st.totalRounds || 0),
          winner: winners[0] || null,
          winners,
          maxVotes,
          tie: winners.length > 1,
          displayMs: 0,
          reason,
          players: ps,
        };

        // Mark context so player next-round UI can appear even without voting-finished.
        try{ nextUiRoundNumber = rn; }catch(e){}
        try{ hostAutoNextLock = false; }catch(e){}

        try{ pushDebug("voting-finished:fallback", { roomCode: payload.roomCode, roundNumber: rn, reason, winners: winners.length, maxVotes }); }catch(e){}
        try{ showWinnerOverlay(payload); }catch(e){}
        try{ updateNextRoundUI(); }catch(e){}

        window.__mbWinnerShownRound = rn;
      }
    }
  }catch(e){}

  // [ANCHOR] MB:F:ALL_READY_NEXT:FALLBACK_FROM_STATUS — если host пропустил событие all-ready-next (reload/reconnect),
  // автопереход всё равно сработает при условии ready==total.
  try{
    const isHost = !!currentRoom;
    if(isHost && st && st.phase === "vote" && st.voteComplete){
      const { total, ready } = getMandatoryReadyStats(st);
      if(total > 0 && ready >= total && !hostAutoNextLock){
        hostAutoNextLock = true;
        pushDebug("all-ready-next:fallback", { roomCode: st.roomCode, roundNumber: st.roundNumber, ready, total });
        setTimeout(() => { $("host-next-round")?.click(); }, 200);
      }
    }
  }catch(e){}

  // [ANCHOR] MB:CALL:PLAYER_TIMER_SYNC
  try{ playerTimerSyncFromStatus(st); }catch(e){}

  // [ANCHOR] MB:F:FINAL_OVERLAY_AUTOHIDE — prevent player final overlay from sticking into the next game
  try{
    if(st && st.phase && st.phase !== "finished") hideFinalOverlay();
  }catch(e){}

  // [ANCHOR] MB:DBG:ROOM_STATUS_BRIEF
  try{
    const sig = String(st.roomCode||"" ) + "|" + String(st.phase||"" ) + "|" + String(st.roundNumber||0) + "|" + String(st.collectEndsAt||0) + "|" + String(st.voteEndsAt||0);
    if(sig !== window.__mbLastRoomStatusSig){
      window.__mbLastRoomStatusSig = sig;
      pushDebug("room-status", { roomCode: st.roomCode, phase: st.phase, roundNumber: st.roundNumber, collectEndsAt: st.collectEndsAt, voteEndsAt: st.voteEndsAt, serverNow: st.serverNow });
    }
  }catch(e){}
  updateNextRoundUI();
  try{ updateHostMiniStatus(st); }catch(e){}
  // host view
  if (st?.roomCode && st.roomCode === currentRoom){
    hostPhase = st.phase || "—";
    hostMemesCount = Number(st.memesCount || 0);
    hostMemesRevealed = !!st.memesRevealed;
    $("host-phase").textContent = `Фаза: ${st.phase || "—"}`;
    // Screen split: show Round view during collect, Voting view during vote
    const hostVisible = (!screens.host.classList.contains("hidden"));
    if(hostVisible && st.phase && st.phase !== "lobby"){
      if(st.phase === "collect"){
        setHostView("round");
        if(st.task) hostRoundSetTask(st.task, hostState.round, hostState.totalRounds);
        hostRoundUpdateProgress(st);
      } else if(st.phase === "vote"){
        const prevView = hostView;
        setHostView("voting");

        // keep server vote timer synced even if "voting-started" was missed (reconnect / reload)
        try{
          const ve = Number(st.voteEndsAt || 0);
          if(Number.isFinite(ve) && ve > 0 && ve !== Number(hostVoteState.voteEndsAt || 0)){
            pushDebug("sync:voteEndsAt_from_status", { from: hostVoteState.voteEndsAt || 0, to: ve, serverNow: st.serverNow || null });
            hostVoteState.voteEndsAt = ve;
            hostVoteState.voteStartAt = 0;
          }
          const vs = Number(st.voteSeconds || 0);
          if(Number.isFinite(vs) && vs > 0 && vs !== Number(hostVoteState.secondsTotal || 0)){
            pushDebug("sync:voteSeconds_from_status", { from: hostVoteState.secondsTotal || 0, to: vs });
            hostVoteState.secondsTotal = Math.max(5, vs);
          }
        }catch(e){}

        hostRoundStopTimer();
        try{
          // Enter once per vote phase; keep re-rendering while status updates.
          if(prevView !== "voting") hostVoteEnter(st);
          else hostVoteRender(st);
        }catch(e){}
      } else {
        setHostView("game");
        hostRoundStopTimer();
      }
    }
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

// setup screen players list (online/offline indicators)
const boxSetup = $("host-players-setup");
if (boxSetup){
  boxSetup.innerHTML = "";
  const ps = Array.isArray(st.players) ? st.players : [];
  if(ps.length === 0){
    boxSetup.innerHTML = `<div class="muted">No players yet</div>`;
  } else {
    ps.forEach(p=>{
      const row = document.createElement("div");
      row.className = "plmini";
      const online = !!(p && p.connected);
      const dot = document.createElement("span");
      dot.className = `dot ${online ? "dotOn" : "dotOff"}`;
      const name = document.createElement("span");
      name.className = online ? "nm" : "nm off";
      name.textContent = (p && p.nickname) ? p.nickname : "PLAYER";
      row.appendChild(dot);
      row.appendChild(name);
      if(!online){
        const off = document.createElement("span");
        off.className = "offIcon";
        off.title = "offline";
        off.textContent = "📡";
        row.appendChild(off);
      }
      boxSetup.appendChild(row);
    });
  }
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
            ${renderMemeHTML(m)}
            <div class="cap">${m.caption ? m.caption : ""}</div>
            <div class="meta"><span>${m.nickname||""}</span><b>${Number(m.votes||0)} 👍</b></div>
          `;
          memesBox.appendChild(el);
        });
      }
    }

    // Re-apply per-device TikTok box vars after re-render (new iframes)
    try{ applyPlayerCardVars(loadLocalPlayerCard()||DEFAULT_PLAYER_CARD, "host:memes-render"); }catch(e){}
    try{ applyTTVars("host:memes-render"); }catch(e){}

    // "Start vote" button visibility/enable
    if ($("host-start-vote")){
      const canShow = (st.phase === "collect");
      $("host-start-vote").classList.toggle("hidden", !canShow);
      // enable if at least 1 meme exists (early start) OR all ready event already fired (memesRevealed true)
      $("host-start-vote").disabled = !(hostMemesCount > 0);
      if (st.phase === "collect" && (st.memesCount || 0) > 0) $("host-start-vote").disabled = false;
    }

    // Voting finished signal (host)
    if ($("host-vote-finished")){
      if (st.phase === "vote" && st.voteComplete) $("host-vote-finished").classList.remove("hidden");
      else $("host-vote-finished").classList.add("hidden");
    }
  }

  // player view task + player submit/vote UI
  if (playerState.joined && st?.roomCode === playerState.roomCode){
    const theme = (typeof st.currentTheme === 'string' && st.currentTheme) ? st.currentTheme : (typeof st.task === 'string' ? st.task : '');
    if(theme && $("player-task")) $("player-task").textContent = theme;

    // Round label + status text
    try{
      const rn = Number(st.roundNumber || 0);
      const tr = Number(st.totalRounds || 0);
      if($("player-round-label")) $("player-round-label").textContent = (rn && tr) ? `ROUND ${rn} / ${tr}` : (rn ? `ROUND ${rn}` : 'ROUND — / —');
    }catch(e){}
    try{
      const isCollect = (st.phase === 'collect');
      const isVote = (st.phase === 'vote');
      const isFinished = (st.phase === 'finished');

      playerUi.roundActive = !!isCollect;
      if($("player-task-status")) $("player-task-status").textContent = isCollect ? 'Submit your meme' : 'Waiting for host to start the round';

      // Panels
      pShow('player-vote-panel', isVote);
      pShow('player-final-panel', isFinished);

      // Submission only during collect
      pShow('player-submit-panel', isCollect);
      pShow('player-waiting', !isCollect && !isVote && !isFinished);

      if(!isCollect){
        pShow('player-submit-sticky', false);
      } else {
        playerUpdateSubmitBtn();
      }
    }catch(e){}

    // Timer sync (collect) — centralized via MB:F:PLAYER_TIMER
    try{ playerTimerSyncFromStatus(st); }catch(e){}

    // [ANCHOR] MB:F:PLAYER_SCORE_INDICATOR_SYNC — keep score indicator visible + in sync
    try{
      const ps = Array.isArray(st.players) ? st.players : [];
      const me = ps.find(x=> String(x.id||'') === String(playerState.playerId||''))
              || ps.find(x=> String(x.nickname||'') === String(playerState.nickname||''));
      const myScore = Number(me?.score || 0);
      const hasPlayers = ps.length > 0;

      if($("player-score-value")) $("player-score-value").textContent = String(myScore);

      // Ensure the score button isn't stuck hidden (regression fix)
      pShow('player-score-wrap', hasPlayers);
      pShow('player-score-btn', hasPlayers);
      if(!hasPlayers) $("player-leaderboard")?.classList.add('hidden');

      // Debug: log score changes (helps validate server scoring during live game)
      if(hasPlayers && playerLastScore !== myScore){
        pushDebug('player:score', { score: myScore, playerId: playerState.playerId, nickname: playerState.nickname });
        playerLastScore = myScore;
      }

      try{ playerRenderLeaderboard(ps); }catch(e){}
    }catch(e){}

    // Voting finished signal (player)
    if ($("player-vote-finished")){
      if (st.phase === "vote" && st.voteComplete) $("player-vote-finished").classList.remove("hidden");
      else $("player-vote-finished").classList.add("hidden");
    }

    // Keep settings panel status fresh
    try{ if($("player-settings-status")) $("player-settings-status").textContent = socket.connected ? 'ONLINE' : 'OFFLINE'; }catch(e){}
    try{ if($("player-settings-room")) $("player-settings-room").textContent = playerState.roomCode || '—'; }catch(e){}
  }

  // Legacy: keep TT transforms neutral
  try{ applyTTVars("room-status"); }catch(e){}
});


// [ANCHOR] MB:F:SOCKET:ROUND_TASK — new round payload
socket.on("round-task", (p) => {
  // reset waiting UI for next round
  hideWinnerOverlay();
  nextUiDelayDone = false;
  nextUiRoundNumber = 0;
  hostAutoNextLock = false;
  // [ANCHOR] MB:F:WINNER_NEXT:RESET_LOCAL — reset local vote/ready flags for new round
  try{ if(playerState){ playerState.hasVotedLocal = false; playerState.readyNextLocal = false; } }catch(e){}
  $("player-next-wrap")?.classList.add("hidden");
  $("host-ready-next")?.classList.add("hidden");

  // [BUGWATCH] Важно: очищать player-vote и input'ы при каждом новом раунде, иначе остаются мемы прошлого голосования.
// Player: reset inputs + clear previous voting grid (so old memes don't stick)
  if (playerState.joined && p?.roomCode === playerState.roomCode){
    if ($("player-meme-url")) $("player-meme-url").value = "";
    if ($("player-meme-caption")) $("player-meme-caption").value = "";
    if ($("player-meme-file")) $("player-meme-file").value = "";

    if ($("player-meme-url-link")) $("player-meme-url-link").value = "";
    if ($("player-meme-caption-link")) $("player-meme-caption-link").value = "";
    if ($("player-meme-text")) $("player-meme-text").value = "";

    pShow("player-caption-wrap", false);
    pShow("player-caption-wrap-link", false);

    const img1 = $("player-preview");
    if (img1){ img1.src = ""; img1.classList.add("hidden"); }
    const img2 = $("player-preview-link");
    if (img2){ img2.src = ""; img2.classList.add("hidden"); }

    playerSetMemeType(null);
    pShow("player-sent", false);
  }

  // Host: UI hints + switch to Round screen
  if (p?.roomCode === currentRoom){
    $("host-phase").textContent = "Фаза: collect";
    $("host-vote-finished")?.classList.add("hidden");
    if ($("host-start-vote")) { $("host-start-vote").classList.remove("hidden"); $("host-start-vote").disabled = true; }

    // New Round screen
    const hostVisible = (!screens.host.classList.contains("hidden"));
    if(hostVisible){
      hostState.round = p.round || hostState.round;
      hostState.totalRounds = p.totalRounds || hostState.totalRounds;
      hostRoundSetTask(p.task || "—", hostState.round, hostState.totalRounds);
      setHostView("round");
      hostRoundStartTimer(p.countdownSeconds || 60);
      hostRoundUpdateProgress(lastRoomStatus);
    }
  }
});




// [ANCHOR] MB:F:SOCKET:VOTING_STARTED — start vote, sync endsAt
socket.on("voting-started", ({ roomCode, memes, voteSeconds, voteEndsAt }) => {
  hideWinnerOverlay();
  // hide next-round UI until voting is finished
  nextUiDelayDone = false;

  // sync vote timer length from server (if provided)
  try{ if(Number.isFinite(Number(voteSeconds))) hostVoteState.secondsTotal = Math.max(5, Number(voteSeconds)); }catch(e){}
  // sync voteEndsAt from server for accurate countdown
  try{
    const ve = Number(voteEndsAt);
    if(Number.isFinite(ve) && ve > 0){
      hostVoteState.voteEndsAt = ve;
      hostVoteState.voteStartAt = 0;
    }else if(!(hostVoteState.voteEndsAt > 0)){
      const vs = Number(voteSeconds);
      if(Number.isFinite(vs) && vs > 0) hostVoteState.voteEndsAt = Date.now() + vs * 1000;
    }
  }catch(e){}
  try{ pushDebug("voting-started", { roomCode, voteSeconds, voteEndsAt, clientNow: Date.now() }); }catch(e){}


  $("player-next-wrap")?.classList.add("hidden");
  $("host-ready-next")?.classList.add("hidden");
  if (playerState.joined && roomCode === playerState.roomCode){
    const box = $("player-vote");
    box.innerHTML = "";
    $("player-voted").classList.add("hidden");
    try{ if($("player-voted")) $("player-voted").textContent = "✅ Голос учтён"; }catch(e){}

    (memes||[]).forEach(m=>{
      const el = document.createElement("div");
      el.className = "meme";
      const btn = document.createElement("button");
      btn.className = "primary";
      btn.textContent = "Голосовать";
      btn.addEventListener("click", ()=>{
        socket.emit("player-vote", { roomCode: playerState.roomCode, memeId: m.id }, (res)=>{
          pushDebug("player-vote", res);
          if(!res?.ok){
            const code = String(res?.errorCode || "");
            // Soft-ignore race conditions (last click after vote already closed)
            if(code === "E_VOTE_CLOSED" || code === "E_VOTE_NOT_STARTED"){
              try{
                const pv = $("player-voted");
                if(pv){
                  pv.textContent = "✅ Голосование завершено";
                  pv.classList.remove("hidden");
                }
              }catch(e){}
              try{ box.querySelectorAll("button").forEach(b=>b.disabled=true); }catch(e){}
              return;
            }
            // If we already voted — treat as OK
            if(code !== "E_ALREADY_VOTED"){
              return alert(res?.error || "Ошибка");
            }
          }
          try{ const pv=$("player-voted"); if(pv){ pv.textContent = "✅ Голос учтён"; pv.classList.remove("hidden"); } }catch(e){}
          box.querySelectorAll("button").forEach(b=>b.disabled=true);
        try{ playerState.hasVotedLocal = true; }catch(e){}
        try{ updateNextRoundUI(); }catch(e){}
        });
      });
      el.innerHTML = `${renderMemeHTML(m)}<div class="cap">${m.caption||""}</div>`;
      el.appendChild(btn);
      box.appendChild(el);
    });

    // Apply TT vars after rendering the voting grid
    try{ applyPlayerCardVars(loadLocalPlayerCard()||DEFAULT_PLAYER_CARD, "voting-started"); }catch(e){}
    try{ applyTTVars("voting-started"); }catch(e){}
  }
});


// [ANCHOR] MB:F:SOCKET:VOTING_FINISHED — winners + scoring
socket.on("voting-finished", (payload = {}) => {
  const roomCode = String(payload.roomCode || "").trim().toUpperCase();
  const roundNumber = Number(payload.roundNumber || 0);
  const myRoom = currentRoom || playerState.roomCode;
  if (!roomCode || roomCode !== myRoom) return;

  const rawDisplayMs = payload.displayMs;
  const displayMs = (rawDisplayMs === 0 || rawDisplayMs === "0") ? 0 : Number(rawDisplayMs || 3000);

  pushDebug("voting-finished", {
    roomCode,
    roundNumber,
    winners: Array.isArray(payload.winners) ? payload.winners.length : (payload.winner ? 1 : 0),
    displayMs,
  });

  $("host-vote-finished")?.classList.remove("hidden");
  $("player-vote-finished")?.classList.remove("hidden");

  // disable remaining vote buttons (if any)
  try { $("player-vote")?.querySelectorAll("button")?.forEach(b => b.disabled = true); } catch(e){}

  nextUiDelayDone = false;
  nextUiRoundNumber = roundNumber || 0;
  hostAutoNextLock = false;


  // [ANCHOR] MB:F:PLAYER_SCORE_FROM_VOTING_FINISHED — update score immediately (even if room-status is throttled/missed)
  try{
    const ps = Array.isArray(payload.players) ? payload.players : null;
    if(ps && ps.length){
      // stash into lastRoomStatus so other UI can reuse it
      try{
        if(lastRoomStatus && typeof lastRoomStatus === "object") lastRoomStatus.players = ps;
      }catch(e){}

      const me = ps.find(x=> String(x.id||'') === String(playerState.playerId||''))
              || ps.find(x=> String(x.nickname||'') === String(playerState.nickname||''));
      const myScore = Number(me?.score || 0);

      if ($("player-score-value")) $("player-score-value").textContent = String(myScore);
      pShow('player-score-wrap', true);
      pShow('player-score-btn', true);

      if(playerLastScore !== myScore){
        pushDebug('player:score', { score: myScore, playerId: playerState.playerId, nickname: playerState.nickname, via: "voting-finished" });
        playerLastScore = myScore;
      }

      try{ playerRenderLeaderboard(ps); }catch(e){}
    }
  }catch(e){}

  // Show Winner screen (does not auto-close when displayMs<=0; hides on next round start)
  showWinnerOverlay(payload);

  // Update next-round UI: players who already voted can press "ready"; host will auto-advance only on all-ready-next.
  updateNextRoundUI();
});

// [ANCHOR] MB:F:SOCKET:ALL_READY_NEXT — auto-advance trigger
socket.on("all-ready-next", ({ roomCode, roundNumber, ready, total }) => {
  const myRoom = currentRoom || playerState.roomCode;
  if (!roomCode || roomCode !== myRoom) return;
  pushDebug("all-ready-next", { roomCode, roundNumber, ready, total });

  const isHost = !!currentRoom;
  if (!isHost) return;
  if (hostAutoNextLock) return;
  if (!lastRoomStatus || !lastRoomStatus.voteComplete) return;

  hostAutoNextLock = true;
  setTimeout(() => {
    $("host-next-round")?.click();
  }, 200);
});


// [ANCHOR] MB:F:SOCKET:GAME_FINISHED
socket.on("game-finished", ({ roomCode, results }) => {
  const list = Array.isArray(results) ? results : [];
  if (roomCode === currentRoom){
    $("host-new-game").classList.remove("hidden");
    hostState.scores = {};
    list.forEach(r=> hostState.scores[r.nickname] = r.score );
    renderResults();
    $("host-start-vote")?.classList.add("hidden");

    // New Host Final Results stage (full-screen)
    try{ showFinalOverlay(list); }catch(e){}
  }
  if (playerState.joined && roomCode === playerState.roomCode){
    // [ANCHOR] MB:F:PLAYER_FINAL_SHOW — ensure final winner is visible for players (winner overlay may still be open)
    try{ showFinalOverlay(list, { mode: "player" }); }catch(e){}

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


// [ANCHOR] MB:F:SOCKET:ROOM_CLOSED
socket.on("room-closed", ({ roomCode }) => {
  if (roomCode === currentRoom || roomCode === playerState.roomCode){
    alert("Комната закрыта (ведущий вышел).");
    location.href = location.origin;
  }
});



// -------- App version (visible)
async function loadAppVersion(){
  try{
    const r = await fetch("/api/version", { cache:"no-store" });
    const j = await r.json();
    if(j && j.version){
      window.__MB_VERSION = j.version;
      const el = $("app-version");
      if(el) el.textContent = j.version;
    }
  }catch(e){}
}
loadAppVersion();


// -------- Admin dashboard (simple)
const LS_ADMIN_TOKEN = "mb_admin_token_v1";
const adminState = {
  token: localStorage.getItem(LS_ADMIN_TOKEN) || "",
  authed: false,
  tab: "overview",
  last: null,
  pollTimer: null,
};

function h(s){
  return String(s ?? "")
    .replaceAll("&","&amp;")
    .replaceAll("<","&lt;")
    .replaceAll(">","&gt;")
    .replaceAll('"',"&quot;")
    .replaceAll("'","&#39;");
}

function adminVisible(){
  const el = screens?.admin;
  return !!el && !el.classList.contains("hidden");
}

function adminSetStatus(msg){
  const el = $("admin-status");
  if(el) el.textContent = msg || "";
}

function adminSetAuthed(on){
  adminState.authed = !!on;
  $("admin-body")?.classList.toggle("hidden", !adminState.authed);
  $("admin-login")?.classList.toggle("hidden", adminState.authed);
  $("admin-logout")?.classList.toggle("hidden", !adminState.authed);
}

async function adminApi(path, opts = {}){
  const headers = Object.assign({}, opts.headers || {});
  headers["x-admin-token"] = adminState.token || "";
  const res = await fetch(path, {
    method: opts.method || "GET",
    headers: Object.assign({ "content-type":"application/json" }, headers),
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    cache: "no-store",
  });
  const json = await res.json().catch(()=>({ ok:false, error:"E_BAD_JSON" }));
  if(!res.ok) return { ok:false, status: res.status, ...json };
  return json;
}

function fmtUptime(sec){
  sec = Number(sec||0);
  const h = Math.floor(sec/3600);
  const m = Math.floor((sec%3600)/60);
  const s = Math.floor(sec%60);
  return (h? `${h}ч `:"") + (m? `${m}м `:"") + `${s}с`;
}

function renderStats(data){
  const box = $("admin-stats");
  if(!box) return;
  box.innerHTML = "";

  const cards = [
    ["Версия", data.version || "—", data.serverTime || ""],
    ["Uptime", fmtUptime(data.uptimeSec), ""],
    ["Socket online", data.socketsOnline, ""],
    ["Комнат", data.roomsActive, `в игре: ${data.gamesInProgress}`],
    ["API req", data.totals?.httpApiRequests ?? 0, ""],
    ["Создано комнат", data.totals?.roomsCreated ?? 0, ""],
    ["Входов", data.totals?.playerJoins ?? 0, ""],
    ["Мемов", data.totals?.memesSubmitted ?? 0, ""],
    ["Голосов", data.totals?.votesCast ?? 0, ""],
    ["Ошибок", data.totals?.errors ?? 0, "включая user errors"],
  ];

  for(const [k,v,s] of cards){
    const el = document.createElement("div");
    el.className = "statcard";
    el.innerHTML = `<div class="k">${h(k)}</div><div class="v">${h(v)}</div>${s?`<div class="s">${h(s)}</div>`:""}`;

    // Click on "Ошибок" -> open debug modal
    if(String(k).toLowerCase().includes("ошиб")){
      el.classList.add("clickable");
      el.title = "Показать детали ошибок";
      el.addEventListener("click", () => adminOpenErrorsModal());
    }

    box.appendChild(el);
  }
}

function renderEvents(list, targetId){
  const box = $(targetId);
  if(!box) return;
  const events = Array.isArray(list) ? list : [];
  box.innerHTML = events.slice(0, 120).map(e => {
    const t = e.ts ? String(e.ts).replace("T"," ").replace("Z","") : "";
    return `<div class="logline"><span class="code">${h(t)}</span> · <b>${h(e.tag)}</b> — ${h(JSON.stringify(e.detail||{}))}</div>`;
  }).join("") || `<div class="muted">нет событий</div>`;
}

function renderActivity(data){
  const box = $("admin-activity");
  if(!box) return;
  const rooms = Array.isArray(data.rooms) ? data.rooms : [];
  const active = rooms.filter(r => r.phase === "collect" || r.phase === "vote").slice(0, 8);
  box.innerHTML = active.map(r => {
    return `<div class="pl" data-room="${h(r.code)}">
      <div><b class="code">${h(r.code)}</b> · ${h(r.phase)} · раунд ${h(r.roundNumber)}</div>
      <div class="muted">${h(r.playersOnline)}/${h(r.playersTotal)} · мемов ${h(r.memesCount)}</div>
    </div>`;
  }).join("") || `<div class="muted">нет активных игр</div>`;

  // allow quick open
  box.querySelectorAll("[data-room]").forEach(el=>{
    el.style.cursor="pointer";
    el.addEventListener("click", ()=> adminOpenRoom(el.getAttribute("data-room")));
  });
}

function renderRoomsList(rooms){
  const box = $("admin-rooms");
  if(!box) return;
  const list = Array.isArray(rooms) ? rooms : [];
  box.innerHTML = list.map(r => {
    const t = r.updatedAt ? new Date(Number(r.updatedAt)).toLocaleString() : "";
    return `<div class="pl" data-room="${h(r.code)}">
      <div>
        <b class="code">${h(r.code)}</b> · ${h(r.phase)} · раунд ${h(r.roundNumber)}
        <div class="muted">${h(r.task || "")}</div>
      </div>
      <div class="muted">${h(r.playersOnline)}/${h(r.playersTotal)} · мемов ${h(r.memesCount)}${t?`<div class="muted">${h(t)}</div>`:""}</div>
    </div>`;
  }).join("") || `<div class="muted">нет комнат</div>`;

  box.querySelectorAll("[data-room]").forEach(el=>{
    el.style.cursor="pointer";
    el.addEventListener("click", ()=> adminOpenRoom(el.getAttribute("data-room")));
  });
}

function renderSandbox(sb){
  const list = sb?.rooms || [];
  const box = $("admin-sb-list");
  if(!box) return;

  box.innerHTML = list.map(r => {
    const players = Array.isArray(r.players) ? r.players.length : 0;
    const memes = Array.isArray(r.memes) ? r.memes.length : 0;
    return `<div class="pl" data-sb="${h(r.code)}">
      <div>
        <b class="code">${h(r.code)}</b> · ${h(r.phase)} · раунд ${h(r.roundNumber)}
        <div class="muted">${h(r.task || "")}</div>
      </div>
      <div class="muted">${h(players)} players · ${h(memes)} memes</div>
    </div>`;
  }).join("") || `<div class="muted">песочница пуста</div>`;

  box.querySelectorAll("[data-sb]").forEach(el=>{
    el.style.cursor = "pointer";
    el.addEventListener("click", ()=>{
      const code = el.getAttribute("data-sb");
      const r = list.find(x => String(x.code) === String(code));
      if(!r) return;
      // reuse room overlay
      $("admin-room-title").textContent = `Песочница ${h(r.code)} · ${h(r.phase)}`;
      const players = Array.isArray(r.players) ? r.players : [];
      const memes = Array.isArray(r.memes) ? r.memes : [];
      const playersHtml = players.map(p=>`<div class="pl"><div><b>${h(p.nickname||p.id)}</b> ${p.connected?`<span class="pill">online</span>`:""} ${p.hasMeme?`<span class="pill ok">meme</span>`:""} ${p.hasVoted?`<span class="pill ok">vote</span>`:""}</div><div class="muted">${h(p.id||"")}</div></div>`).join("") || `<div class="muted">нет игроков</div>`;
      const memesHtml = memes.map(m=>`<div class="pl"><div><b>${h(m.nickname||"")}</b> · votes: ${h(m.votes||0)}<div class="muted">${h(m.caption||"")}</div></div><div class="muted">${h(m.urlPreview||"")}</div></div>`).join("") || `<div class="muted">нет мемов</div>`;
      $("admin-room-detail").innerHTML = `
        <div class="grid2">
          <div class="panel"><h3>Игроки (${players.length})</h3><div class="list">${playersHtml}</div></div>
          <div class="panel"><h3>Мемы (${memes.length})</h3><div class="list">${memesHtml}</div></div>
        </div>
        <div class="row" style="margin-top:10px; justify-content:flex-end">
          <button class="ghost" id="admin-sb-copy-json" type="button">Copy JSON</button>
        </div>
      `;
      $("admin-room-overlay").classList.remove("hidden");
      setTimeout(()=>{
        $("admin-sb-copy-json")?.addEventListener("click", async ()=>{
          try{
            await navigator.clipboard.writeText(JSON.stringify(r, null, 2));
            adminSetStatus("Sandbox JSON скопирован");
          }catch{}
        });
      },0);
    });
  });
}

function adminSetTab(tab){
  adminState.tab = tab;
  document.querySelectorAll("#screen-admin .tabbtn").forEach(b=>{
    b.classList.toggle("active", b.getAttribute("data-tab") === tab);
  });
  ["overview","rooms","sandbox","logs"].forEach(t=>{
    $("admin-tab-"+t)?.classList.toggle("hidden", t !== tab);
  });

  // render logs view (uses last events)
  if(tab === "logs") adminRenderLogFiltered();
}

function adminRenderLogFiltered(){
  const filter = String($("admin-log-filter")?.value || "").trim().toLowerCase();
  const events = adminState.last?.events || [];
  const filtered = !filter ? events : events.filter(e => JSON.stringify(e).toLowerCase().includes(filter));
  renderEvents(filtered, "admin-log");
}

async function adminRefresh(){
  const data = await adminApi("/api/admin/overview");
  if(!data.ok){
    adminSetStatus(data.error || data.errorCode || "Ошибка");
    adminSetAuthed(false);
    return null;
  }
  adminState.last = data;

  renderStats(data);
  renderActivity(data);
  renderEvents(data.events, "admin-events");
  renderSandbox(data.sandbox);
  adminUpdateRoomCodesDatalist(data.rooms);
  if(adminState.tab === "rooms") renderRoomsList(data.rooms);
  if(adminState.tab === "logs") adminRenderLogFiltered();
  return data;
}

function adminStartPolling(){
  if(adminState.pollTimer) clearInterval(adminState.pollTimer);
  adminState.pollTimer = setInterval(()=>{
    if(!adminState.authed) return;
    if(!adminVisible()) return;
    adminRefresh().catch(()=>{});
  }, 2000);
}
function adminStopPolling(){
  if(adminState.pollTimer) clearInterval(adminState.pollTimer);
  adminState.pollTimer = null;
}

async function adminLogin(){
  adminState.token = String($("admin-token")?.value || "").trim();
  if(!adminState.token){
    adminSetStatus("Нужен token (см. ADMIN_TOKEN на сервере).");
    return;
  }
  const data = await adminApi("/api/admin/overview");
  if(!data.ok){
    adminSetStatus("Не удалось войти: " + (data.error || data.errorCode || "ошибка"));
    adminSetAuthed(false);
    return;
  }
  localStorage.setItem(LS_ADMIN_TOKEN, adminState.token);
  adminSetStatus("OK");
  adminSetAuthed(true);
  adminSetTab(adminState.tab || "overview");
  adminStartPolling();
  adminRefresh().catch(()=>{});
}

function adminLogout(){
  adminState.authed = false;
  adminState.token = "";
  localStorage.removeItem(LS_ADMIN_TOKEN);
  $("admin-token").value = "";
  adminSetStatus("Вы вышли");
  adminSetAuthed(false);
  adminStopPolling();
}

async function adminOpenRoom(code){
  if(!adminState.authed) return;
  const data = await adminApi("/api/admin/room/" + encodeURIComponent(String(code||"").toUpperCase()));
  if(!data.ok) return adminSetStatus("Комната не найдена");
  const room = data.room;
  $("admin-room-title").textContent = `Комната ${room.code} · ${room.phase}`;
  const box = $("admin-room-detail");
  const players = Array.isArray(room.players) ? room.players : [];
  const memes = Array.isArray(room.memes) ? room.memes : [];

  const playersHtml = players.map(p=>`<div class="pl"><div><b>${h(p.nickname)}</b> <span class="muted code">${h(p.id)}</span></div><div class="muted">${p.connected?"online":"off"} · meme:${p.hasMeme?"✓":"—"} · vote:${p.hasVoted?"✓":"—"} · score:${h(p.score)}</div></div>`).join("") || `<div class="muted">нет игроков</div>`;
  const memesHtml = memes.map(m=>`<div class="pl"><div><b>${h(m.nickname)}</b> <span class="muted code">${h(m.id)}</span><div class="muted">${h(m.caption||"")}</div></div><div class="muted">votes: <b>${h(m.votes)}</b><div class="muted code">${h(m.urlPreview||"")}</div></div></div>`).join("") || `<div class="muted">нет мемов</div>`;

  box.innerHTML = `
    <div class="grid2">
      <div class="panel">
        <h3>Игроки (${players.length})</h3>
        <div class="list">${playersHtml}</div>
      </div>
      <div class="panel">
        <h3>Мемы (${memes.length})</h3>
        <div class="list">${memesHtml}</div>
      </div>
    </div>
  `;
  $("admin-room-overlay").classList.remove("hidden");
}

function adminCloseRoom(){
  $("admin-room-overlay").classList.add("hidden");
}


// ===== Admin errors modal =====
function adminHumanError(code){
  const c = String(code || "").trim().toUpperCase();
  const map = {
    "E_ADMIN_AUTH": {
      title: "Неверный admin token",
      explain: "Токен не совпадает с ADMIN_TOKEN на сервере. Проверь Secrets/ENV и перезапусти сервер."
    },
    "E_ROOM_NOT_FOUND": {
      title: "Комната не найдена",
      explain: "Код комнаты неверный или комната уже закрыта (ведущий вышел/сервер перезапустился)."
    },
    "E_NO_ROOM": { title:"Комната не найдена", explain:"Сессия комнаты не существует на сервере." },
    "E_ROOM_LOCKED": { title:"Комната закрыта для новых игроков", explain:"Игра уже стартовала. Новые игроки не могут зайти с новым ником." },
    "E_WRONG_PHASE": { title:"Неподходящая фаза", explain:"Действие не подходит к текущей фазе (lobby/collect/vote/finished)." },
    "E_VOTE_NOT_STARTED": { title:"Голосование не началось", explain:"Сначала ведущий должен запустить голосование." },
    "E_VOTE_CLOSED": { title:"Голосование завершено", explain:"Все участники уже проголосовали, голосование закрыто. Можно переходить к следующему раунду." },
    "E_ALREADY_VOTED": { title:"Повторный голос", explain:"Игрок уже голосовал. По правилам это запрещено." },
    "E_VOTE_OWN_MEME": { title:"Голос за свой мем", explain:"Нельзя голосовать за свой мем (проверка анти-чит)." },
    "E_MEME_NOT_FOUND": { title:"Мем не найден", explain:"ID мема не существует или список мемов изменился." },
    "E_NOT_HOST": { title:"Нет прав ведущего", explain:"Эту кнопку/действие может выполнять только ведущий." },
    "E_NOT_IN_ROOM": { title:"Игрок не в комнате", explain:"Сокет/игрок не привязан к комнате или сессия потеряна." },
    "E_BAD_DATA": { title:"Некорректные данные", explain:"Клиент отправил неполные/битые данные (поля пустые)." },
    "E_NO_THEMES": { title:"Нет тем", explain:"Нужно выбрать хотя бы одну тему перед генерацией заданий." },
    "E_TOO_MANY_THEMES": { title:"Слишком много тем", explain:"Тем не должно быть больше, чем раундов." },
    "E_NO_OPENAI_KEY": { title:"Нет OpenAI API ключа", explain:"На сервере не задан OPENAI_API_KEY. Либо используй ручные задания." },
    "E_OPENAI_TIMEOUT": { title:"OpenAI timeout", explain:"Сервер не успел дождаться ответа модели. Попробуй позже или уменьши сложность/кол-во раундов." },
    "E_OPENAI_BAD_JSON": { title:"OpenAI вернул неожиданный формат", explain:"Модель вернула текст, который не удалось распарсить как JSON. Можно повторить запрос." },
    "E_BAD_JSON": { title:"Плохой JSON от сервера", explain:"Клиент ожидал JSON, но получил другое. Проверь логи сервера/прокси." },
  };

  if(map[c]) return map[c];

  if(c.startsWith("E_OPENAI")) return { title: "Проблема с OpenAI", explain: "Ошибка при запросе к модели. Посмотри details и логи сервера." };
  if(c.startsWith("E_")) return { title: "Ошибка игры", explain: "Смотри errorText/details ниже — там обычно причина и контекст." };
  return { title: "Неизвестная ошибка", explain: "Смотри raw details ниже." };
}

function adminExtractErrorEvents(events){
  const arr = Array.isArray(events) ? events : [];
  return arr.filter(e=>{
    const tag = String(e?.tag || "").toLowerCase();
    const code = e?.detail?.errorCode || e?.errorCode;
    return tag === "error" || tag.includes("error") || !!code;
  });
}

function adminGroupErrors(errors){
  const m = new Map();
  for(const e of (Array.isArray(errors) ? errors : [])){
    const code = String(e?.detail?.errorCode || e?.errorCode || "E_UNKNOWN").toUpperCase();
    const g = m.get(code) || { code, count:0, last:null, samples:[] };
    g.count++;
    if(!g.last || String(e.ts||"") > String(g.last.ts||"")) g.last = e;
    if(g.samples.length < 3) g.samples.push(e);
    m.set(code, g);
  }
  return Array.from(m.values()).sort((a,b)=> (b.count - a.count) || String(b.code).localeCompare(String(a.code)));
}

function adminFmtTs(ts){
  if(!ts) return "";
  return String(ts).replace("T"," ").replace("Z","");
}

async function adminOpenErrorsModal(){
  if(!adminState.authed) return;
  const modal = $("admin-errors-modal");
  const body = $("admin-errors-body");
  const title = $("admin-errors-title");
  const hint = $("admin-errors-hint");
  if(!modal || !body) return;

  modal.classList.remove("hidden");
  body.innerHTML = `<div class="muted">Загрузка…</div>`;

  let errors = [];
  try{
    const r = await adminApi("/api/admin/errors?limit=200");
    if(r?.ok && Array.isArray(r.errors)) errors = r.errors;
  }catch(e){}

  if(errors.length === 0){
    errors = adminExtractErrorEvents(adminState.last?.events || []);
  }

  adminState.lastErrors = errors;

  const groups = adminGroupErrors(errors);
  if(title) title.textContent = `Ошибки (последние ${errors.length})`;
  const total = adminState.last?.totals?.errors;
  if(hint) hint.textContent = `Счётчик ошибок: ${total ?? "—"} · здесь показаны последние события ошибок (debug). Нажми на строку, чтобы раскрыть детали.`;

  if(groups.length === 0){
    body.innerHTML = `<div class="muted">ошибок нет</div>`;
    return;
  }

  body.innerHTML = groups.map(g=>{
    const last = g.last || {};
    const code = g.code;
    const exp = adminHumanError(code);
    const t = adminFmtTs(last.ts);
    const errorText = last?.detail?.errorText || last?.errorText || "";
    const details = last?.detail?.details || last?.details || "";
    const sample = g.samples.map(s=>{
      const st = adminFmtTs(s.ts);
      const et = s?.detail?.errorText || s?.errorText || "";
      const dd = s?.detail?.details || s?.details || "";
      return `• ${st} — ${String(et||"").slice(0,140)}${dd?(" | "+String(dd).slice(0,160)):""}`;
    }).join("\n");

    return `<div class="errRow" data-code="${h(code)}">
      <div class="top">
        <div style="display:flex; align-items:baseline; gap:10px; flex-wrap:wrap">
          <span class="count">${h(g.count)}</span>
          <b class="code">${h(code)}</b>
          <span class="muted">${h(t)}</span>
        </div>
        <div class="muted">${h(exp.title)}</div>
      </div>
      <div class="explain">${h(exp.explain)}</div>
      <div class="msg">${h(errorText)}${details?("\n"+h(String(details).slice(0,500))):""}</div>
      <div class="details"><b>Последние примеры:</b>\n${h(sample || "—")}</div>
    </div>`;
  }).join("");

  body.querySelectorAll(".errRow").forEach(el=>{
    el.addEventListener("click", ()=> el.classList.toggle("open"));
  });
}

function adminCloseErrorsModal(){
  $("admin-errors-modal")?.classList.add("hidden");
}

async function adminCopyErrorsJson(){
  try{
    const data = adminState.lastErrors || [];
    await navigator.clipboard.writeText(JSON.stringify(data, null, 2));
    adminSetStatus("Ошибки скопированы");
  }catch(e){
    adminSetStatus("Не получилось скопировать");
  }
}
// ===== End admin errors modal =====


async function adminSandboxGenerate(){
  const rooms = Number($("admin-sb-rooms")?.value || 3);
  const players = Number($("admin-sb-players")?.value || 4);
  const memes = Number($("admin-sb-memes")?.value || 4);
  const r = await adminApi("/api/admin/sandbox/generate", { method:"POST", body:{ rooms, players, memes } });
  if(!r.ok){
    $("admin-sb-status").textContent = "Ошибка генерации";
    return;
  }
  $("admin-sb-status").textContent = "OK";
  // refresh overview to pull sandbox list
  adminRefresh().catch(()=>{});
}

async function adminSandboxReset(){
  const r = await adminApi("/api/admin/sandbox/reset", { method:"POST", body:{} });
  $("admin-sb-status").textContent = r.ok ? "Сброшено" : "Ошибка";
  adminRefresh().catch(()=>{});
}


async function adminRtCall(endpoint, body, okText){
  const roomCode = String($("admin-rt-code")?.value || "").trim().toUpperCase();
  if(!roomCode){
    $("admin-rt-status").textContent = "Нужен код комнаты";
    return null;
  }
  const r = await adminApi("/api/admin/sandbox/real/" + endpoint, { method:"POST", body:{ roomCode, ...body } });
  if(!r.ok){
    $("admin-rt-status").textContent = "Ошибка: " + (r.error || "E_FAIL");
    return null;
  }
  $("admin-rt-status").textContent = okText || "OK";
  adminRefresh().catch(()=>{});
  return r;
}
async function adminRtAddBots(){
  const count = Number($("admin-rt-bots")?.value || 2);
  const connected = !!$("admin-rt-bots-online")?.checked;
  const r = await adminRtCall("add-bots", { count, connected }, `Боты добавлены: +${count}`);
  if(r && r.added != null) $("admin-rt-status").textContent = `Боты добавлены: +${r.added}`;
}
async function adminRtFillMemes(){
  await adminRtCall("fill-memes", { mode:"missing", overwrite:false }, "Мемы заполнены");
}
async function adminRtReveal(){
  await adminRtCall("reveal", {}, "Показали мемы");
}
async function adminRtForceVote(){
  await adminRtCall("force-vote", {}, "Фаза vote запущена");
}
async function adminRtAutoVote(){
  const r = await adminRtCall("auto-vote", {}, "Голоса добавлены");
  if(r && r.votes != null) $("admin-rt-status").textContent = `Авто-голоса: +${r.votes}`;
}
async function adminRtResetRound(){
  await adminRtCall("reset-round", {}, "Раунд сброшен");
}

function adminUpdateRoomCodesDatalist(rooms){
  const dl = $("admin-roomcodes");
  if(!dl) return;
  const list = Array.isArray(rooms) ? rooms : [];
  dl.innerHTML = list.map(r=>`<option value="${h(r.code)}"></option>`).join("");
}


// ===== Admin Autotest (real sockets, real game flow) =====
const adminAT = {
  running: false,
  mode: "auto",            // auto | step
  stepIndex: 0,
  cancelled: false,
  roomCode: "",
  hostSock: null,
  botSocks: [],
  botMeta: [],             // {nick, kind, socket, playerId}
  history: [],             // {ts, level, title, detail, snapshot}
  latestStatus: null,
  votingMemes: null,
  finalResults: null,
  report: null,
};

function atNow(){
  return new Date().toISOString();
}
function atSetStatus(msg){
  const el = $("admin-at-status");
  if(el) el.textContent = msg || "";
}
function atSetRoom(code){
  adminAT.roomCode = String(code||"").toUpperCase();
  const el = $("admin-at-room");
  if(el) el.textContent = adminAT.roomCode || "—";
}
function atRender(){
  const box = $("admin-at-history");
  if(box){
    const items = adminAT.history.slice().reverse();
    box.innerHTML = items.map((x, i)=>{
      const cls = x.level === "ok" ? "ok" : (x.level === "warn" ? "warn" : (x.level === "fail" ? "fail" : ""));
      const title = h(x.title || "");
      const t = h(x.ts || "");
      const detail = h(x.detail || "");
      const snap = x.snapshot ? h(JSON.stringify(x.snapshot)) : "";
      return `<div class="testStep ${cls}" data-at-i="${i}">
        <div><span class="t code">${t}</span> · <b>${title}</b></div>
        <div class="d">${detail}${snap?`\n\nsnapshot:\n${snap}`:""}</div>
      </div>`;
    }).join("") || `<div class="muted">пока пусто</div>`;

    box.querySelectorAll(".testStep").forEach(el=>{
      el.addEventListener("click", ()=> el.classList.toggle("open"));
    });
  }

  const pre = $("admin-at-report");
  if(pre){
    pre.textContent = adminAT.report ? JSON.stringify(adminAT.report, null, 2) : "—";
  }

  const copyBtn = $("admin-at-copy");
  if(copyBtn) copyBtn.disabled = !adminAT.report;

  const cancelBtn = $("admin-at-cancel");
  if(cancelBtn) cancelBtn.disabled = !adminAT.running;
}

async function atCopyReport(){
  try{
    const txt = $("admin-at-report")?.textContent || "";
    await navigator.clipboard.writeText(txt);
    atSetStatus("Отчёт скопирован");
  }catch(e){
    atSetStatus("Не получилось скопировать");
  }
}

function atClear(){
  adminAT.history = [];
  adminAT.report = null;
  adminAT.latestStatus = null;
  adminAT.votingMemes = null;
  adminAT.finalResults = null;
  atSetRoom("");
  atSetStatus("Очищено");
  atRender();
}

function atPush(level, title, detail, snapshot){
  adminAT.history.push({
    ts: atNow(),
    level: level || "info",
    title: String(title||""),
    detail: detail ? String(detail) : "",
    snapshot: snapshot || null
  });
  atRender();
}

function atDisconnectAll(){
  try{ adminAT.hostSock?.disconnect?.(); }catch(e){}
  try{ adminAT.botSocks.forEach(s=>{ try{s.disconnect();}catch(e){} }); }catch(e){}
  adminAT.hostSock = null;
  adminAT.botSocks = [];
  adminAT.botMeta = [];
}

function atCancel(){
  adminAT.cancelled = true;
  atPush("warn", "cancel", "Остановлено пользователем");

  // Force-close sockets so текущий шаг быстро упал с ошибкой/таймаутом.
  atDisconnectAll();

  atSetStatus("Остановлено");
  atResetStepButton();
  atRender();
}


function atDelay(ms){
  return new Promise(r => setTimeout(r, ms));
}

function atWaitConnect(sock, timeoutMs = 8000){
  return new Promise((resolve, reject)=>{
    if(sock.connected) return resolve();
    const t = setTimeout(()=>{ cleanup(); reject(new Error("E_CONNECT_TIMEOUT")); }, timeoutMs);
    function cleanup(){
      clearTimeout(t);
      sock.off("connect", onOk);
      sock.off("connect_error", onErr);
    }
    function onOk(){ cleanup(); resolve(); }
    function onErr(err){ cleanup(); reject(err || new Error("E_CONNECT_FAIL")); }
    sock.on("connect", onOk);
    sock.on("connect_error", onErr);
  });
}

function atEmitCb(sock, eventName, payload, timeoutMs = 12000){
  return new Promise((resolve, reject)=>{
    let done = false;
    const t = setTimeout(()=>{
      if(done) return;
      done = true;
      reject(new Error("E_TIMEOUT_" + eventName));
    }, timeoutMs);
    try{
      if(payload === undefined){
        sock.emit(eventName, (res)=>{ if(done) return; done = true; clearTimeout(t); resolve(res); });
      }else{
        sock.emit(eventName, payload, (res)=>{ if(done) return; done = true; clearTimeout(t); resolve(res); });
      }
    }catch(e){
      if(done) return;
      done = true; clearTimeout(t);
      reject(e);
    }
  });
}

// --- Test media samples ---
function atSvgDataUrl(text){
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="720" height="420">
    <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#0ff"/><stop offset="1" stop-color="#f0f"/>
    </linearGradient></defs>
    <rect width="100%" height="100%" fill="url(#g)"/>
    <text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" font-size="48" font-family="Arial" fill="#000">${String(text||"BOT")}</text>
  </svg>`;
  return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
}

const AT_GIF_1PX = "data:image/gif;base64,R0lGODlhAQABAPAAAP///wAAACH5BAAAAAAALAAAAAABAAEAAAICRAEAOw==";

async function atMakeTinyVideoDataUrl(){
  // Tries to make a tiny WebM via MediaRecorder. Falls back to URL if browser blocks it.
  const fallbackUrl = "https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4";
  try{
    if(typeof MediaRecorder === "undefined") return fallbackUrl;

    const canvas = document.createElement("canvas");
    canvas.width = 160; canvas.height = 90;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#111";
    ctx.fillRect(0,0,canvas.width,canvas.height);
    ctx.fillStyle = "#0ff";
    ctx.font = "20px Arial";
    ctx.fillText("BOT VIDEO", 18, 50);

    const stream = canvas.captureStream(15);
    const mimeCandidates = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"];
    let mimeType = "";
    for(const m of mimeCandidates){
      if(MediaRecorder.isTypeSupported?.(m)){ mimeType = m; break; }
    }
    const rec = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    const chunks = [];
    rec.ondataavailable = (e)=>{ if(e.data && e.data.size) chunks.push(e.data); };
    const stopped = new Promise((resolve)=> rec.onstop = resolve );

    rec.start(120);
    // animate 5 frames
    for(let i=0;i<5;i++){
      ctx.fillStyle = i%2 ? "#f0f" : "#0ff";
      ctx.fillRect(0,0,canvas.width,canvas.height);
      ctx.fillStyle = "#000";
      ctx.fillRect(10+i*6, 10+i*3, 40, 20);
      ctx.fillStyle = "#fff";
      ctx.fillText("BOT VIDEO", 18, 50);
      await atDelay(80);
    }
    rec.stop();
    await stopped;

    const blob = new Blob(chunks, { type: rec.mimeType || "video/webm" });
    if(blob.size < 100) return fallbackUrl;

    const dataUrl = await new Promise((resolve, reject)=>{
      const fr = new FileReader();
      fr.onerror = () => reject(new Error("E_FILE_READER"));
      fr.onload = () => resolve(String(fr.result || ""));
      fr.readAsDataURL(blob);
    });
    return dataUrl || fallbackUrl;
  }catch(e){
    return fallbackUrl;
  }
}

function atBotPlan(){
  // Covers: image file (data), gif file (data), video file (data/url), youtube link, tiktok link
  return [
    { nick: "Bot_IMG", kind: "image_data", make: async ()=>({ url: atSvgDataUrl("IMG"), caption: "BOT image (data)" }) },
    { nick: "Bot_GIF", kind: "gif_data", make: async ()=>({ url: AT_GIF_1PX, caption: "BOT gif (data)" }) },
    { nick: "Bot_VID", kind: "video_data_or_url", make: async ()=>({ url: await atMakeTinyVideoDataUrl(), caption: "BOT video" }) },
    { nick: "Bot_YT", kind: "youtube_link", make: async ()=>({ url: "https://youtu.be/dQw4w9WgXcQ", caption: "BOT youtube link" }) },
    { nick: "Bot_TT", kind: "tiktok_link", make: async ()=>({ url: "https://www.tiktok.com/@prokendol112/video/7508817190636752146", caption: "BOT tiktok link" }) },
  ];
}

async function atSnapshotRoom(){
  if(!adminState.authed || !adminAT.roomCode) return null;
  const d = await adminApi("/api/admin/room/" + encodeURIComponent(adminAT.roomCode));
  if(d && d.ok && d.room) return d.room;
  return null;
}

function atEnsureNotCancelled(){
  if(adminAT.cancelled) throw new Error("E_CANCELLED");
}

// Computes points: 10 pts per vote. Winner gets +20% bonus points for that round.
function atComputeRoundScores(memes){
  const out = {};
  const list = Array.isArray(memes) ? memes : [];
  for(const m of list){
    const name = String(m.nickname || "");
    const votes = Number(m.votes || 0);
    out[name] = (out[name] || 0) + votes * 10;
  }
  // find winner(s)
  let best = -1;
  let winners = [];
  for(const m of list){
    const v = Number(m.votes || 0);
    if(v > best){ best = v; winners = [m]; }
    else if(v === best){ winners.push(m); }
  }
  // bonus only if single winner
  if(winners.length === 1 && best > 0){
    const w = winners[0];
    const name = String(w.nickname || "");
    const base = best * 10;
    const bonus = Math.round(base * 0.2);
    out[name] = (out[name] || 0) + bonus;
  }
  return out;
}

async function atCreateRoom(){
  atEnsureNotCancelled();
  atPush("info", "create_room", "Создаю комнату…");
  const hostSock = io(location.origin, { transports:["websocket","polling"], forceNew:true });
  adminAT.hostSock = hostSock;

  hostSock.on("room-status", (st)=>{
    if(st && st.roomCode && String(st.roomCode).toUpperCase() === adminAT.roomCode){
      adminAT.latestStatus = st;
    }
  });
  hostSock.on("voting-started", (payload)=>{ adminAT.votingMemes = payload?.memes || null; });
  hostSock.on("game-finished", (payload)=>{ adminAT.finalResults = payload?.results || null; });

  await atWaitConnect(hostSock);
  const res = await atEmitCb(hostSock, "host-create-room", undefined, 8000);
  if(!res?.ok) throw new Error(res?.error || "E_CREATE_ROOM");
  atSetRoom(res.roomCode);
  const snap = await atSnapshotRoom();
  atPush("ok", "create_room", "Комната создана: " + res.roomCode, snap);
  return res.roomCode;
}

async function atAddBots(){
  atEnsureNotCancelled();
  atPush("info", "bots_join", "Подключаю ботов…");
  const plan = atBotPlan();
  adminAT.botMeta = [];
  adminAT.botSocks = [];
  for(const b of plan){
    const s = io(location.origin, { transports:["websocket","polling"], forceNew:true });
    adminAT.botSocks.push(s);
    await atWaitConnect(s);
    const r = await atEmitCb(s, "player-join", { roomCode: adminAT.roomCode, nickname: b.nick }, 8000);
    if(!r?.ok) throw new Error("E_BOT_JOIN_" + b.nick + ":" + (r?.error || ""));
    adminAT.botMeta.push({ nick: b.nick, kind: b.kind, socket: s, playerId: r.playerId || "" });
  }
  const snap = await atSnapshotRoom();
  atPush("ok", "bots_join", `Боты online: ${adminAT.botMeta.length}`, snap);
  return adminAT.botMeta.length;
}

async function atGenerateTasks(rounds){
  atEnsureNotCancelled();
  const theme = String($("admin-at-theme")?.value || "").trim();
  const themes = theme ? [theme] : ["тест", "мемы"];
  atPush("info", "tasks", "Пробую сгенерировать задания…");
  // Try AI tasks via host socket. If not available — fallback.
  let tasks = [];
  try{
    const r = await atEmitCb(adminAT.hostSock, "host-generate-tasks", {
      roomCode: adminAT.roomCode,
      totalRounds: rounds,
      themes,
      edgeLevelMax: 2,
    }, 25000);
    if(r?.ok && Array.isArray(r.tasks)) tasks = r.tasks;
    if(tasks.length){
      atPush("ok", "tasks", `ИИ‑задания: ${tasks.length}`);
      return tasks;
    }
    // if not ok — warn and fall through
    atPush("warn", "tasks", `ИИ не сработал: ${r?.error || r?.message || "fallback"}`);
  }catch(e){
    atPush("warn", "tasks", "ИИ не сработал (fallback): " + String(e?.message || e));
  }
  // Fallback tasks
  const base = [
    "Мем про баг, который появляется только на проде.",
    "Когда ты уверен, что всё готово, но кнопки снова не нажимаются.",
    "Тестировщик: «пофикси вот это», а ты уже пофиксил другое.",
    "Когда тикток снова режется рамками.",
    "Когда бот прислал мем лучше человека.",
  ];
  tasks = [];
  for(let i=0;i<rounds;i++) tasks.push(base[i % base.length]);
  atPush("ok", "tasks", `Фоллбек задания: ${tasks.length}`);
  return tasks;
}

async function atPlayRound(roundNumber, taskText, totalScores){
  atEnsureNotCancelled();
  const roomCode = adminAT.roomCode;

  atPush("info", "round_start", `Раунд ${roundNumber}: запускаю collect…`);
  const rTask = await atEmitCb(adminAT.hostSock, "host-task-update", { roomCode, roundNumber, task: taskText }, 8000);
  if(!rTask?.ok) throw new Error("E_TASK_UPDATE:" + (rTask?.error || ""));
  await atDelay(250);

  // Send memes (one per bot)
  atPush("info", "send_memes", "Боты отправляют мемы…");
  const plan = atBotPlan();
  // Build payloads in parallel (video can be async)
  const payloads = await Promise.all(plan.map(p=>p.make()));
  for(let i=0;i<adminAT.botMeta.length;i++){
    const bot = adminAT.botMeta[i];
    const payload = payloads[i] || { url: atSvgDataUrl("BOT"), caption: "BOT" };
    const rr = await atEmitCb(bot.socket, "player-send-meme", { roomCode, url: payload.url, caption: `${payload.caption} · r${roundNumber}` }, 12000);
    if(!rr?.ok) throw new Error("E_SEND_MEME_" + bot.nick + ":" + (rr?.error || ""));
  }
  await atDelay(350);
  const snapAfterMemes = await atSnapshotRoom();
  atPush("ok", "send_memes", `Мемы отправлены: ${adminAT.botMeta.length}`, snapAfterMemes);

  // Start voting (может запуститься автоматически, когда все отправили мемы)
  atPush("info", "start_vote", "Запускаю vote…");
  if(String(snapAfterMemes?.phase) === "vote"){
    atPush("ok", "start_vote", "Vote уже запущен автоматически", snapAfterMemes);
  } else {
    const rv = await atEmitCb(adminAT.hostSock, "host-start-vote", { roomCode }, 8000);
    if(!rv?.ok && rv?.errorCode !== "E_WRONG_PHASE") throw new Error("E_START_VOTE:" + (rv?.error || ""));
    await atDelay(300);
  }

  // Get memes list
  const roomSnapVote = await atSnapshotRoom();
  const memes = Array.isArray(roomSnapVote?.memes) ? roomSnapVote.memes : (adminAT.votingMemes || []);
  if(!memes || !memes.length){
    atPush("warn", "vote", "Не вижу список мемов (но продолжаю).", roomSnapVote);
  }

  // Bots vote (not for their own)
  atPush("info", "vote", "Боты голосуют…");
  for(const bot of adminAT.botMeta){
    const choices = (memes || []).filter(m => String(m.ownerId) !== String(bot.playerId));
    if(!choices.length) continue;
    const pick = choices[Math.floor(Math.random() * choices.length)];
    const rr = await atEmitCb(bot.socket, "player-vote", { roomCode, memeId: pick.id }, 8000);
    if(!rr?.ok) throw new Error("E_VOTE_" + bot.nick + ":" + (rr?.error || ""));
  }
  await atDelay(300);
  const snapAfterVote = await atSnapshotRoom();
  atPush("ok", "vote", "Голоса отправлены", snapAfterVote);

  // Update scores from server state
  const memesAfter = Array.isArray(snapAfterVote?.memes) ? snapAfterVote.memes : [];
  const roundScores = atComputeRoundScores(memesAfter);
  for(const [nick, pts] of Object.entries(roundScores)){
    totalScores[nick] = (totalScores[nick] || 0) + pts;
  }
  atPush("ok", "round_score", `Счёт раунда посчитан (игроков: ${Object.keys(roundScores).length})`);
}

async function atFinishGame(totalScores){
  atEnsureNotCancelled();
  const roomCode = adminAT.roomCode;
  const results = Object.entries(totalScores).map(([nickname, score])=>({ nickname, score }))
    .sort((a,b)=>b.score-a.score);

  atPush("info", "final", "Завершаю игру…");
  const r = await atEmitCb(adminAT.hostSock, "host-final-results", { roomCode, results }, 8000);
  if(!r?.ok) throw new Error("E_FINAL:" + (r?.error || ""));
  await atDelay(300);
  const snap = await atSnapshotRoom();
  atPush("ok", "final", `Игра завершена. Результатов: ${results.length}`, snap);
  return results;
}

async function atRunAuto(){
  if(!adminState.authed){
    atSetStatus("Сначала войди в админку.");
    return;
  }
  if(adminAT.running) return;

  adminAT.running = true;
  adminAT.cancelled = false;
  adminAT.mode = "auto";
  adminAT.stepIndex = 0;
  adminAT.history = [];
  adminAT.report = null;
  adminAT.votingMemes = null;
  adminAT.finalResults = null;
  adminAT.latestStatus = null;
  atSetRoom("");
  atRender();

  const started = Date.now();
  try{
    atSetStatus("Автотест запущен…");
    atDisconnectAll();

    const rounds = Math.max(1, Math.min(5, Number($("admin-at-rounds")?.value || 1)));
    const roomCode = await atCreateRoom();
    await atAddBots();

    const tasks = await atGenerateTasks(rounds);

    const totalScores = {};
    for(let r=1;r<=rounds;r++){
      await atPlayRound(r, tasks[r-1] || `Тест‑задание #${r}`, totalScores);
    }
    const results = await atFinishGame(totalScores);

    const overview = await adminApi("/api/admin/overview");
    const events = Array.isArray(overview?.events) ? overview.events.filter(e => JSON.stringify(e.detail||{}).includes(roomCode)) : [];
    const tookMs = Date.now() - started;

    adminAT.report = {
      ok: true,
      mode: "auto",
      roomCode,
      rounds,
      bots: adminAT.botMeta.map(b=>({ nick: b.nick, kind: b.kind })),
      results,
      tookMs,
      serverEvents: events.slice(0, 80),
    };
    atSetStatus("✅ Готово. См. отчёт ниже.");
    atPush("ok", "done", `Автотест завершён за ${tookMs} ms`);
  }catch(e){
    const tookMs = Date.now() - started;
    const msg = String(e?.message || e);
    adminAT.report = {
      ok: false,
      mode: "auto",
      roomCode: adminAT.roomCode || "",
      rounds: Number($("admin-at-rounds")?.value || 1),
      error: msg,
      tookMs,
    };
    atSetStatus("❌ Ошибка: " + msg);
    atPush("fail", "error", msg, await atSnapshotRoom());
  }finally{
    adminAT.running = false;
    // keep sockets for inspection if not cancelled; but to avoid leaking, disconnect after short delay
    setTimeout(()=>{ try{ atDisconnectAll(); }catch(e){} }, 800);
    atRender();
  }
}

const AT_STEPS = [
  { id:"create_room", name:"Создать комнату", run: async (ctx)=>{ ctx.roomCode = await atCreateRoom(); } },
  { id:"bots", name:"Подключить ботов", run: async ()=>{ await atAddBots(); } },
  { id:"tasks", name:"Сгенерировать задания", run: async (ctx)=>{ ctx.tasks = await atGenerateTasks(ctx.rounds); } },
  { id:"round", name:"Пройти раунды", run: async (ctx)=>{
      ctx.totalScores = ctx.totalScores || {};
      for(let r=1;r<=ctx.rounds;r++){
        await atPlayRound(r, (ctx.tasks && ctx.tasks[r-1]) || `Тест‑задание #${r}`, ctx.totalScores);
      }
    }
  },
  { id:"finish", name:"Завершить игру", run: async (ctx)=>{
      ctx.results = await atFinishGame(ctx.totalScores || {});
    }
  },
  { id:"report", name:"Сформировать отчёт", run: async (ctx)=>{
      const overview = await adminApi("/api/admin/overview");
      const events = Array.isArray(overview?.events) ? overview.events.filter(e => JSON.stringify(e.detail||{}).includes(ctx.roomCode || adminAT.roomCode)) : [];
      adminAT.report = {
        ok: true,
        mode: "step",
        roomCode: ctx.roomCode || adminAT.roomCode,
        rounds: ctx.rounds,
        bots: adminAT.botMeta.map(b=>({ nick:b.nick, kind:b.kind })),
        results: ctx.results || null,
        serverEvents: events.slice(0, 80),
      };
    }
  },
];

const adminATStepCtx = { rounds: 1, roomCode:"", tasks:null, totalScores:null, results:null };

async function atStep(){
  if(!adminState.authed){
    atSetStatus("Сначала войди в админку.");
    return;
  }
  if(adminAT.running) return;

  if(adminAT.stepIndex >= AT_STEPS.length){
    atResetStepButton();
    adminAT.stepIndex = 0;
  }

  if(adminATStepCtx.rounds == null){
    adminATStepCtx.rounds = 1;
  }
  adminATStepCtx.rounds = Math.max(1, Math.min(5, Number($("admin-at-rounds")?.value || 1)));

  // starting fresh if first step or previous finished
  if(adminAT.stepIndex === 0){
    atClear();
    atDisconnectAll();
    adminAT.cancelled = false;
    adminAT.report = null;
    adminATStepCtx.roomCode = "";
    adminATStepCtx.tasks = null;
    adminATStepCtx.totalScores = {};
    adminATStepCtx.results = null;
  }

  adminAT.running = true;
  adminAT.mode = "step";
  atRender();

  try{
    atSetStatus(`Шаг ${adminAT.stepIndex+1}/${AT_STEPS.length}…`);
    const step = AT_STEPS[adminAT.stepIndex];
    if(!step){
      atSetStatus("Пошаговый тест завершён.");
      adminAT.running = false;
      atRender();
      return;
    }
    atPush("info", "step", `${adminAT.stepIndex+1}. ${step.name}`);

    await step.run(adminATStepCtx);

    if(step.id === "create_room"){
      atSetRoom(adminATStepCtx.roomCode);
    }

    const snap = await atSnapshotRoom();
    atPush("ok", "step_done", `${step.name} — OK`, snap);

    adminAT.stepIndex++;
    const done = adminAT.stepIndex >= AT_STEPS.length;
    $("admin-at-step").textContent = done ? "✅ Готово" : "⏭ Следующий этап";
    atSetStatus(done ? "✅ Пошаговый тест завершён." : "Готово. Нажми «Следующий этап».");
  }catch(e){
    const msg = String(e?.message || e);
    atSetStatus("❌ Ошибка: " + msg);
    atPush("fail", "step_error", msg, await atSnapshotRoom());
  }finally{
    adminAT.running = false;
    atRender();
  }
}

function atResetStepButton(){
  const btn = $("admin-at-step");
  if(btn) btn.textContent = "⏭ Пошаговый тест";
  adminAT.stepIndex = 0;
}

// ===== End Admin Autotest =====


// Wire up admin UI
(function initAdminUI(){
  const tokenInput = $("admin-token");
  if(tokenInput) tokenInput.value = adminState.token || "";
  $("admin-login")?.addEventListener("click", adminLogin);
  $("admin-logout")?.addEventListener("click", adminLogout);
  $("admin-back")?.addEventListener("click", () => { adminStopPolling(); showScreen("mode"); });
  document.querySelectorAll("#screen-admin .tabbtn").forEach(btn=>{
    btn.addEventListener("click", () => adminSetTab(btn.getAttribute("data-tab")));
  });
  $("admin-refresh-rooms")?.addEventListener("click", () => adminRefresh().catch(()=>{}));
  $("admin-room-close")?.addEventListener("click", adminCloseRoom);
  $("admin-room-overlay")?.addEventListener("click", (e)=>{ if(e.target?.id==="admin-room-overlay") adminCloseRoom(); });
  // Errors modal
  $("admin-errors-close")?.addEventListener("click", adminCloseErrorsModal);
  $("admin-errors-modal")?.addEventListener("click", (e)=>{ if(e.target?.id==="admin-errors-modal") adminCloseErrorsModal(); });
  $("admin-errors-copy")?.addEventListener("click", adminCopyErrorsJson);
  $("admin-sb-generate")?.addEventListener("click", adminSandboxGenerate);
  $("admin-sb-reset")?.addEventListener("click", adminSandboxReset);
  $("admin-rt-add-bots")?.addEventListener("click", adminRtAddBots);
  $("admin-rt-fill-memes")?.addEventListener("click", adminRtFillMemes);
  $("admin-rt-reveal")?.addEventListener("click", adminRtReveal);
  $("admin-rt-force-vote")?.addEventListener("click", adminRtForceVote);
  $("admin-rt-auto-vote")?.addEventListener("click", adminRtAutoVote);
  $("admin-rt-reset-round")?.addEventListener("click", adminRtResetRound);
  // Autotest
  $("admin-at-run")?.addEventListener("click", atRunAuto);
  $("admin-at-step")?.addEventListener("click", atStep);
  $("admin-at-cancel")?.addEventListener("click", atCancel);
  $("admin-at-copy")?.addEventListener("click", atCopyReport);
  $("admin-at-clear")?.addEventListener("click", ()=>{ atClear(); atResetStepButton(); });


  $("admin-log-filter")?.addEventListener("input", adminRenderLogFiltered);
  $("admin-copy-events")?.addEventListener("click", async ()=>{
    try{
      const data = adminState.last?.events || [];
      await navigator.clipboard.writeText(JSON.stringify(data, null, 2));
      adminSetStatus("Скопировано");
    }catch(e){ adminSetStatus("Не получилось скопировать"); }
  });

  atRender();

  // Auto-login when opening admin screen if token exists
  const origShowScreen = showScreen;
  showScreen = function(name){
    origShowScreen(name);
    if(name === "admin"){
      if(adminState.token && !adminState.authed) adminLogin().catch(()=>{});
      if(adminState.authed) adminStartPolling();
    }else{
      adminStopPolling();
    }
  };
})();


function hostSetupInit(){
  // rounds input <-> slider sync
  const num = $("host-total-rounds");
  const rng = $("host-total-rounds-range");
  if (num && rng){
    const clamp = (v)=> Math.max(1, Math.min(20, Number(v||5)));
    const apply = ()=>{
      const v = clamp(num.value);
      num.value = String(v);
      rng.value = String(v);
      try{ aiUpdateCounters(); }catch(e){}
      try{ aiRenderThemeChips(); }catch(e){}
    };
    num.addEventListener("input", apply);
    rng.addEventListener("input", ()=>{
      num.value = String(clamp(rng.value));
      num.dispatchEvent(new Event("input", { bubbles: true }));
    });
    apply();
  }

  // AI themes browse panel
  const browseBtn = $("ai-browse-btn");
  const panel = $("ai-browse-panel");
  const chev = $("ai-browse-chev");
  browseBtn?.addEventListener("click", ()=>{
    if(!panel) return;
    const open = panel.classList.contains("hidden");
    panel.classList.toggle("hidden");
    if(chev) chev.classList.toggle("open", !panel.classList.contains("hidden"));
    if(!panel.classList.contains("hidden")){
      $("ai-theme-search")?.focus();
      aiApplyThemeFilter();
    }
  });
  $("ai-theme-search")?.addEventListener("input", ()=> aiApplyThemeFilter());

  // [ANCHOR] MB:F:AI:EDGE_LEVEL — edgeLevel (0..4), where 0 = 0+ (family), 4 = максимально тёмно (без запрещённого)
  const edge = $("ai-edge");
  const edgeVal = $("ai-edge-val");

  const edgeLabel = (n)=>{
    const v = Math.max(0, Math.min(4, Number(n||0)));
    const labels = [
      "0 · 0+ (family)",
      "1 · мягко",
      "2 · умеренно",
      "3 · тёмно",
      "4 · максимально тёмно (без запрещённого)",
    ];
    return labels[v] || String(v);
  };

  const updEdgeLabel = ()=>{
    if(edgeVal && edge) edgeVal.textContent = edgeLabel(edge.value);
  };

  if(edge){
    // init from stored state (aiInit already restored aiState.edgeLevel)
    const initV = Math.max(0, Math.min(4, Number(edge.value || 2)));
    edge.value = String(initV);
    updEdgeLabel();

    edge.addEventListener("input", ()=>{
      updEdgeLabel();
      // keep aiState in sync
      try{ aiState.edgeLevel = Number(edge.value || 0); }catch(e){}
      try{ aiPersist(); }catch(e){}
    });
  }

// Custom tasks list UI (writes into hidden #host-tasks textarea)
  const input = $("setup-custom-input");
  const addBtn = $("setup-custom-add");
  const list = $("setup-custom-list");
  const tasksArea = $("host-tasks");
  let tasks = [];

  const readTasks = ()=>{
    const raw = String(tasksArea?.value || "");
    tasks = raw.split(/\r?\n/).map(s=>s.trim()).filter(Boolean);
  };
  const writeTasks = ()=>{
    if(tasksArea) tasksArea.value = tasks.join("\n");
  };
  const render = ()=>{
    if(!list) return;
    list.innerHTML = "";
    tasks.forEach((t, i)=>{
      const row = document.createElement("div");
      row.className = "customItem";
      const txt = document.createElement("div");
      txt.className = "customText";
      txt.textContent = t;
      const del = document.createElement("button");
      del.className = "customDel";
      del.type = "button";
      del.title = "Remove";
      del.textContent = "×";
      del.addEventListener("click", ()=>{
        tasks.splice(i, 1);
        writeTasks();
        render();
      });
      row.appendChild(txt);
      row.appendChild(del);
      list.appendChild(row);
    });
  };
  const refresh = ()=>{ readTasks(); render(); };

  refresh();

  const enableAdd = ()=>{
    const v = String(input?.value || "").trim();
    if(addBtn) addBtn.disabled = !v;
  };
  enableAdd();
  input?.addEventListener("input", enableAdd);
  input?.addEventListener("keydown", (e)=>{
    if(e.key === "Enter" && !e.shiftKey){
      e.preventDefault();
      if(!addBtn?.disabled) addBtn.click();
    }
  });
  addBtn?.addEventListener("click", ()=>{
    const v = String(input?.value || "").trim();
    if(!v) return;
    tasks.push(v);
    input.value = "";
    enableAdd();
    writeTasks();
    render();
  });

  // sync if AI writes into textarea (legacy)
  $("ai-to-textarea")?.addEventListener("click", ()=> setTimeout(refresh, 50));
}

aiInit();

// Setup screen wiring (sliders, theme browser, custom tasks list)
try{ hostSetupInit(); }catch(e){ pushDebug("hostSetupInit:error", String(e?.message || e)); }

// Start on mode screen
showScreen("mode");
