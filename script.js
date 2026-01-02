/* Meme Battle фронт (анонимность мемов на экране хоста до reveal/голосования) */

const SERVER_URL = window.location.origin;

// TikTok calibration video (used in Admin mode preview)
const CALIBRATION_TIKTOK_URL = "https://www.tiktok.com/@prokendol112/video/7508817190636752146?is_from_webapp=1&sender_device=pc&web_id=7584888569203066390";

// === AI tasks presets ===
const AI_PRESET_THEMES = [
  "Аниме", "Фильмы", "Сериалы", "Видеоигры", "Комиксы/супергерои",
  "Работа/офис", "Учёба/универ", "Отношения", "Свидания", "Друзья",
  "Семья", "Питомцы", "Еда", "Кофе/энергетики", "Спорт/зал",
  "ЗОЖ/диеты", "Сон", "Утро/понедельник", "Праздники", "Путешествия",
  "Транспорт", "Быт/дом", "Шопинг", "Деньги", "Технологии",
  "Телефоны/гаджеты", "Интернет/соцсети", "Геймерская боль", "Неловкие ситуации", "Фейлы",
  "Успех/мотивация", "Прокрастинация", "Баги/глюки", "Кринж", "Сарказм",
  "Абсурд", "Чёрный юмор", "Хоррор", "Фантастика", "Мистика",
  "История/школа", "Музыка", "Концерты/тусовки", "Мода/стиль", "Погода",
  "Кулинария", "Ностальгия", "Жизнь в Чехии", "Я и мои планы", "Внутренний диалог"
];

let aiState = {
  enabled: false,
  humorLevel: 3,
  selectedThemes: [],
  customThemes: [],
  lastGenerated: [],
  lastUsage: null,
  lastModel: null,
};

const $ = (id) => document.getElementById(id);

// Small helper for +/- buttons around range inputs
function nudgeRange(id, delta, min, max){
  const el = $(id);
  if(!el) return;
  const cur = Number(el.value);
  const next = Math.max(min, Math.min(max, cur + delta));
  el.value = String(next);
  el.dispatchEvent(new Event("input", { bubbles:true }));
}



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

// ===== Debug log store (so you can copy diagnostics) =====
const DBG_MAX = 400;
window.__MB_DBG = window.__MB_DBG || [];

function pushDebug(tag, detail){
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
  return {
    env,
    logs: Array.isArray(window.__MB_DBG) ? window.__MB_DBG.slice(0, DBG_MAX) : []
  };
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
$("debug-clear")?.addEventListener("click", () => clearDebug());

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

// -------- Screen switching
const screens = ["mode","host","player","admin"].reduce((acc,k)=>{
  acc[k] = $(`screen-${k}`);
  return acc;
}, {});
function showScreen(name){
  Object.entries(screens).forEach(([k,el])=>{
    if(!el) return;
    el.classList.toggle("hidden", k !== name);
  });
  // Settings button only after selecting role
  const sb = $("settings-toggle");
  if(sb) sb.classList.toggle("hidden", name === "mode");
  if(name === "mode") { try{ setSettings(false); }catch(e){} }
  pushDebug("screen", name);
}
$("btn-mode-host")?.addEventListener("click", () => showScreen("host"));
$("btn-mode-player")?.addEventListener("click", () => showScreen("player"));
$("btn-mode-admin")?.addEventListener("click", () => showScreen("admin"));

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
  setPill("admin-conn", true);

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
  setPill("admin-conn", false);
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

  // QR
  const qrData = encodeURIComponent(link);
  const qrSrc = `https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=${qrData}`;
  const img = $("host-qr-img");
  const imgBig = $("qr-overlay-img");
  if (img) img.src = qrSrc;
  if (imgBig) imgBig.src = `https://api.qrserver.com/v1/create-qr-code/?size=520x520&data=${qrData}`;
  const mini = $("host-room-code-mini");
  if (mini) mini.textContent = code || "—";

  const fullBtn = $("host-qr-full");
  if (fullBtn) fullBtn.disabled = !code;
}
$("host-copy-link")?.addEventListener("click", async () => {
  const link = $("host-room-link").textContent || "";
  try{ await navigator.clipboard.writeText(link); pushDebug("copy", "ok"); }catch(e){ pushDebug("copy", String(e)); }
});

