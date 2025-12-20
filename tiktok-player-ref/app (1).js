const $ = (id) => document.getElementById(id);

// ===== existing UI =====
const urlInput = $("url");
const btn = $("btn");

const out = $("out");
const copyBtn = $("copy");

const openFinal = $("openFinal");
const openEmbed = $("openEmbed");

const player = $("player");
const playerWrap = $("playerWrap");
const meta = $("meta");

// ===== tuning UI =====
const videoOnly = $("videoOnly");

const deviceProfile = $("deviceProfile");
const crop = $("crop");
const cropVal = $("cropVal");

const cropX = $("cropX");
const cropXVal = $("cropXVal");

const scale = $("scale");
const scaleVal = $("scaleVal");

const shiftX = $("shiftX");
const shiftXVal = $("shiftXVal");

const shiftY = $("shiftY");
const shiftYVal = $("shiftYVal");

const resetProfileBtn = $("resetProfile");
const copyTuningBtn = $("copyTuning");
const activeProfileHint = $("activeProfileHint");

// Injected style tag for per-device variables
let tuningStyleEl = document.getElementById("tuningStyle");
if (!tuningStyleEl) {
  tuningStyleEl = document.createElement("style");
  tuningStyleEl.id = "tuningStyle";
  document.head.appendChild(tuningStyleEl);
}

const STORAGE_KEY = "tt_tuning_v1";
const DEFAULTS = {"mobilePortrait": {"cropBottom": 0, "cropX": 0, "scale": 1.0, "shiftX": 0, "shiftY": 0}, "mobileLandscape": {"cropBottom": 0, "cropX": 0, "scale": 1.0, "shiftX": 0, "shiftY": 0}, "desktop": {"cropBottom": 0, "cropX": 10, "scale": 1.18, "shiftX": 0, "shiftY": -2}};

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function loadTuning() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return structuredClone(DEFAULTS);
    const parsed = JSON.parse(raw);
    // merge defaults
    const merged = structuredClone(DEFAULTS);
    for (const k of Object.keys(merged)) {
      if (parsed && parsed[k]) {
        merged[k] = { ...merged[k], ...parsed[k] };
      }
    }
    return merged;
  } catch {
    return structuredClone(DEFAULTS);
  }
}

function saveTuning(tuning) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(tuning));
  } catch {}
}

let tuning = loadTuning();

const Q_MP = "(max-width: 899px) and (orientation: portrait)";
const Q_ML = "(max-width: 899px) and (orientation: landscape)";
const Q_DESK = "(min-width: 900px)";

function activeProfileKey() {
  if (window.matchMedia(Q_DESK).matches) return "desktop";
  if (window.matchMedia(Q_ML).matches) return "mobileLandscape";
  return "mobilePortrait";
}

function px(n) {
  const v = Number(n) || 0;
  return `${v}px`;
}

function buildWrapVars(p) {
  const cropXpx = clamp(Number(p.cropX) || 0, 0, 200);
  const cropX2 = cropXpx * 2;
  const scaleVal = clamp(Number(p.scale) || 1, 0.8, 2.0);
  const sx = clamp(Number(p.shiftX) || 0, -200, 200);
  const sy = clamp(Number(p.shiftY) || 0, -200, 200);
  const cropBottom = clamp(Number(p.cropBottom) || 0, 0, 600);

  return {
    "--tt-crop-x": px(cropXpx),
    "--tt-crop-x2": px(cropX2),
    "--tt-scale": String(scaleVal),
    "--tt-shift-x": px(sx),
    "--tt-shift-y": px(sy),
    "--crop": px(cropBottom),
  };
}

function applyTuningCSS() {
  const mp = buildWrapVars(tuning.mobilePortrait);
  const ml = buildWrapVars(tuning.mobileLandscape);
  const desk = buildWrapVars(tuning.desktop);

  const block = (vars) => Object.entries(vars).map(([k,v]) => `    ${k}: ${v};`).join("\n");

  tuningStyleEl.textContent = `
@media ${Q_MP} {
  .playerWrap {
${block(mp)}
  }
}
@media ${Q_ML} {
  .playerWrap {
${block(ml)}
  }
}
@media ${Q_DESK} {
  .playerWrap {
${block(desk)}
  }
}
`.trim();
}

function updateHint() {
  const active = activeProfileKey();
  const edit = deviceProfile?.value || active;
  const p = tuning[active];
  const info = `Активный: ${active} | редактируешь: ${edit} | бок: ${p.cropX}px | zoom: ${p.scale} | x: ${p.shiftX}px | y: ${p.shiftY}px | низ: ${p.cropBottom}px`;
  if (activeProfileHint) activeProfileHint.textContent = info;
  if (meta) meta.textContent = info;
}

