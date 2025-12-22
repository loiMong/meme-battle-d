/* Meme Battle фронт (анонимность мемов на экране хоста до reveal/голосования) */

const SERVER_URL = window.location.origin;

// TikTok calibration video (used in Admin mode preview)
const CALIBRATION_TIKTOK_URL = "https://www.tiktok.com/@prokendol112/video/7508817190636752146?is_from_webapp=1&sender_device=pc&web_id=7584888569203066390";

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
const DEFAULT_PLAYER_CARD = { cardWidthPx: 520, cardHeightPx: 520, cropBottomPx: 60, anchorY: "top" };

function normalizePlayerCard(pc){
  const o = pc || {};
  const cardWidthPx = Math.max(240, Math.min(1200, Number(o.cardWidthPx ?? DEFAULT_PLAYER_CARD.cardWidthPx)));
  const cardHeightPx = Math.max(180, Math.min(1200, Number(o.cardHeightPx ?? DEFAULT_PLAYER_CARD.cardHeightPx)));
  const cropBottomPx = Math.max(0, Math.min(400, Number(o.cropBottomPx ?? DEFAULT_PLAYER_CARD.cropBottomPx)));
  const anchorY = ["top","center","bottom"].includes(String(o.anchorY)) ? String(o.anchorY) : DEFAULT_PLAYER_CARD.anchorY;
  return { cardWidthPx, cardHeightPx, cropBottomPx, anchorY };
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
    "--ttAnchorTop": top,
    "--ttAnchorTranslateY": ty,

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
  $("cal-apply") && ($("cal-apply").disabled = !code);
  $("cal-reset") && ($("cal-reset").disabled = !code);
  $("cal-preset-desktop") && ($("cal-preset-desktop").disabled = !code);
  $("cal-preset-mobile") && ($("cal-preset-mobile").disabled = !code);
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

// --- Admin mode (player card calibration)
function setAdminVisible(on){
  $("admin-panel")?.classList.toggle("hidden", !on);
}
setAdminVisible(true); // panel exists, but controls disabled until room created

function renderCalibrationPreview(){
  const box = $("cal-preview");
  if(!box) return;
  // Render a fixed TikTok video so the host can tune height/anchor/crop
  box.innerHTML = renderMediaHTML(CALIBRATION_TIKTOK_URL);
}

$("cal-open-video")?.addEventListener("click", () => {
  try{ window.open(CALIBRATION_TIKTOK_URL, "_blank", "noopener"); }catch(e){}
});

function fillAdminFrom(pc){
  const p = normalizePlayerCard(pc || DEFAULT_PLAYER_CARD);
  if ($("cal-card-w")) $("cal-card-w").value = String(p.cardWidthPx);
  if ($("cal-card-wv")) $("cal-card-wv").textContent = String(p.cardWidthPx);
  if ($("cal-card-h")) $("cal-card-h").value = String(p.cardHeightPx);
  if ($("cal-card-hv")) $("cal-card-hv").textContent = String(p.cardHeightPx);
  if ($("cal-crop-b")) $("cal-crop-b").value = String(p.cropBottomPx);
  if ($("cal-crop-bv")) $("cal-crop-bv").textContent = String(p.cropBottomPx);
  if ($("cal-anchor-y")) $("cal-anchor-y").value = p.anchorY;
}

function readAdminCalib(){
  const cardWidthPx = Number($("cal-card-w")?.value || DEFAULT_PLAYER_CARD.cardWidthPx);
  const cardHeightPx = Number($("cal-card-h")?.value || DEFAULT_PLAYER_CARD.cardHeightPx);
  const cropBottomPx = Number($("cal-crop-b")?.value || DEFAULT_PLAYER_CARD.cropBottomPx);
  const anchorY = String($("cal-anchor-y")?.value || DEFAULT_PLAYER_CARD.anchorY);
  return normalizePlayerCard({ cardWidthPx, cardHeightPx, cropBottomPx, anchorY });
}

function emitPlayerCard(pc, reason=""){
  if(!currentRoom) return;
  const p = normalizePlayerCard(pc);
  // apply locally immediately for host preview
  applyPlayerCardVars(p, "host:"+reason);
  saveLocalPlayerCard(p);

  socket.emit("host-playercard-update", { roomCode: currentRoom, playerCard: p }, (res)=>{
    pushDebug("host-playercard-update", res);
    if(!res?.ok) alert(res?.error || "Ошибка калибровки");
  });
}

["cal-card-w","cal-card-h","cal-crop-b"].forEach(id=>{
  $(id)?.addEventListener("input", () => {
    if (id==="cal-card-w") $("cal-card-wv").textContent = String($("cal-card-w").value);
    if (id==="cal-card-h") $("cal-card-hv").textContent = String($("cal-card-h").value);
    if (id==="cal-crop-b") $("cal-crop-bv").textContent = String($("cal-crop-b").value);
  });
});

$("cal-apply")?.addEventListener("click", () => emitPlayerCard(readAdminCalib(), "apply"));
$("cal-reset")?.addEventListener("click", () => {
  const def = { ...DEFAULT_PLAYER_CARD };
  fillAdminFrom(def);
  emitPlayerCard(def, "reset");
});

$("cal-preset-desktop")?.addEventListener("click", () => {
  const preset = { cardWidthPx: 520, cardHeightPx: 520, cropBottomPx: 60, anchorY: "top" };
  fillAdminFrom(preset);
  emitPlayerCard(preset, "preset:desktop");
});
$("cal-preset-mobile")?.addEventListener("click", () => {
  const preset = { cardWidthPx: 360, cardHeightPx: 420, cropBottomPx: 70, anchorY: "top" };
  fillAdminFrom(preset);
  emitPlayerCard(preset, "preset:mobile");
});

// Load local calibration on startup (host preview even before room)
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

  // Apply player card calibration coming from server (host sets it)
  if(st?.playerCard){
    try{ applyPlayerCardVars(st.playerCard, "room-status"); }catch(e){}
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

// Start on mode screen
showScreen("mode");