// --- QR overlay
$("host-qr-full")?.addEventListener("click", () => {
  const link = $("host-room-link")?.textContent || "";
  $("qr-overlay-link").textContent = link || "—";
  $("qr-overlay").classList.remove("hidden");
});
$("qr-close")?.addEventListener("click", () => $("qr-overlay").classList.add("hidden"));
$("qr-overlay")?.addEventListener("click", (e) => {
  if (e.target && e.target.id === "qr-overlay") $("qr-overlay").classList.add("hidden");
});
$("qr-copy")?.addEventListener("click", async () => {
  const link = $("host-room-link")?.textContent || "";
  try{ await navigator.clipboard.writeText(link); pushDebug("qr:copy", "ok"); }catch(e){ pushDebug("qr:copy", String(e)); }
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
    });

    box.appendChild(chip);
  }

  aiUpdateCounters();
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
    humorLevel: Number($("ai-level")?.value || 3),
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
      aiState.humorLevel = Number(saved.humorLevel || 3);
      aiState.selectedThemes = Array.isArray(saved.selectedThemes) ? saved.selectedThemes : [];
      aiState.customThemes = Array.isArray(saved.customThemes) ? saved.customThemes : [];
    }
  }catch(e){}

  $("ai-enabled").checked = !!aiState.enabled;
  $("ai-level") && ($("ai-level").value = String(aiState.humorLevel || 3));

  aiSetEnabledUI(!!aiState.enabled);
  aiRenderThemeChips();
  aiUpdateCounters();

  // events
  $("ai-enabled").addEventListener("change", ()=>{
    aiState.enabled = !!$("ai-enabled").checked;
    aiSetEnabledUI(aiState.enabled);
    aiPersist();
  });

  $("ai-level")?.addEventListener("change", ()=>{
    aiState.humorLevel = Number($("ai-level").value || 3);
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
        humorLevel: aiState.humorLevel,
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
  aiState.humorLevel = Number($("ai-level")?.value || 3);

  // If we already generated tasks for current settings, use them (fallback is manual tasks)
  if(aiState.enabled && Array.isArray(aiState.lastGenerated) && aiState.lastGenerated.length){
    hostState.tasks = aiState.lastGenerated.slice(0, hostState.totalRounds);
  }
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

$("host-start-game")?.addEventListener("click", async () => {
  if(!ensureRoom()) return;
  parseTasks();

  // If AI is enabled: generate (or reuse) tasks before starting the game.
  if(aiState.enabled){
    const r = await aiGenerateTasks(false);
    if(r?.ok){
      aiState.lastGenerated = r.tasks || [];
      hostState.tasks = (r.tasks || []).slice(0, hostState.totalRounds);
    }
  }

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
const pr = $("player-room");
if (pr) pr.value = (urlRoom || localStorage.getItem(LS_ROOM) || "").toUpperCase();
const pn = $("player-nick");
if (pn) pn.value = (localStorage.getItem(LS_NICK) || "");
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
  pushDebug("player:send:input", {
    roomCode: playerState.roomCode,
    hasFile: Boolean(file),
    file: file ? { name: file.name, type: file.type, size: file.size } : null,
    rawUrl: dbgValueShort($("player-meme-url")?.value || "")
  });
  if(file){
    if(file.size > 8 * 1024 * 1024){ alert("Файл слишком большой. Лимит ~8MB."); return; }
    url = await fileToDataUrl(file);
    pushDebug("player:send:file_read", dbgValueShort(url));
  }else{
    url = String($("player-meme-url").value || "").trim();
    const normalized = await normalizeVideoLink(url);
    pushDebug("player:send:normalized", { in: url, out: normalized.url || url, meta: normalized });
    url = normalized.url || url;
  }
  const caption = String($("player-meme-caption").value || "").trim();
  pushDebug("player:send:emit", { roomCode: playerState.roomCode, url: dbgValueShort(url), captionLen: caption.length });
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

    // Re-apply per-device TikTok box vars after re-render (new iframes)
    try{ applyPlayerCardVars(loadLocalPlayerCard()||DEFAULT_PLAYER_CARD, "host:memes-render"); }catch(e){}
    try{ applyTTVars("host:memes-render"); }catch(e){}

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

  // Legacy: keep TT transforms neutral
  try{ applyTTVars("room-status"); }catch(e){}
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

    // Apply TT vars after rendering the voting grid
    try{ applyPlayerCardVars(loadLocalPlayerCard()||DEFAULT_PLAYER_CARD, "voting-started"); }catch(e){}
    try{ applyTTVars("voting-started"); }catch(e){}
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



// -------- App version (visible)
async function loadAppVersion(){
  try{
    const r = await fetch("/api/version", { cache:"no-store" });
    const j = await r.json();
    if(j && j.version && $("app-version")) $("app-version").textContent = j.version;
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
      humorLevel: 3,
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

  // Start voting
  atPush("info", "start_vote", "Запускаю vote…");
  const rv = await atEmitCb(adminAT.hostSock, "host-start-vote", { roomCode }, 8000);
  if(!rv?.ok) throw new Error("E_START_VOTE:" + (rv?.error || ""));
  await atDelay(300);

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


aiInit();

// Start on mode screen
showScreen("mode");