function setSlidersFromProfile(key) {
  const p = tuning[key];
  if (!p) return;

  crop.value = String(p.cropBottom ?? 0);
  cropVal.textContent = String(p.cropBottom ?? 0);

  cropX.value = String(p.cropX ?? 0);
  cropXVal.textContent = String(p.cropX ?? 0);

  scale.value = String((p.scale ?? 1).toFixed(2));
  scaleVal.textContent = String((p.scale ?? 1).toFixed(2));

  shiftX.value = String(p.shiftX ?? 0);
  shiftXVal.textContent = String(p.shiftX ?? 0);

  shiftY.value = String(p.shiftY ?? 0);
  shiftYVal.textContent = String(p.shiftY ?? 0);
}

function commitSlidersToProfile(key) {
  const p = tuning[key];
  if (!p) return;

  p.cropBottom = Number(crop.value) || 0;
  p.cropX = Number(cropX.value) || 0;
  p.scale = Number(scale.value) || 1;
  p.shiftX = Number(shiftX.value) || 0;
  p.shiftY = Number(shiftY.value) || 0;

  saveTuning(tuning);
  applyTuningCSS();
  updateHint();
}

function applyVideoOnlyUI() {
  playerWrap.classList.toggle("videoOnly", Boolean(videoOnly?.checked));
}

// ===== link + player =====
function setLink(el, url) {
  if (!url) {
    el.href = "#";
    el.setAttribute("aria-disabled", "true");
    el.classList.add("disabled");
    return;
  }
  el.href = url;
  el.removeAttribute("aria-disabled");
  el.classList.remove("disabled");
}

function setPlayer(embedUrl) {
  if (!embedUrl) {
    player.src = "";
    playerWrap.classList.add("empty");
    return;
  }
  player.src = embedUrl;
  playerWrap.classList.remove("empty");
}

// ===== resolve =====
let lastJson = null;

async function convert() {
  const url = String(urlInput.value || "").trim();
  if (!url) {
    out.textContent = "Вставь ссылку на TikTok.";
    meta.textContent = "—";
    return;
  }

  out.textContent = "Конвертирую…";
  copyBtn.disabled = true;
  lastJson = null;
  setLink(openFinal, null);
  setLink(openEmbed, null);
  setPlayer(null);

  try {
    const r = await fetch(`/api/resolve?url=${encodeURIComponent(url)}`);
    const j = await r.json();
    lastJson = j;
    out.textContent = JSON.stringify(j, null, 2);
    copyBtn.disabled = !j?.ok;

    setLink(openFinal, j?.finalUrl || null);
    setLink(openEmbed, j?.embedUrl || null);
    setPlayer(j?.embedUrl || null);

    applyVideoOnlyUI();
    applyTuningCSS();
    updateHint();
  } catch (e) {
    out.textContent = "Ошибка запроса к серверу.";
  }
}

btn.addEventListener("click", convert);
urlInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") convert();
});

urlInput.addEventListener("paste", () => {
  setTimeout(() => {
    const u = String(urlInput.value || "").trim();
    if (u) convert();
  }, 10);
});

copyBtn.addEventListener("click", async () => {
  if (!lastJson) return;
  try {
    await navigator.clipboard.writeText(JSON.stringify(lastJson, null, 2));
    copyBtn.textContent = "Скопировано ✅";
    setTimeout(() => (copyBtn.textContent = "Копировать JSON"), 1200);
  } catch {
    alert("Не получилось скопировать. Выдели и скопируй вручную.");
  }
});

// ===== tuning events =====
if (deviceProfile) {
  // default: pick active profile on this device
  deviceProfile.value = activeProfileKey();
  setSlidersFromProfile(deviceProfile.value);

  deviceProfile.addEventListener("change", () => {
    setSlidersFromProfile(deviceProfile.value);
    updateHint();
  });
}

videoOnly?.addEventListener("change", () => {
  applyVideoOnlyUI();
});

const onAnySlider = () => {
  // update readouts live
  cropVal.textContent = String(crop.value);
  cropXVal.textContent = String(cropX.value);
  scaleVal.textContent = Number(scale.value).toFixed(2);
  shiftXVal.textContent = String(shiftX.value);
  shiftYVal.textContent = String(shiftY.value);

  // commit to selected profile
  const key = deviceProfile?.value || activeProfileKey();
  commitSlidersToProfile(key);
};

[crop, cropX, scale, shiftX, shiftY].forEach((el) => {
  el?.addEventListener("input", onAnySlider);
});

resetProfileBtn?.addEventListener("click", () => {
  const key = deviceProfile?.value || activeProfileKey();
  tuning[key] = structuredClone(DEFAULTS[key]);
  saveTuning(tuning);
  setSlidersFromProfile(key);
  applyTuningCSS();
  updateHint();
});

copyTuningBtn?.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(JSON.stringify(tuning, null, 2));
    copyTuningBtn.textContent = "Скопировано ✅";
    setTimeout(() => (copyTuningBtn.textContent = "Скопировать настройки"), 1200);
  } catch {
    alert("Не получилось скопировать. Выдели и скопируй вручную.");
  }
});

// update hint on resize/orientation change
window.addEventListener("resize", () => {
  applyTuningCSS();
  updateHint();
});

// init
applyVideoOnlyUI();
applyTuningCSS();
updateHint();
