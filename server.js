/**
 * Meme Battle server (single-folder)
 * - Serves static front from same folder
 * - Socket.IO realtime room state
 * - Host anonymity: memes are not sent in room-status during collect until revealed
 */

/* =====================================================================
   [MB-ANCHORS] Server.js quick map (поиск по файлу)
   - [ANCHOR] MB:S:CONFIG
   - [ANCHOR] MB:S:ADMIN_LOG
   - [ANCHOR] MB:S:HTTP_ROUTES
   - [ANCHOR] MB:S:ROOM_STORE
   - [ANCHOR] MB:S:ROOM_HELPERS
   - [ANCHOR] MB:S:VOTING_CORE
   - [ANCHOR] MB:S:TIMERS
   - [ANCHOR] MB:S:OPENAI_TASKS
   - [ANCHOR] MB:S:SOCKET_IO
   - [ANCHOR] MB:S:SOCKET:HOST_*
   - [ANCHOR] MB:S:SOCKET:PLAYER_*
   - [ANCHOR] MB:S:ADMIN_API
   ===================================================================== */

const path = require("path");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const crypto = require("crypto");


// [ANCHOR] MB:S:CONFIG — env + defaults
// IMPORTANT: Replit workflow in .replit waits for localPort=5000.
// If we bind to 3000, the app can look "stuck" (server is running but Replit doesn't open the webview).
// Use MB_PORT to override manually when needed.
const PORT = Number(process.env.MB_PORT || 5000);

const ROUND_SECONDS_DEFAULT = Number(process.env.ROUND_SECONDS || 120);
const VOTE_SECONDS_DEFAULT = Number(process.env.VOTE_SECONDS || 30);

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || process.env.OPENAI_KEY || "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
// Replit can be a bit slow on first cold start; keep a generous timeout.
const OPENAI_TIMEOUT_MS = Number(process.env.OPENAI_TIMEOUT_MS || 25000);


// [ANCHOR] MB:S:VERSION
const APP_VERSION = process.env.APP_VERSION || "0.1.20-beta";
const ADMIN_TOKEN = String(process.env.ADMIN_TOKEN || "dev").trim(); // ⚠️ поменяй в Secrets/ENV

const STARTED_AT = Date.now();


// [ANCHOR] MB:S:DEBUG_TOGGLE — global + per-room debug timeline
// MB_DEBUG=0 disables verbose room debug (timeline + timer-debug emits). Admin API logging still works.
const DEBUG = !["0","false","off","no"].includes(String(process.env.MB_DEBUG || "1").toLowerCase());
const DEBUG_TIMELINE_MAX = Number(process.env.MB_DEBUG_TIMELINE_MAX || 300);


// [ANCHOR] MB:S:ADMIN_LOG — counters + ring buffer
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
// [ANCHOR] MB:S:AI_STATS — aggregated stats by category + edgeLevel
const aiStats = {
  totalRequests: 0,
  totalTasks: 0,
  byCategoryEdge: {}, // { [category]: { [edgeLevel]: { tasks:number, requests:number } } }
};
function bumpAiStats(category, edgeLevel, tasksN = 1){
  const cat = String(category || "general").trim() || "general";
  const e = clampInt(edgeLevel, 0, 4, 0);
  if(!aiStats.byCategoryEdge[cat]) aiStats.byCategoryEdge[cat] = {};
  if(!aiStats.byCategoryEdge[cat][e]) aiStats.byCategoryEdge[cat][e] = { tasks: 0, requests: 0 };
  aiStats.byCategoryEdge[cat][e].tasks += Math.max(0, Number(tasksN) || 0);
}
function bumpAiRequestStats(categories, edgeLevelMax, tasksCount){
  aiStats.totalRequests += 1;
  aiStats.totalTasks += Math.max(0, Number(tasksCount) || 0);
  const cats = Array.isArray(categories) ? categories : [];
  const seen = new Set();
  for(const c of cats.map(x=>String(x||"").trim()).filter(Boolean)){
    if(seen.has(c.toLowerCase())) continue;
    seen.add(c.toLowerCase());
    const cat = c;
    const max = clampInt(edgeLevelMax, 0, 4, 0);
    if(!aiStats.byCategoryEdge[cat]) aiStats.byCategoryEdge[cat] = {};
    if(!aiStats.byCategoryEdge[cat][max]) aiStats.byCategoryEdge[cat][max] = { tasks: 0, requests: 0 };
    aiStats.byCategoryEdge[cat][max].requests += 1;
  }
}


// [ANCHOR] MB:S:ADMIN_LOG:HELPERS
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

function clampInt(n, min, max, fallback=min){
  n = Number(n);
  if(!Number.isFinite(n)) n = fallback;
  n = Math.trunc(n);
  return Math.max(min, Math.min(max, n));
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


// [ANCHOR] MB:S:OPENAI_TASKS — per-topic generation + parsing/validation + caching
const AI_GENERATOR_VERSION = "topics_v1";

// [ANCHOR] MB:S:AI_TOPIC_CONFIG — per-topic prompt modifiers (extend freely)
const TOPIC_CONFIGS = (() => {
  // Keyed by normalized lowercase topic name
  const m = Object.create(null);

  function add(name, cfg){
    m[String(name||"").trim().toLowerCase()] = { ...(cfg||{}) };
  }

  add("news mode", {
    tags: ["news_mode"],
    promptAddendum: "Пиши как новостной дайджест/заголовок: упор на свежие события, инфоповоды, реакцию аудитории. Без реальных имен и брендов.",
    formatWeights: { situation: 0.55, dialogue: 0.12, unfinished: 0.13, social: 0.1, twist: 0.1 },
  });
  add("новости", {
    tags: ["news_mode"],
    promptAddendum: "Новостной вайб: инфоповоды, заголовки, репортажные формулировки. Ситуации для реакции. Без реальных имен и брендов.",
    formatWeights: { situation: 0.55, dialogue: 0.12, unfinished: 0.13, social: 0.1, twist: 0.1 },
  });

  // Mature topic placeholder: will be gated by ageConfirm.
  add("18+ mature", {
    tags: ["mature"],
    requiresMature: true,
    promptAddendum: "Допускаются мат/нижепояс/секс‑термины/политика ТОЛЬКО если ageConfirm=true. И всё равно без запрещённого: без порнографии, без ненависти к защищённым группам, без призывов к насилию.",
    // Slightly higher chance of twist/social
    formatWeights: { situation: 0.5, dialogue: 0.12, unfinished: 0.12, social: 0.13, twist: 0.13 },
  });
  add("18+", {
    tags: ["mature"],
    requiresMature: true,
    promptAddendum: "Допускаются мат и «нижепояс» ТОЛЬКО если ageConfirm=true. Без порнографии, ненависти, графического насилия.",
    formatWeights: { situation: 0.5, dialogue: 0.12, unfinished: 0.12, social: 0.13, twist: 0.13 },
  });

  return m;
})();

function getTopicConfig(topic){
  const key = String(topic||"").trim().toLowerCase();
  return TOPIC_CONFIGS[key] || { tags: [], promptAddendum: "", formatWeights: null, edgePolicy: null, requiresMature: false };
}

// [ANCHOR] MB:S:AI_TOPIC_CACHE — in-memory cache per topic
const aiTopicCache = Object.create(null);
/*
  key: `${topic}||${mode}||${difficulty}||${lang}||${AI_GENERATOR_VERSION}||${edgeLevelMax}||${ageConfirm?1:0}||${tags}`
  val: { ts, tasks: [...] }
*/
function makeAiTopicCacheKey({ topic, mode, difficulty, lang, edgeLevelMax, ageConfirm, tags }){
  const t = cleanOneLine(topic).toLowerCase();
  const m = cleanOneLine(mode || "default").toLowerCase();
  const d = cleanOneLine(difficulty || `edge${clampInt(edgeLevelMax,0,4,0)}`).toLowerCase();
  const l = cleanOneLine(lang || "ru").toLowerCase();
  const e = clampInt(edgeLevelMax, 0, 4, 0);
  const a = ageConfirm ? 1 : 0;
  const tg = Array.isArray(tags) ? tags.map(x=>String(x||"").trim().toLowerCase()).filter(Boolean).sort().join(",") : "";
  return `${t}||${m}||${d}||${l}||${AI_GENERATOR_VERSION}||${e}||${a}||${tg}`;
}
function getCachedTopicTasks(key){
  const hit = aiTopicCache[key];
  if(!hit) return null;
  // Soft TTL: 6 hours
  const ttlMs = 6 * 60 * 60 * 1000;
  if(hit.ts && (Date.now() - hit.ts) > ttlMs) return null;
  return Array.isArray(hit.tasks) ? hit.tasks.slice() : null;
}
function setCachedTopicTasks(key, tasks){
  aiTopicCache[key] = { ts: Date.now(), tasks: Array.isArray(tasks) ? tasks.slice() : [] };
}

// Weighted choice helper
function weightedPick(mapObj, fallbackKey){
  const entries = Object.entries(mapObj || {}).filter(([,v])=> Number(v) > 0);
  if(!entries.length) return fallbackKey;
  const sum = entries.reduce((a,[,v])=>a+Number(v),0);
  let r = Math.random() * sum;
  for(const [k,v] of entries){
    r -= Number(v);
    if(r <= 0) return k;
  }
  return entries[entries.length-1][0];
}
function normalizeFormatType(x){
  const s = String(x||"").trim().toLowerCase();
  if(s === "situation" || s === "dialogue" || s === "unfinished" || s === "social" || s === "twist") return s;
  // tolerate minor variants
  if(s.startsWith("situ")) return "situation";
  if(s.startsWith("dial")) return "dialogue";
  if(s.startsWith("unfin") || s.startsWith("incomp") || s.startsWith("finish")) return "unfinished";
  if(s.startsWith("soc")) return "social";
  if(s.startsWith("tw")) return "twist";
  return "situation";
}function getEdgeMixWeights(maxEdge){
  const x = clampInt(maxEdge, 0, 4, 0);
  // IMPORTANT: edgeLevelMax is a ceiling; we still want a MIX 0..x,
  // but with noticeably stronger bite near x (and a mandatory soft share).
  if(x <= 0) return { 0: 1 };
  if(x === 1) return { 1: 0.55, 0: 0.45 };
  if(x === 2) return { 2: 0.55, 1: 0.25, 0: 0.20 };
  if(x === 3) return { 3: 0.55, 2: 0.25, 1: 0.12, 0: 0.08 };
  return { 4: 0.55, 3: 0.25, 2: 0.12, 1: 0.06, 0: 0.02 };
}

function edgeStyleRubricText(){
  // Keep short enough for prompts, but explicit so the difference between levels is FELT.
  // NOTE: 18+ is a separate mode; level 4 is still "no prohibited content".
  return [
    "Шкала edgeLevel (0..4):",
    "0: 0+ family — мило/добро, без жести, без токсичности.",
    "1: лёгкая подколка — мягкая ирония, неловкость, но без унижения.",
    "2: колко — кринж, пассивная агрессия, «ой‑ой», но без жестокости.",
    "3: жёстко — сарказм, «прожарка», мрачновато, социальные табу (без хейта и без насилия).",
    "4: максимально тёмно (НЕ 18+) — ruthless/беспощадно, экзистенциальная тоска, стыд, абсурдная безнадёга, но НЕЛЬЗЯ: ненависть к защищённым группам, слуры, призывы к насилию, графическое насилие, порнография."
  ].join("\n");
}

function rebalanceEdgeLevels(tasks, want, maxEdge){
  const list = Array.isArray(tasks) ? tasks.slice() : [];
  const x = clampInt(maxEdge, 0, 4, 0);
  if(list.length < 4 || want <= 0) return list;

  const w = getEdgeMixWeights(x);
  const desired = [];
  const n = Math.min(want, list.length);
  for(let i=0;i<n;i++){
    desired.push(Number(weightedPick(w, String(x))) || 0);
  }

  // Ensure a soft share when x>0
  if(x > 0 && n >= 6){
    desired[0] = 0;
    desired[1] = Math.min(1, x);
  }

  const buckets = { 0:[], 1:[], 2:[], 3:[], 4:[] };
  for(const t of list){
    const e = clampInt(t?.edgeLevel ?? 0, 0, 4, 0);
    if(e <= x) buckets[e].push(t);
  }
  for(const k of Object.keys(buckets)) buckets[k] = shuffle(buckets[k]);

  const out = [];
  for(const eWant of shuffle(desired)){
    const e = clampInt(eWant, 0, x, 0);
    let pick = null;

    for(let ee=e; ee>=0; ee--){
      if(buckets[ee] && buckets[ee].length){ pick = buckets[ee].shift(); break; }
    }
    if(!pick){
      for(let ee=x; ee>=0; ee--){
        if(buckets[ee] && buckets[ee].length){ pick = buckets[ee].shift(); break; }
      }
    }
    if(pick) out.push(pick);
    if(out.length >= want) break;
  }

  for(let ee=0; ee<=4; ee++) out.push(...buckets[ee]);

  return out;
}



// [ANCHOR] MB:S:OPENAI_TASKS — main entry used by socket handler
async function openaiGenerateTasks({ themes, rounds, edgeLevelMax, lang = "ru", mode = "default", difficulty = "", ageConfirm = false }){
  if(!OPENAI_API_KEY) throw new Error("E_NO_OPENAI_KEY");

  const safeThemes = (themes || []).map(cleanOneLine).filter(Boolean).slice(0, 50);
  const totalRounds = clampInt(rounds, 1, 60, 5);
  const maxEdge = clampInt(edgeLevelMax, 0, 4, 0);

  // Allocate counts per topic (roughly equal / proportional)
  const perTopicCounts = Object.create(null);
  const tN = safeThemes.length || 1;
  const base = Math.floor(totalRounds / tN);
  let rem = totalRounds - base * tN;
  for(const t of safeThemes){
    perTopicCounts[t] = base + (rem > 0 ? 1 : 0);
    if(rem > 0) rem--;
  }

  // Generate separately per topic
  const byTopic = Object.create(null);
  for(const topic of safeThemes){
    const need = clampInt(perTopicCounts[topic] || 0, 0, 200, 0);
    const cfg = getTopicConfig(topic);

    // Mature gate: if requiresMature but not confirmed, we keep it safe and cap edge.
    const effectiveMaxEdge = (!ageConfirm && cfg.requiresMature) ? Math.min(maxEdge, 2) : maxEdge;

    const cacheKey = makeAiTopicCacheKey({
      topic,
      mode,
      difficulty,
      lang,
      edgeLevelMax: effectiveMaxEdge,
      ageConfirm,
      tags: cfg.tags
    });

    let topicTasks = getCachedTopicTasks(cacheKey);
    if(!topicTasks){
      topicTasks = await openaiGenerateTopicTasks({
        topic,
        count: Math.max(need + 4, need), // extra for filtering/anti-repeat
        lang,
        mode,
        difficulty,
        edgeLevelMax: effectiveMaxEdge,
        cfg,
        ageConfirm
      });
      setCachedTopicTasks(cacheKey, topicTasks);
    }

    // Trim and keep per-topic pool
    byTopic[topic] = topicTasks.slice(0, Math.max(need + 2, need));
  }

  // Build final list: round-robin by topics + anti-repeat
  const final = buildFinalTasksRoundRobin({
    byTopic,
    themes: safeThemes,
    totalRounds,
    maxEdge
  });

  const usage = null; // aggregated usage is hard without extra bookkeeping; keep null
  return { tasks: final, byTopic, usage, model: OPENAI_MODEL, generatorVersion: AI_GENERATOR_VERSION };
}

// [ANCHOR] MB:S:OPENAI_TASKS:TOPIC — OpenAI call per topic (reaction-based, with formats)
async function openaiGenerateTopicTasks({ topic, count, lang, mode, difficulty, edgeLevelMax, cfg, ageConfirm }){
  const want = clampInt(count, 1, 120, 12);
  const maxEdge = clampInt(edgeLevelMax, 0, 4, 0);

  const formatWeights = cfg?.formatWeights || { situation: 0.6, dialogue: 0.1, unfinished: 0.1, social: 0.1, twist: 0.1 };

  const system = [
    "Ты — генератор коротких реакционных заданий для игры «Мем‑баттл».",
    "Формат: это СИТУАЦИЯ/СЦЕНА для реакции мемом/гифкой, а не инструкция «сделай/напиши/объясни».",
    "Каждое задание — ОДНО предложение без переносов строк, без списков, без нумерации.",
    "Запрещено: реальные имена людей, конкретные бренды, призывы к незаконному, травля/ненависть к защищённым группам, графическое насилие, порнография.",
    "Допустимо: ирония, сарказм, чёрный юмор без таргета по защищённым группам. Всегда оставайся в рамках edgeLevelMax.",
    "Не копируй известные карточки/шутки дословно — только оригинальные идеи."
  ].join(" ");

  const add = cleanOneLine(cfg?.promptAddendum || "");
  const user = [
    `Язык: ${cleanOneLine(lang || "ru")}.`,
    `Тема: ${cleanOneLine(topic)} (это primaryTopic по умолчанию).`,
    `Сгенерируй ${want} уникальных реакционных заданий под мем/гиф.`,
    `Тон: edgeLevel (0..4) не выше edgeLevelMax=${maxEdge}. edgeLevelMax — это максимум, внутри набора сделай микс 0..edgeLevelMax.`,
`Важно: разница между уровнями должна ощущаться заметно. Для edgeLevelMax=${maxEdge} делай задачи ближе к верхней границе (но с обязательной долей мягких).`,
`Желаемое распределение edgeLevel: ${JSON.stringify(getEdgeMixWeights(maxEdge))}.`,
`Правила по шкале:
${edgeStyleRubricText()}`,
    `Разнообразие форматов: formatType строго один из [situation, dialogue, unfinished, social, twist]. Желаемые веса: ${JSON.stringify(formatWeights)}.`,
    `Слияние тем избегай: по умолчанию задачи ТОЛЬКО про primaryTopic. Разрешены редкие отсылки к другой теме (secondaryTopics) не чаще ~10% задач, где primaryTopic остаётся главным.`,
    add ? `Модификатор темы: ${add}` : "",
    (!ageConfirm && cfg?.requiresMature) ? "Важно: ageConfirm=false, поэтому НЕ используй мат, секс-термины, политику — держи это как обычную безопасную тему." : "",
    `Верни только JSON по схеме ниже. Текст должен помещаться в CHAR_LIMIT=140.`,
  ].filter(Boolean).join("\n");

  const schema = {
    type: "object",
    additionalProperties: false,
    properties: {
      topic: { type: "string" },
      tasks: {
        type: "array",
        minItems: want,
        maxItems: want,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            text: { type: "string" },
            primaryTopic: { type: "string" },
            secondaryTopics: { type: "array", minItems: 0, maxItems: 2, items: { type: "string" } },
            category: { type: "string" },
            formatType: { type: "string", enum: ["situation","dialogue","unfinished","social","twist"] },
            edgeLevel: { type: "integer", minimum: 0, maximum: 4 }
          },
          required: ["text","primaryTopic","secondaryTopics","category","formatType","edgeLevel"]
        }
      }
    },
    required: ["topic","tasks"]
  };

  const body = {
    model: OPENAI_MODEL,
    input: [
      { role: "system", content: system },
      { role: "user", content: user }
    ],
    temperature: 0.9,
    max_output_tokens: 1100,
    store: false,
    text: {
      format: {
        type: "json_schema",
        name: "topic_tasks",
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
    // Fallback: JSON mode
    if(String(e?.message || "").startsWith("E_OPENAI_HTTP_400")){
      const body2 = JSON.parse(JSON.stringify(body));
      body2.text = { format: { type: "json_object" } };
      body2.input[0].content = system + " IMPORTANT: respond with a single JSON object only.";
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
  const rawList = Array.isArray(parsed?.tasks) ? parsed.tasks : [];
  tasks = rawList.map((x)=>{
    const text = (x && typeof x.text === "string") ? x.text : "";
    const primaryTopic = cleanOneLine((x && x.primaryTopic) ? x.primaryTopic : topic) || topic;
    const secondaryTopics = (x && Array.isArray(x.secondaryTopics)) ? x.secondaryTopics.map(cleanOneLine).filter(Boolean).slice(0,2) : [];
    const category = cleanOneLine((x && x.category) ? x.category : primaryTopic) || topic;
    const formatType = normalizeFormatType(x && x.formatType);
    const edgeLevel = clampInt((x && x.edgeLevel != null) ? x.edgeLevel : 0, 0, 4, 0);
    return { text, primaryTopic, secondaryTopics, category, formatType, edgeLevel };
  });

  // Normalize + enforce limits
  tasks = tasks.map(t => ({
    ...t,
    text: cutOneSentence(t.text, 140),
    primaryTopic: cleanOneLine(t.primaryTopic || topic) || topic,
    secondaryTopics: Array.isArray(t.secondaryTopics) ? t.secondaryTopics.map(cleanOneLine).filter(Boolean).slice(0,2) : [],
    category: cleanOneLine(t.category || topic) || topic,
    formatType: normalizeFormatType(t.formatType),
    edgeLevel: clampInt(t.edgeLevel, 0, 4, 0),
  })).filter(t => t.text);

  // Hard constraint: edgeLevel <= max
  tasks = tasks.filter(t => Number(t.edgeLevel) <= maxEdge);

  // Keep cross-topic to max ~10%
  const crossMax = Math.max(0, Math.floor(want * 0.1));
  let crossCount = 0;
  tasks = tasks.filter(t => {
    const hasCross = Array.isArray(t.secondaryTopics) && t.secondaryTopics.length;
    if(!hasCross) return true;
    crossCount++;
    return crossCount <= crossMax;
  });

  // De-dup by text
  const seen = new Set();
  tasks = tasks.filter(t => {
    const k = String(t.text).toLowerCase();
    if(seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  // If too few, add safe fallbacks
  if(tasks.length < Math.min(want, 6)){
    const fb = fallbackTasks([topic], Math.min(8, want - tasks.length)).map((s)=>({
      text: cutOneSentence(s, 140),
      primaryTopic: topic,
      secondaryTopics: [],
      category: topic,
      formatType: "situation",
      edgeLevel: 0,
    }));
    tasks = tasks.concat(fb);
  }

  // Shuffle and ensure at least some variation in format types
  tasks = shuffle(tasks);

  // Enforce "no more than 2 same formatType in a row" within topic list
  tasks = applyAntiRepeat(tasks, { maxSameTypeRun: 2, maxSameTopicRun: 99 });

  // If model ignores formatType distribution, lightly re-balance by sampling desired types
  tasks = rebalanceFormatTypes(tasks, want, formatWeights);
  tasks = rebalanceEdgeLevels(tasks, want, maxEdge);

  return tasks.slice(0, want);
}

// [ANCHOR] MB:S:OPENAI_TASKS:ASSEMBLY — round-robin + anti-repeat across topics
function buildFinalTasksRoundRobin({ byTopic, themes, totalRounds, maxEdge }){
  const topics = Array.isArray(themes) && themes.length ? themes.slice() : Object.keys(byTopic||{});
  const pools = Object.create(null);
  for(const t of topics){
    pools[t] = Array.isArray(byTopic?.[t]) ? byTopic[t].slice() : [];
  }

  // Round-robin base order
  const out = [];
  let guard = 0;
  let idx = 0;

  while(out.length < totalRounds && guard < 5000){
    guard++;
    const topic = topics[idx % topics.length];
    idx++;

    // pick next viable task from this topic considering anti-repeat
    const picked = pickNextFromTopicPool(pools, topic, out, { maxSameTypeRun: 2, maxSameTopicRun: (topics.length>1 ? 2 : 99) });
    if(picked){
      out.push(picked);
    }else{
      // try any other topic
      let any = null;
      for(const t2 of topics){
        any = pickNextFromTopicPool(pools, t2, out, { maxSameTypeRun: 2, maxSameTopicRun: (topics.length>1 ? 2 : 99) });
        if(any) break;
      }
      if(any) out.push(any);
      else break; // nothing left
    }
  }

  // Final shuffle with anti-repeat, but keep topic alternation mostly stable:
  // We do a light shuffle inside windows to avoid "pachki"
  const window = Math.min(6, out.length);
  if(window >= 4){
    const mixed = [];
    for(let i=0;i<out.length;i+=window){
      const chunk = out.slice(i, i+window);
      mixed.push(...shuffle(chunk));
    }
    const cleaned = applyAntiRepeat(mixed, { maxSameTypeRun: 2, maxSameTopicRun: (topics.length>1 ? 2 : 99) });
    return cleaned.slice(0, totalRounds);
  }

  return applyAntiRepeat(out, { maxSameTypeRun: 2, maxSameTopicRun: (topics.length>1 ? 2 : 99) }).slice(0, totalRounds);
}

function pickNextFromTopicPool(pools, topic, currentList, rules){
  const pool = pools[topic];
  if(!pool || !pool.length) return null;

  // Try a few candidates to satisfy anti-repeat
  const tries = Math.min(10, pool.length);
  for(let i=0;i<tries;i++){
    const cand = pool.shift(); // rotate
    if(!cand) continue;

    const ok = checkAntiRepeatCandidate(currentList, cand, rules);
    if(ok){
      cand.primaryTopic = cand.primaryTopic || topic;
      cand.category = cand.category || topic;
      cand.edgeLevel = clampInt(cand.edgeLevel ?? 0, 0, 4, 0);
      cand.formatType = normalizeFormatType(cand.formatType);
      return cand;
    }

    // Put back to end
    pool.push(cand);
  }

  // As fallback pick first
  const cand = pool.shift();
  if(!cand) return null;
  cand.primaryTopic = cand.primaryTopic || topic;
  cand.category = cand.category || topic;
  cand.edgeLevel = clampInt(cand.edgeLevel ?? 0, 0, 4, 0);
  cand.formatType = normalizeFormatType(cand.formatType);
  return cand;
}

function checkAntiRepeatCandidate(list, cand, rules){
  const maxSameTypeRun = clampInt(rules?.maxSameTypeRun ?? 2, 1, 10, 2);
  const maxSameTopicRun = clampInt(rules?.maxSameTopicRun ?? 2, 1, 20, 2);

  const t = normalizeFormatType(cand?.formatType);
  const topic = cleanOneLine(cand?.primaryTopic || cand?.category || "");

  // check formatType run
  let runType = 0;
  for(let i=list.length-1;i>=0;i--){
    if(normalizeFormatType(list[i]?.formatType) === t) runType++;
    else break;
  }
  if(runType >= maxSameTypeRun) return false;

  // check topic run
  if(topic){
    let runTopic = 0;
    for(let i=list.length-1;i>=0;i--){
      const pt = cleanOneLine(list[i]?.primaryTopic || list[i]?.category || "");
      if(pt && pt === topic) runTopic++;
      else break;
    }
    if(runTopic >= maxSameTopicRun) return false;
  }

  return true;
}

function applyAntiRepeat(list, rules){
  const arr = Array.isArray(list) ? list.slice() : [];
  if(arr.length < 3) return arr;

  const out = [];
  for(const item of arr){
    if(checkAntiRepeatCandidate(out, item, rules)){
      out.push(item);
      continue;
    }
    // Try to swap with a future item
    let swapped = false;
    for(let j=0;j<Math.min(10, arr.length); j++){
      const next = arr.shift();
      if(!next) break;
      if(checkAntiRepeatCandidate(out, next, rules)){
        out.push(next);
        arr.push(item);
        swapped = true;
        break;
      }
      arr.push(next);
    }
    if(!swapped) out.push(item);
  }
  return out;
}

function rebalanceFormatTypes(tasks, want, weights){
  const list = Array.isArray(tasks) ? tasks.slice() : [];
  if(list.length < 5) return list;

  const desired = [];
  const w = weights || { situation: 0.6, dialogue: 0.1, unfinished: 0.1, social: 0.1, twist: 0.1 };
  for(let i=0;i<Math.min(want, list.length); i++){
    desired.push(weightedPick(w, "situation"));
  }
  // Ensure at least one non-situation if possible
  if(desired.every(x=>x==="situation") && desired.length >= 6){
    desired[Math.floor(desired.length/2)] = "twist";
  }

  // Group by type
  const buckets = { situation: [], dialogue: [], unfinished: [], social: [], twist: [] };
  for(const t of list){
    const ft = normalizeFormatType(t.formatType);
    buckets[ft].push(t);
  }
  for(const k of Object.keys(buckets)) buckets[k] = shuffle(buckets[k]);

  const out = [];
  for(const ft of shuffle(desired)){
    const pick =
      (buckets[ft] && buckets[ft].length) ? buckets[ft].shift() :
      (buckets.situation.length ? buckets.situation.shift() :
        (buckets.twist.length ? buckets.twist.shift() :
          (buckets.dialogue.length ? buckets.dialogue.shift() :
            (buckets.unfinished.length ? buckets.unfinished.shift() :
              (buckets.social.length ? buckets.social.shift() : null)))));
    if(pick) out.push(pick);
    if(out.length >= want) break;
  }
  // Append leftovers
  for(const k of Object.keys(buckets)){
    out.push(...buckets[k]);
  }
  return out;
}

// === END AI TASKS ===

// Prevent aggressive mobile caching (especially for script/style updates)
app.use(express.static(path.join(__dirname, "."), {
  setHeaders(res, filePath){
    try{
      // No-store for html/css/js to ensure fast rollout; keep it simple.
      if(/\.(?:html|css|js)$/i.test(String(filePath||""))){
        res.setHeader("Cache-Control", "no-store");
      }
    }catch(e){}
  }
}));

// [ANCHOR] MB:S:HTTP_ROUTES
app.get("/health", (req, res) => res.json({ ok: true, ts: new Date().toISOString(), version: APP_VERSION, adminTokenConfigured: ADMIN_TOKEN !== "dev" }));
app.get("/api/version", (req, res) => res.json({ ok:true, version: APP_VERSION }));
app.get("/join/:code", (req,res)=> res.sendFile(path.join(__dirname, "index.html")));
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

function randomToken(bytes = 16){
  try{ return crypto.randomBytes(bytes).toString('hex'); }catch(e){ return String(Math.random()).slice(2) + String(Date.now()); }
}


// [ANCHOR] MB:S:ROOM_STORE — in-memory state
const rooms = Object.create(null);

// [ANCHOR] MB:S:HOST_GRACE — keep room alive for a short grace period if host disconnects (to allow rejoin)
const HOST_GRACE_MS = (()=>{
  const v = Number(process.env.HOST_GRACE_MS || 120000);
  return Number.isFinite(v) ? Math.max(5000, Math.min(v, 30 * 60 * 1000)) : 120000;
})();


// [ANCHOR] MB:S:ROOM_HELPERS
function createRoom(hostId) {
  let code = randomCode();
  while (rooms[code]) code = randomCode();
  rooms[code] = {
    code,
    hostId,
    hostConnected: true,
    hostDisconnectedAt: 0,
    hostCleanupTimer: null,
    hostToken: randomToken(16),
    phase: "lobby",      // lobby -> collect -> vote -> finished
    roundNumber: 0,
    task: "",
    locked: false,       // block new nicknames when game started
    memesRevealed: false,
    voteComplete: false,
    collectSeconds: ROUND_SECONDS_DEFAULT,
    voteSeconds: VOTE_SECONDS_DEFAULT,
    collectEndsAt: 0,
    voteEndsAt: 0,
    timers: { collect: null, vote: null },
    playersById: Object.create(null),
    nickIndex: Object.create(null),
    socketToPlayerId: Object.create(null),
    memes: [],           // {id,url,caption,ownerId,nickname,votes}
    // room-level debug (controlled by host via debug toggle)
    debugEnabled: false,
    debugTimeline: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  return code;
}
function getRoom(code) {
  const c = String(code || "").trim().toUpperCase();
  return rooms[c] || null;
}

// [ANCHOR] MB:S:DEBUG_ZIP_HTTP — server-side ZIP download (works even when browser blocks async downloads)
function safeStringify(obj){
  const seen = new WeakSet();
  return JSON.stringify(obj, (k, v) => {
    if (typeof v === "bigint") return String(v);
    if (typeof v === "function") return `[Function ${v.name || "anon"}]`;
    if (v && typeof v === "object") {
      if (seen.has(v)) return "[Circular]";
      seen.add(v);
    }
    return v;
  }, 2);
}

// Minimal ZIP (STORE) for Node (Buffer-based)
const CRC32_TABLE_NODE = (() => {
  const table = new Uint32Array(256);
  for(let i=0;i<256;i++){
    let c = i;
    for(let k=0;k<8;k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    table[i] = c >>> 0;
  }
  return table;
})();
function crc32Buf(buf){
  let crc = 0 ^ (-1);
  for(let i=0;i<buf.length;i++) crc = (crc >>> 8) ^ CRC32_TABLE_NODE[(crc ^ buf[i]) & 0xFF];
  return (crc ^ (-1)) >>> 0;
}
function b16(n){ const b = Buffer.alloc(2); b.writeUInt16LE(n & 0xFFFF, 0); return b; }
function b32(n){ const b = Buffer.alloc(4); b.writeUInt32LE((n>>>0), 0); return b; }
function zipStoreBuffers(files){
  // files: [{ name: string, data: Buffer }]
  const locals = [];
  const centrals = [];
  let offset = 0;

  for(const f of files){
    const nameBuf = Buffer.from(String(f.name||"file"), "utf8");
    const dataBuf = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data||"");
    const crc = crc32Buf(dataBuf);
    const size = dataBuf.length;

    // Local file header
    const localHeader = Buffer.concat([
      b32(0x04034b50),
      b16(20),
      b16(0),
      b16(0),
      b16(0),
      b16(0),
      b32(crc),
      b32(size),
      b32(size),
      b16(nameBuf.length),
      b16(0),
      nameBuf,
    ]);
    locals.push(localHeader, dataBuf);

    // Central directory file header
    const centralHeader = Buffer.concat([
      b32(0x02014b50),
      b16(20),
      b16(20),
      b16(0),
      b16(0),
      b16(0),
      b16(0),
      b32(crc),
      b32(size),
      b32(size),
      b16(nameBuf.length),
      b16(0),
      b16(0),
      b16(0),
      b16(0),
      b32(0),
      b32(offset),
      nameBuf,
    ]);
    centrals.push(centralHeader);

    offset += localHeader.length + size;
  }

  const centralStart = offset;
  const centralBuf = Buffer.concat(centrals);
  offset += centralBuf.length;
  const centralSize = centralBuf.length;

  const end = Buffer.concat([
    b32(0x06054b50),
    b16(0),
    b16(0),
    b16(files.length),
    b16(files.length),
    b32(centralSize),
    b32(centralStart),
    b16(0),
  ]);

  return Buffer.concat([...locals, centralBuf, end]);
}

function sanitizeTs(ts){
  const s = String(ts || "").trim();
  // allow dd.MM.yy-HH-mm style only
  const ok = /^[0-9]{2}\.[0-9]{2}\.[0-9]{2}-[0-9]{2}-[0-9]{2}$/.test(s);
  return ok ? s : null;
}

app.get("/api/debug-zip", async (req, res) => {
  try{
    const roomCode = String(req.query.room || "").toUpperCase().trim();
    const token = String(req.query.token || "").trim();
    const ts = sanitizeTs(req.query.ts) || null;
    const room = getRoom(roomCode);
    if(!room) return res.status(404).json({ ok:false, error:"E_ROOM_NOT_FOUND", errorText:"Комната не найдена" });
    if(!token || token !== String(room.hostToken || "")) return res.status(403).json({ ok:false, error:"E_NOT_HOST", errorText:"Вы не ведущий" });

    const requestId = `http_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    if(!room.__dbgCollectors) room.__dbgCollectors = Object.create(null);
    room.__dbgCollectors[requestId] = {
      startedAt: Date.now(),
      hostSocketId: room.hostId || null,
      clients: [],
      seenSocketIds: new Set(),
    };

    const roomSetBefore = io.sockets.adapter.rooms.get(room.code) || new Set();
const expectedClients = roomSetBefore.size;
io.to(room.code).emit("debug:snapshot-request", { requestId, roomCode: room.code, via: "http" });

// wait window (give clients time to reply)
await new Promise(r => setTimeout(r, 2500));

const col = room.__dbgCollectors && room.__dbgCollectors[requestId];
if(col) delete room.__dbgCollectors[requestId];

const roomSetAfter = io.sockets.adapter.rooms.get(room.code) || new Set();
const missing = [];
try{
  for(const sid of roomSetAfter){
    if(!(col && col.seenSocketIds && col.seenSocketIds.has(sid))) missing.push(sid);
  }
}catch(e){}
const serverSnapshot = {
      roomCode: room.code,
      serverNow: Date.now(),
      phase: room.phase,
      roundNumber: room.roundNumber,
      debugEnabled: !!room.debugEnabled,
      timeline: Array.isArray(room.debugTimeline) ? room.debugTimeline.slice(0, DEBUG_TIMELINE_MAX) : [],
    };

    const bundle = {
      requestId,
      roomCode: room.code,
      createdAt: new Date().toISOString(),
      serverNow: Date.now(),
      expectedClients,
      missing,
      serverSnapshot,
      clients: (col && Array.isArray(col.clients)) ? col.clients : [],
    };

    const files = [];
    files.push({ name: "manifest.json", data: Buffer.from(safeStringify({
      roomCode: bundle.roomCode,
      requestId: bundle.requestId,
      createdAt: bundle.createdAt,
      serverNow: bundle.serverNow,
      expectedClients: bundle.expectedClients,
      clientsReceived: bundle.clients.length,
      missing: bundle.missing,
      appVersion: APP_VERSION,
    }), "utf8")});

    files.push({ name: "server_snapshot.json", data: Buffer.from(safeStringify(bundle.serverSnapshot), "utf8")});
    files.push({ name: "clients_all.json", data: Buffer.from(safeStringify(bundle.clients), "utf8")});

    // per-client files
    for(const c of (bundle.clients || [])){
      const role = String(c?.role || "client").replace(/[^a-z0-9_-]/gi, "_");
      const sid = String(c?.socketId || "sid").slice(0, 8).replace(/[^a-z0-9]/gi, "");
      const nick = String(c?.nick || "").slice(0, 16).replace(/[^a-z0-9_-]/gi, "_");
      const fname = `client_${role}_${nick || "nonick"}_${sid}.json`;
      files.push({ name: fname, data: Buffer.from(safeStringify(c), "utf8")});
    }

    const zipBuf = zipStoreBuffers(files);
    const fnameTs = ts || (()=>{
      const d = new Date();
      const dd = String(d.getDate()).padStart(2,'0');
      const mm = String(d.getMonth()+1).padStart(2,'0');
      const yy = String(d.getFullYear()).slice(-2);
      const HH = String(d.getHours()).padStart(2,'0');
      const MI = String(d.getMinutes()).padStart(2,'0');
      return `${dd}.${mm}.${yy}-${HH}-${MI}`;
    })();

    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="dbgZ_${fnameTs}.zip"`);
    res.setHeader("Cache-Control", "no-store");
    res.status(200).end(zipBuf);
  }catch(e){
    res.status(500).json({ ok:false, error:"E_DEBUG_ZIP", errorText:"Не удалось собрать ZIP", details: String(e?.message || e) });
  }
});
function playersArray(room) {
  return Object.values(room.playersById).map(p => ({
    id: p.id,
    nickname: p.nickname,
    connected: !!p.connected,
    score: Number(p.score||0),
    hasMeme: !!p.hasMeme,
    hasVoted: !!p.hasVoted,
    missedVote: !!p.missedVote,
    readyNext: !!p.readyNext,
  }));
}
function publicMemes(room) {
  // IMPORTANT: during collect and before reveal — do NOT send memes at all
  if (room.phase === "collect" && !room.memesRevealed) return [];
  return room.memes;
}

// [ANCHOR] MB:S:BROADCAST_TARGETED — build room-status once and emit to specific targets
function buildRoomStatusPayload(room){
  ensureRoomTimers(room);
  try{ ensureTimerMeta(room); }catch(e){}
  const now = Date.now();
  const tCollect = room.timerMeta?.collect || {};
  const tVote = room.timerMeta?.vote || {};

  return {
    roomCode: room.code,
    phase: room.phase,
    roundNumber: room.roundNumber,
    totalRounds: room.totalRounds,
    task: room.task,
    locked: !!room.locked,
    memesRevealed: !!room.memesRevealed,
    voteComplete: !!room.voteComplete,

    // host connectivity (debug/robustness)
    hostConnected: !!room.hostConnected,

    // server-authoritative clocks (helps debug and prevents client drift)
    serverNow: now,
    collectSeconds: room.collectSeconds || null,
    voteSeconds: room.voteSeconds || null,
    collectEndsAt: room.collectEndsAt || 0,
    voteEndsAt: room.voteEndsAt || 0,

    // timer handles/meta (debug only; harmless to clients)
    debugTimers: {
      collectActive: !!room.timers?.collect,
      voteActive: !!room.timers?.vote,
      collectDueAt: tCollect.dueAt || 0,
      voteDueAt: tVote.dueAt || 0,
      collectSetAt: tCollect.setAt || 0,
      voteSetAt: tVote.setAt || 0,
      collectSeq: tCollect.seq || 0,
      voteSeq: tVote.seq || 0,
      lastActionCollect: tCollect.lastAction || "",
      lastActionVote: tVote.lastAction || "",
    },

    memesCount: room.memes.length,
    players: playersArray(room),
    memes: publicMemes(room),
  };
}

function emitRoomStatusTo(room, target){
  try{
    if(!room || !target) return;
    io.to(target).emit("room-status", buildRoomStatusPayload(room));
  }catch(e){}
}

function broadcast(room) {
  emitRoomStatusTo(room, room.code);
}


function broadcastRoomStatus(room){
  // Backward-compatible alias (older code paths)
  broadcast(room);
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

function checkAllVotesReady(room){
  const active = Object.values(room.playersById).filter(p => p.connected);
  if(active.length === 0) return false;
  return active.every(p => p.hasVoted);
}



// === Room Debug Timeline Helpers ===
// Per-room ring buffer timeline. Controlled by host (room.debugEnabled).
function tlPush(room, tag, detail){
  try{
    if(!DEBUG) return;
    if(!room || !room.code) return;
    if(!room.debugEnabled) return;
    if(!Array.isArray(room.debugTimeline)) room.debugTimeline = [];
    const entry = {
      ts: new Date().toISOString(),
      serverNow: Date.now(),
      tag: String(tag || ""),
      phase: room.phase || null,
      roundNumber: Number(room.roundNumber || 0),
      detail: (detail === undefined) ? null : detail,
    };
    room.debugTimeline.unshift(entry);
    if(room.debugTimeline.length > DEBUG_TIMELINE_MAX) room.debugTimeline.length = DEBUG_TIMELINE_MAX;
    io.to(room.code).emit("debug-timeline", entry);
  }catch(e){}
}

function emitDebugState(room){
  try{
    if(!room || !room.code) return;
    io.to(room.code).emit("debug-state", {
      roomCode: room.code,
      debugEnabled: !!room.debugEnabled,
      timelineSize: Array.isArray(room.debugTimeline) ? room.debugTimeline.length : 0,
      serverNow: Date.now(),
    });
  }catch(e){}
}

function emitDebugSnapshot(room, socket){
  try{
    if(!room || !room.code) return;
    const snap = {
      roomCode: room.code,
      debugEnabled: !!room.debugEnabled,
      serverNow: Date.now(),
      timeline: Array.isArray(room.debugTimeline) ? room.debugTimeline.slice(0, DEBUG_TIMELINE_MAX) : [],
    };
    if(socket && socket.id) io.to(socket.id).emit("debug-snapshot", snap);
    else io.to(room.code).emit("debug-snapshot", snap);
  }catch(e){}
}

// === Timer Debug Helpers ===
function emitTimerDebug(room, action, data){
  try{
    if(!DEBUG) return;
    if(!room || !room.code) return;
    if(!room.debugEnabled) return;
    const payload = {
      roomCode: room.code,
      action: String(action || ""),
      serverNow: Date.now(),
      ...((data && typeof data === "object") ? data : { data })
    };
    io.to(room.code).emit("timer-debug", payload);
    tlPush(room, `timer:${String(action||"")}`, payload);
    logAdmin("timer_debug", payload);
  }catch(e){}
}

function ensureTimerMeta(room){
  if(!room) return;
  if(!room.timerMeta || typeof room.timerMeta !== "object") room.timerMeta = {};
  if(!room.timerSeq) room.timerSeq = 0;
  for(const k of ["collect","vote"]){
    if(!room.timerMeta[k] || typeof room.timerMeta[k] !== "object") room.timerMeta[k] = {};
  }
}
// === END Timer Debug Helpers ===

function ensureRoomTimers(room){
  if(!room) return;
  if(!room.timers || typeof room.timers !== "object"){
    room.timers = { collect: null, vote: null };
  }
  if(!("collect" in room.timers)) room.timers.collect = null;
  if(!("vote" in room.timers)) room.timers.vote = null;

  // extra debug state (safe no-op in prod)
  ensureTimerMeta(room);
}



// [ANCHOR] MB:S:TIMERS — schedule/clear per-room timers
function clearRoomTimer(room, key){
  if(!room) return;
  ensureRoomTimers(room);
  const k = String(key || "");
  const t = room.timers[k];
  const had = !!t;
  if(t){
    clearTimeout(t);
    room.timers[k] = null;
  }

  try{
    ensureTimerMeta(room);
    const meta = room.timerMeta[k] || (room.timerMeta[k] = {});
    meta.lastAction = "clear";
    meta.clearedAt = Date.now();
    meta.hadTimer = had;
    emitTimerDebug(room, "timer_clear", { key: k, hadTimer: had });
  }catch(e){}
}


// [ANCHOR] MB:S:TIMERS:CORE
function scheduleRoomTimer(room, key, ms, fn){
  if(!room) return;
  ensureRoomTimers(room);

  const k = String(key || "");
  const delay = Math.max(0, Number(ms)||0);

  clearRoomTimer(room, k);

  try{
    ensureTimerMeta(room);
    const now = Date.now();
    const seq = ++room.timerSeq;
    const meta = room.timerMeta[k] || (room.timerMeta[k] = {});
    meta.lastAction = "schedule";
    meta.setAt = now;
    meta.ms = delay;
    meta.dueAt = now + delay;
    meta.seq = seq;
    emitTimerDebug(room, "timer_schedule", { key: k, ms: delay, dueAt: meta.dueAt, seq });
  }catch(e){}

  room.timers[k] = setTimeout(() => {
    try{ ensureRoomTimers(room); }catch(e){}
    try{
      ensureTimerMeta(room);
      const meta = room.timerMeta[k] || (room.timerMeta[k] = {});
      meta.lastAction = "fire";
      meta.firedAt = Date.now();
      meta.firedSeq = meta.seq;
      emitTimerDebug(room, "timer_fire", { key: k, firedAt: meta.firedAt, dueAt: meta.dueAt || null, seq: meta.seq || null, phase: room.phase, voteComplete: !!room.voteComplete });
    }catch(e){}
    try{ room.timers[k] = null; }catch(e){}
    try{ fn && fn(); }catch(e){ console.error("[timer]", k, e); }
  }, delay);
}



// [ANCHOR] MB:S:VOTING_CORE — scoring + winners + phase transition
function finalizeVoting(room, reason = "timer"){
  if(!room) return;
  if(room.phase !== "vote") return;
  if(room.voteComplete) return;

  clearRoomTimer(room, "vote");

  room.voteComplete = true;
  room.updatedAt = Date.now();

  // Mark missed votes (connected players who didn't vote by the end)
  const players = Object.values(room.playersById || {});
  players.forEach(p => {
    if(!p) return;
    if(p.connected && !p.hasVoted) p.missedVote = true;
  });

  const memes = Array.isArray(room.memes) ? room.memes : [];
  let maxVotes = -Infinity;
  for (const m of memes){
    const v = Number(m?.votes || 0);
    if (Number.isFinite(v) && v > maxVotes) maxVotes = v;
  }
  if(!Number.isFinite(maxVotes)) maxVotes = 0;

  const winnersRaw = memes.length
    ? memes.filter(m => Number(m?.votes || 0) === maxVotes)
    : [];

  const winners = winnersRaw.map(m => ({
    id: m.id,
    memeId: m.id,
    url: m.url || null,
    caption: m.caption || "",
    nickname: m.nickname || "",
    votes: Number(m.votes || 0),
    ownerId: m.ownerId || null,
  }));

  let winner = winners[0] || null;

  const playersOnline = players.filter(p => !!p.connected);
  const votedAny = players.filter(p => !!p.hasVoted);
  const votedOnline = playersOnline.filter(p => !!p.hasVoted);
  const submittedOnline = playersOnline.filter(p => !!p.hasMeme);

  // If nobody voted at all -> explicit "no_votes" (no winner / no tie).
  const baseReason = String(reason || "");
  if(votedAny.length === 0 && baseReason !== "no_players" && baseReason !== "no_memes"){
    reason = "no_votes";
  }
  if(String(reason) === "no_votes"){
    maxVotes = 0;
    winners.length = 0;
    winner = null;
  }

  // [ANCHOR] MB:S:SCORE_APPLY — apply round points to server scores so players see live leaderboard
  // Mirrors client computeRoundPoints(): 10 pts per vote; +20% bonus to unique winner; players who didn't vote get 0.
  let pointsByPlayerId = Object.create(null);
  try{
    const eligibleIds = new Set();
    players.forEach(p => {
      if(p && p.hasVoted && p.id) eligibleIds.add(String(p.id));
    });

    pointsByPlayerId = Object.create(null);

    // Vote points: 10 per vote (only if eligible)
    for(const m of memes){
      const ownerId = (m && m.ownerId) ? String(m.ownerId) : "";
      if(!ownerId) continue;
      if(eligibleIds.size && !eligibleIds.has(ownerId)) continue;

      const votePts = Number(m?.votes || 0) * 10;
      if(!Number.isFinite(votePts)) continue;

      pointsByPlayerId[ownerId] = (pointsByPlayerId[ownerId] || 0) + votePts;
    }

    // +20% bonus to unique winner (only if eligible)
    if(winners.length === 1){
      const w = winners[0];
      const ownerId = (w && w.ownerId) ? String(w.ownerId) : "";
      if(ownerId && (!eligibleIds.size || eligibleIds.has(ownerId))){
        const base = Number(w?.votes || 0) * 10;
        const bonus = Math.round(base * 0.2);
        if(Number.isFinite(bonus) && bonus){
          pointsByPlayerId[ownerId] = (pointsByPlayerId[ownerId] || 0) + bonus;
        }
      }
    }

    // Apply to room state
    Object.entries(pointsByPlayerId).forEach(([pid, pts])=>{
      const pl = room.playersById && room.playersById[pid];
      if(!pl) return;
      pl.score = Number(pl.score || 0) + (Number(pts) || 0);
    });

    room.lastRoundPoints = pointsByPlayerId;
    room.lastRoundScoredRound = room.roundNumber;
    room.updatedAt = Date.now();

    tlPush(room, "score-applied", { roundNumber: room.roundNumber, pointsByPlayerId });
    logAdmin("round_scored", { roomCode: room.code, roundNumber: room.roundNumber, pointsByPlayerId });
  }catch(e){
    tlPush(room, "score-applied:error", { err: String(e?.message || e) });
  }


  // room-status should reflect voteComplete + missedVote before emitting overlay
  broadcast(room);

  io.to(room.code).emit("voting-finished", {
    roomCode: room.code,
    roundNumber: room.roundNumber,
    totalRounds: room.totalRounds,
    winner,
    winners,
    maxVotes,
    players: playersArray(room),
    pointsByPlayerId,
    tie: winners.length > 1,
    displayMs: 0, // Winner screen does NOT auto-close; closes on next round start
    reason,
    stats: {
      playersOnline: playersOnline.length,
      votedOnline: votedOnline.length,
      submittedOnline: submittedOnline.length,
      missedOnline: playersOnline.filter(p => !!p.missedVote).length,
      memes: memes.length,
      voteEndsAt: room.voteEndsAt || 0,
    },
  });

  tlPush(room, "voting-finished", { reason, maxVotes, winners: winners.length, votedAny: votedAny.length, missedOnline: playersOnline.filter(p=>!!p.missedVote).length });
  emitDebugState(room);

  logAdmin("voting_finished", { roomCode: room.code, roundNumber: room.roundNumber,
    totalRounds: room.totalRounds, reason, maxVotes, winners: winners.length, votedOnline: votedOnline.length, memes: memes.length });

  // Auto-advance trigger (host listens), based on mandatory players only.
  maybeEmitAllReadyNext(room);
}



// [ANCHOR] MB:S:TIMERS:VOTE
function clearVoteTimer(room){
  // compatibility wrapper: voting timer is managed via room.timers
  clearRoomTimer(room, "vote");
}

// === Voting timers (single source of truth) ===
const VOTE_GRACE_MS = 250; // allow small jitter (ms)

function inferMemeMeta(m){
  const url = String(m?.url || "");
  const kindIn = String(m?.mediaKind || m?.kind || m?.mediaType || m?.meta?.kind || "").toLowerCase();
  let kind = kindIn;
  let durationSec = Number(m?.durationSec ?? m?.duration ?? m?.meta?.durationSec ?? m?.meta?.duration ?? NaN);
  if(!Number.isFinite(durationSec) || durationSec <= 0) durationSec = null;

  if(!kind){
    if(url.startsWith("data:")){
      const semi = url.indexOf(";");
      const comma = url.indexOf(",");
      const end = semi > 0 ? semi : comma;
      const mime = end > 5 ? url.slice(5, end) : "";
      if(mime.startsWith("image/")){
        kind = mime.includes("gif") ? "gif" : "photo";
      } else if(mime.startsWith("video/")){
        kind = "video";
      } else if(mime.startsWith("audio/")){
        kind = "audio";
      } else {
        kind = "unknown";
      }
    } else {
      const lower = url.toLowerCase();
      if(lower.includes("youtube.com") || lower.includes("youtu.be") || lower.includes("tiktok.com")){
        kind = "video";
      } else if(/\.(mp4|webm|mov|m4v)(\?|#|$)/.test(lower)){
        kind = "video";
      } else if(/\.(mp3|wav|ogg|m4a|aac)(\?|#|$)/.test(lower)){
        kind = "audio";
      } else if(/\.(gif)(\?|#|$)/.test(lower)){
        kind = "gif";
      } else if(/\.(png|jpe?g|webp|bmp|avif)(\?|#|$)/.test(lower)){
        kind = "photo";
      } else {
        kind = "unknown";
      }
    }
  }
  return { kind, durationSec };
}

const VOTE_TIME_DEFAULTS = {
  photo: 10,
  unknown: 15,
  videoFallback: 30,
  audioFallback: 30,
  gifFallback: 8,
  extra: 5,
  cap: 180
};

function computeVoteSecondsFromMemes(memes){
  const list = Array.isArray(memes) ? memes : [];
  let total = 0;
  const parts = [];
  for(const m of list){
    const meta = inferMemeMeta(m);
    let seconds = 0;
    if(meta.kind === "photo"){
      seconds = VOTE_TIME_DEFAULTS.photo;
    } else if(meta.kind === "gif"){
      const d = meta.durationSec ?? VOTE_TIME_DEFAULTS.gifFallback;
      seconds = Math.min(Math.max(0, d), VOTE_TIME_DEFAULTS.cap) + VOTE_TIME_DEFAULTS.extra;
    } else if(meta.kind === "video"){
      const d = meta.durationSec ?? VOTE_TIME_DEFAULTS.videoFallback;
      seconds = Math.min(Math.max(0, d), VOTE_TIME_DEFAULTS.cap) + VOTE_TIME_DEFAULTS.extra;
    } else if(meta.kind === "audio"){
      const d = meta.durationSec ?? VOTE_TIME_DEFAULTS.audioFallback;
      seconds = Math.min(Math.max(0, d), VOTE_TIME_DEFAULTS.cap) + VOTE_TIME_DEFAULTS.extra;
    } else {
      seconds = VOTE_TIME_DEFAULTS.unknown;
    }
    seconds = Math.max(1, Math.round(seconds));
    total += seconds;
    parts.push({ id: m?.id || null, kind: meta.kind, durationSec: meta.durationSec, seconds });
  }

  const minTotal = 10;
  const maxTotal = 20 * 60; // 20 minutes
  total = Math.max(minTotal, Math.min(maxTotal, total || 0));
  total = Math.round(total);

  return { total, parts };
}


// [ANCHOR] MB:S:VOTING_CORE — start + timers + reveal
function startVoting(room, mode = "host"){
  if(!room) return;

  // If vote already running, do nothing
  if(room.phase === "vote" && !room.voteComplete) return;

  room.phase = "vote";
  room.memesRevealed = true;
  room.voteComplete = false;

  clearRoomTimer(room, "collect");
  clearRoomTimer(room, "vote");

  Object.values(room.playersById || {}).forEach(p => {
    if(!p.connected) return;
    p.hasVoted = false;
    p.missedVote = false;
    p.readyNext = false;
  });

  room.memes = Array.isArray(room.memes) ? room.memes : [];
  room.memes.forEach(m => { m.votes = Number(m.votes || 0); });

  const calc = computeVoteSecondsFromMemes(room.memes);
  room.voteSeconds = clampInt(calc.total, 5, 20 * 60, VOTE_SECONDS_DEFAULT);
  room.voteStartAt = Date.now();
  room.voteEndsAt = room.voteStartAt + room.voteSeconds * 1000;
  room.voteSessionId = "v_" + Math.random().toString(36).slice(2, 10);

  tlPush(room, "voting-started", { mode, memes: room.memes.length, voteSeconds: room.voteSeconds, voteEndsAt: room.voteEndsAt });
  emitDebugState(room);

  io.to(room.code).emit("voting-started", {
    roomCode: room.code,
    memes: room.memes,
    memesCount: room.memes.length,
    voteSeconds: room.voteSeconds,
    voteStartAt: room.voteStartAt,
    voteEndsAt: room.voteEndsAt,
    serverNow: Date.now(),
    mode,
    voteTimeParts: calc.parts, // debug only; clients may ignore
  });

  logAdmin("voting_started", {
    roomCode: room.code,
    roundNumber: room.roundNumber,
    totalRounds: room.totalRounds,
    memes: room.memes.length,
    voteSeconds: room.voteSeconds,
    mode,
    voteTimeParts: calc.parts
  });

  // Always schedule auto-finalize, regardless of votes
  scheduleRoomTimer(room, "vote", room.voteSeconds * 1000 + VOTE_GRACE_MS + 60, () => {
    const r = getRoom(room.code);
    if(!r) return;
    if(r.voteSessionId !== room.voteSessionId) return;
    if(r.phase !== "vote") return;
    if(r.voteComplete) return;
    finalizeVoting(r, "timer");
  });

  // Special cases (0/1 meme) -> immediate finalize (but after voting-started)
  if(room.memes.length <= 1){
    setTimeout(() => {
      const r = getRoom(room.code);
      if(!r) return;
      if(r.voteSessionId !== room.voteSessionId) return;
      if(r.voteComplete) return;
      finalizeVoting(r, r.memes.length === 0 ? "no_memes" : "single_meme");
    }, 0);

    room.updatedAt = Date.now();
    // [ANCHOR] MB:S:SOCKET:PLAYER_READY_NEXT:SOFT_BROADCAST — same as votes (no room-wide blink)
    if (room.hostId) emitRoomStatusTo(room, room.hostId);
    else broadcast(room);
    return;
  }

  room.updatedAt = Date.now();
  broadcast(room);
}

function maybeFinishVoting(room){
  if(!room) return;
  if(room.phase !== "vote") return;
  if(room.voteComplete) return;

  const now = Date.now();

  if(room.voteEndsAt && now >= room.voteEndsAt + VOTE_GRACE_MS){
    return finalizeVoting(room, "timer");
  }

  const connectedPlayers = Object.values(room.playersById || {}).filter(p => !!p.connected);
  if(connectedPlayers.length === 0){
    return finalizeVoting(room, "no_players");
  }

  const allVoted = connectedPlayers.every(p => !!p.hasVoted);
  if(allVoted){
    return finalizeVoting(room, "all_voted");
  }
}


// [ANCHOR] MB:S:TIMERS:COLLECT
function scheduleCollectTimer(room, seconds){
  if(!room) return;
  clearRoomTimer(room, "collect");

  room.collectSeconds = clampInt(seconds ?? room.collectSeconds ?? ROUND_SECONDS_DEFAULT, 5, 600);
  room.collectEndsAt = Date.now() + room.collectSeconds * 1000;

  scheduleRoomTimer(room, "collect", room.collectSeconds * 1000 + 60, () => {
    if(room.phase === "collect"){
      startVoting(room, "auto_timer");
    }
  });
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


function maybeEmitAllReadyNext(room) {
  if (!room) return;
  if (room.phase !== "vote" || !room.voteComplete) return;

  // Mandatory for auto-advance: only players who actually voted AND are connected.
  const mandatory = Object.values(room.playersById || {}).filter((p) => p && p.connected && p.hasVoted);
  const total = mandatory.length;

  // Scenario "nobody voted": auto-advance is DISABLED (host emergency button only).
  if (total <= 0) return;

  const ready = mandatory.filter((p) => !!p.readyNext).length;

  if (ready >= total) {
    const payload = { roomCode: room.code, roundNumber: room.roundNumber,
    totalRounds: room.totalRounds, ready, total };
    if (room.hostId) io.to(room.hostId).emit("all-ready-next", payload);
    io.to(room.code).emit("all-ready-next", payload);
    tlPush(room, "all-ready-next", payload);
  }
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
    totalRounds: room.totalRounds,
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
      readyNext: !!p.readyNext,
      hasMeme: !!p.hasMeme,
      hasVoted: !!p.hasVoted,
      missedVote: !!p.missedVote,
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
    aiStats,
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

      // Auto-start voting when all connected players submitted their memes
      if (room.phase === "collect" && checkAllMemesReady(room)) {
        startVoting(room, "auto_all_memes");
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

  // Force vote phase, but keep the same rules as normal voting (timers/endsAt)
  clearRoomTimer(room, "collect");

  room.memesRevealed = true;
  room.phase = "vote";
  room.voteComplete = false;
  room.updatedAt = Date.now();

  // normalize votes
  room.memes = Array.isArray(room.memes) ? room.memes.map(m => ({ ...m, votes: Number(m?.votes || 0) })) : [];

  // server-authoritative vote timer (same logic as normal flow)
  // Ensure startVoting runs even if we were already in vote
  room.phase = "collect";
  startVoting(room, "sandbox_force");

  logAdmin("sandbox_force_vote", { roomCode, voteSeconds: room.voteSeconds, voteEndsAt: room.voteEndsAt });
  res.json({ ok: true, voteSeconds: room.voteSeconds, voteEndsAt: room.voteEndsAt });

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
  maybeFinishVoting(room);
  res.json({ ok:true, votes });
  broadcast(room);
});

app.post("/api/admin/sandbox/real/reset-round", (req, res) => {
  if(!requireAdmin(req, res)) return;
  const roomCode = String(req.body?.roomCode || "").trim().toUpperCase();
  const room = getRoom(roomCode);
  if(!room) return res.status(404).json({ ok:false, error:"E_ROOM_NOT_FOUND" });

  room.phase = "collect";
  room.voteComplete = false;
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


// [ANCHOR] MB:S:SOCKET_IO — realtime events
io.on("connection", (socket) => {
  // Client-side debug reports (helps track timer hangs / desync)
  

  // [ANCHOR] MB:S:SOCKET:DEBUG_REPORT
socket.on("debug-report", (payload) => {
    try{
      const roomCode = String(payload?.roomCode || socket.data?.roomCode || "").toUpperCase().trim();
      logAdmin("debug_report", {
        fromSocket: socket.id,
        role: socket.data?.role || null,
        roomCode: roomCode || null,
        payload: payload || null,
      });
    }catch(e){}
  });


// [ANCHOR] MB:S:SOCKET:HOST_DEBUG_SET — per-room debug toggle (timeline + timer debug)
socket.on("host-debug-set", (payload, cb) => {
  try{
    const roomCode = String(payload?.roomCode || socket.data?.roomCode || "").toUpperCase().trim();
    const room = getRoom(roomCode);
    if(!room) return cbErr(cb, "E_ROOM_NOT_FOUND", "Комната не найдена");
    if(!ensureHost(room, socket, cb)) return;

    room.debugEnabled = !!payload?.enabled;
    if(!Array.isArray(room.debugTimeline)) room.debugTimeline = [];

    emitDebugState(room);
    emitDebugSnapshot(room, socket);

    if(room.debugEnabled) tlPush(room, "debug-enabled", { enabled: true });
    logAdmin("host_debug_set", { roomCode: room.code, enabled: !!room.debugEnabled });

    cbOk(cb, { debugEnabled: !!room.debugEnabled, timelineSize: room.debugTimeline.length });
  }catch(e){
    cbErr(cb, "E_DEBUG_SET", "Ошибка debug toggle", String(e));
  }
});

// [ANCHOR] MB:S:SOCKET:HOST_DEBUG_SNAPSHOT — fetch room timeline snapshot
socket.on("host-debug-snapshot", (payload, cb) => {
  try{
    const roomCode = String(payload?.roomCode || socket.data?.roomCode || "").toUpperCase().trim();
    const room = getRoom(roomCode);
    if(!room) return cbErr(cb, "E_ROOM_NOT_FOUND", "Комната не найдена");
    if(!ensureHost(room, socket, cb)) return;

    emitDebugState(room);
    emitDebugSnapshot(room, socket);
    logAdmin("host_debug_snapshot", { roomCode: room.code, size: Array.isArray(room.debugTimeline) ? room.debugTimeline.length : 0 });
    cbOk(cb);
  }catch(e){
    cbErr(cb, "E_DEBUG_SNAPSHOT", "Ошибка snapshot", String(e));
  }
});

// [ANCHOR] MB:S:SOCKET:HOST_DEBUG_CLEAR — clear room timeline
socket.on("host-debug-clear", (payload, cb) => {
  try{
    const roomCode = String(payload?.roomCode || socket.data?.roomCode || "").toUpperCase().trim();
    const room = getRoom(roomCode);
    if(!room) return cbErr(cb, "E_ROOM_NOT_FOUND", "Комната не найдена");
    if(!ensureHost(room, socket, cb)) return;

    room.debugTimeline = [];
    emitDebugState(room);
    emitDebugSnapshot(room, socket);

    logAdmin("host_debug_clear", { roomCode: room.code });
    cbOk(cb);
  }catch(e){
    cbErr(cb, "E_DEBUG_CLEAR", "Ошибка clear", String(e));
  }
});

// [ANCHOR] MB:S:SOCKET:HOST_DEBUG_COLLECT — collect debug dumps from all clients and return to host (for ZIP download)
socket.on("host-debug-collect", (payload, cb) => {
  try{
    const roomCode = String(payload?.roomCode || socket.data?.roomCode || "").toUpperCase().trim();
    const requestId = String(payload?.requestId || "").trim() || `r_${Date.now()}`;
    const room = getRoom(roomCode);
    if(!room) return cbErr(cb, "E_ROOM_NOT_FOUND", "Комната не найдена");
    if(!ensureHost(room, socket, cb)) return;

    // Prepare collector
    if(!room.__dbgCollectors) room.__dbgCollectors = Object.create(null);
    room.__dbgCollectors[requestId] = {
      startedAt: Date.now(),
      hostSocketId: socket.id,
      clients: [],
      seenSocketIds: new Set(),
    };

    const roomSet = io.sockets.adapter.rooms.get(room.code) || new Set();
    const expectedClients = roomSet.size;

    // Ask all clients to send snapshot
    io.to(room.code).emit("debug:snapshot-request", { requestId, roomCode: room.code });

    // finalize after short window
    setTimeout(() => {
      try{
        const col = room.__dbgCollectors && room.__dbgCollectors[requestId];
        if(!col) return;
        delete room.__dbgCollectors[requestId];

        // figure missing sockets (best-effort)
        const missing = [];
        try{
          for(const sid of roomSet){
            if(!col.seenSocketIds.has(sid)) missing.push(sid);
          }
        }catch(e){}

        const serverSnapshot = {
          roomCode: room.code,
          serverNow: Date.now(),
          phase: room.phase,
          roundNumber: room.roundNumber,
          debugEnabled: !!room.debugEnabled,
          timeline: Array.isArray(room.debugTimeline) ? room.debugTimeline.slice(0, DEBUG_TIMELINE_MAX) : [],
        };

        cbOk(cb, {
          requestId,
          roomCode: room.code,
          serverNow: Date.now(),
          expectedClients,
          missing,
          serverSnapshot,
          clients: col.clients
        });
      }catch(e){
        cbErr(cb, "E_DEBUG_COLLECT_FINAL", "Ошибка финализации debug collect", String(e));
      }
    }, 1200);

    tlPush(room, "debug-collect:start", { requestId, expectedClients, fromHost: socket.id });
  }catch(e){
    cbErr(cb, "E_DEBUG_COLLECT", "Ошибка debug collect", String(e));
  }
});

// [ANCHOR] MB:S:SOCKET:DEBUG_SNAPSHOT_RESPONSE — receive client dumps for ZIP bundle
socket.on("debug:snapshot-response", (payload) => {
  try{
    const roomCode = String(payload?.roomCode || socket.data?.roomCode || "").toUpperCase().trim();
    const requestId = String(payload?.requestId || "").trim();
    if(!roomCode || !requestId) return;
    const room = getRoom(roomCode);
    if(!room) return;
    if(!room.__dbgCollectors || !room.__dbgCollectors[requestId]) return;
    const col = room.__dbgCollectors[requestId];

    if(col.seenSocketIds.has(socket.id)) return; // dedupe
    col.seenSocketIds.add(socket.id);

    const role = (socket.data?.role === "host") ? "host" : (socket.data?.role || payload?.role || "player");
    const nick = payload?.nick || (getPlayer(room, socket)?.nickname) || null;

    col.clients.push({
      socketId: socket.id,
      role,
      nick,
      clientNow: payload?.clientNow ?? null,
      dump: payload?.dump ?? null
    });

    // optional: timeline marker
    tlPush(room, "debug-collect:got", { requestId, from: socket.id, role, nick });
  }catch(e){}
});

  // [ANCHOR] MB:S:SOCKET:HOST_CREATE_ROOM
socket.on("host-create-room", (cb) => {
    try {
      const roomCode = createRoom(socket.id);
      incTotal("roomsCreated", 1);
      logAdmin("room_created", { roomCode, hostId: socket.id });
      socket.join(roomCode);
      socket.data.roomCode = roomCode;
      socket.data.role = "host";
      const room = getRoom(roomCode);
      try{
        if(room){
          room.hostConnected = true;
          room.hostDisconnectedAt = 0;
          if(room.hostCleanupTimer){ clearTimeout(room.hostCleanupTimer); room.hostCleanupTimer = null; }
        }
      }catch(e){}
      cbOk(cb, { roomCode, hostToken: room?.hostToken || null });
      broadcast(room);
      emitDebugState(room);
      emitDebugSnapshot(room, socket);
    } catch {
      cbErr(cb, "E_CREATE_ROOM", "Не удалось создать комнату");
    }
  });




  
  // [ANCHOR] MB:S:SOCKET:HOST_REJOIN — reclaim host after refresh/reconnect (uses hostToken from localStorage)
  socket.on("host-rejoin", (payload, cb) => {
    try{
      const roomCode = String(payload?.roomCode || "").toUpperCase().trim();
      const token = String(payload?.hostToken || "").trim();
      const room = getRoom(roomCode);
      if(!room) return cbErr(cb, "E_ROOM_NOT_FOUND", "Комната не найдена");
      if(!token || token !== room.hostToken) return cbErr(cb, "E_BAD_TOKEN", "Неверный ключ хоста");

      // Re-assign host socket
      room.hostId = socket.id;
      try{
        room.hostConnected = true;
        room.hostDisconnectedAt = 0;
        if(room.hostCleanupTimer){ clearTimeout(room.hostCleanupTimer); room.hostCleanupTimer = null; }
      }catch(e){}
      socket.join(room.code);
      socket.data.roomCode = room.code;
      socket.data.role = "host";
      room.updatedAt = Date.now();

      logAdmin("host_rejoin", { roomCode: room.code, hostId: socket.id });
      cbOk(cb, { roomCode: room.code });

      broadcast(room);
      emitDebugState(room);
      emitDebugSnapshot(room, socket);
    }catch(e){
      cbErr(cb, "E_HOST_REJOIN", "Не удалось восстановить хоста", String(e));
    }
  });

// [ANCHOR] MB:S:SOCKET:HOST_GENERATE_TASKS (AI)
socket.on("host-generate-tasks", async (payload, cb) => {
  try{
    const roomCode = String(payload?.roomCode || socket.data?.roomCode || "").toUpperCase().trim();
    const room = getRoom(roomCode);
    if(!room) return cbErr(cb, "E_NO_ROOM", "Комната не найдена");
    if(!ensureHost(room, socket, cb)) return;

    const rounds = clampInt(payload?.totalRounds ?? room.totalRounds ?? 5, 1, 20);
    const themes = Array.isArray(payload?.themes) ? payload.themes.map(cleanOneLine).filter(Boolean) : [];
    const edgeLevelMax = clampInt(payload?.edgeLevelMax ?? 2, 0, 4);

    if(themes.length === 0) return cbErr(cb, "E_NO_THEMES", "Нужно выбрать хотя бы одну тему");
    if(themes.length > rounds) return cbErr(cb, "E_TOO_MANY_THEMES", "Тем не должно быть больше, чем раундов");
    if(!OPENAI_API_KEY) return cbErr(cb, "E_NO_OPENAI_KEY", "На сервере не найден OPENAI_API_KEY");

    const result = await openaiGenerateTasks({ themes, rounds, edgeLevelMax });

    room.totalRounds = rounds;
    room.ai = {
      enabled: true,
      themes,
      edgeLevelMax,
      generatedAt: new Date().toISOString(),
      model: result.model,
      usage: result.usage || null,
      generatorVersion: result.generatorVersion || null,
      byTopic: result.byTopic || null,
      tasks: result.tasks
    };

    
    // [ANCHOR] MB:S:AI_STATS:UPDATE — count by category + edgeLevel
    try{
      bumpAiRequestStats(themes, edgeLevelMax, Array.isArray(result.tasks) ? result.tasks.length : 0);
      const list = Array.isArray(result.tasks) ? result.tasks : [];
      for(const t of list){
        const cat = (t && t.category) ? t.category : (Array.isArray(t?.themes) ? t.themes[0] : (themes[0] || "general"));
        bumpAiStats(cat, t?.edgeLevel ?? 0, 1);
      }
    }catch(e){}
cbOk(cb, { tasks: result.tasks, byTopic: result.byTopic || null, generatorVersion: result.generatorVersion || null, usage: result.usage || null, model: result.model });
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

  

  // [ANCHOR] MB:S:SOCKET:HOST_TASK_UPDATE (starts/updates collect)
socket.on("host-task-update", (payload, cb) => {
    try {
      const roomCode = String(payload?.roomCode || socket.data?.roomCode || "").trim().toUpperCase();
      const room = getRoom(roomCode);
      if (!room) return cbErr(cb, "E_ROOM_NOT_FOUND", "Комната не найдена");
      if (!ensureHost(room, socket, cb)) return;

      room.roundNumber = Number(payload?.roundNumber || 1);
      room.task = String(payload?.task || "");
      logAdmin("round_task", { roomCode, roundNumber: room.roundNumber,
    totalRounds: room.totalRounds, task: String(room.task||"").slice(0, 140) });
      room.phase = "collect";
      clearVoteTimer(room);
      room.voteStartAt = 0;
      room.voteEndsAt = 0;
      room.voteSessionId = null;
      room.voteComplete = false;
      room.locked = true;
      room.memesRevealed = false;
      room.memes = [];
      Object.values(room.playersById).forEach(p => { p.hasMeme = false; p.hasVoted = false; p.missedVote = false; p.readyNext = false; });
      room.updatedAt = Date.now();

      clearRoomTimer(room, "collect"); clearRoomTimer(room, "vote");
      scheduleCollectTimer(room, payload?.countdownSeconds ?? room.collectSeconds ?? ROUND_SECONDS_DEFAULT);

      tlPush(room, "round-task", { roundNumber: room.roundNumber,
    totalRounds: room.totalRounds, task: String(room.task||"").slice(0, 140), countdownSeconds: room.collectSeconds });
      emitDebugState(room);

      io.to(room.code).emit("round-task", { roomCode: room.code, roundNumber: room.roundNumber,
    totalRounds: room.totalRounds, task: room.task, countdownSeconds: room.collectSeconds });
      cbOk(cb);
      broadcast(room);
    } catch {
      cbErr(cb, "E_TASK_UPDATE", "Ошибка обновления задания");
    }
  });

  

  // [ANCHOR] MB:S:SOCKET:HOST_START_VOTE
socket.on("host-start-vote", (payload, cb) => {
    try{
      const roomCode = String(payload?.roomCode || socket.data?.roomCode || "").trim().toUpperCase();
      const room = getRoom(roomCode);
      if (!room) return cbErr(cb, "E_ROOM_NOT_FOUND", "Комната не найдена");
      if (!ensureHost(room, socket, cb)) return;
      if (room.phase === "vote") return cbOk(cb);
      if (room.phase !== "collect") return cbErr(cb, "E_WRONG_PHASE", "Голосование можно начать только во время сбора мемов");
      startVoting(room, "host");
      cbOk(cb);
    }catch{
      cbErr(cb, "E_START_VOTE", "Ошибка запуска голосования");
    }
  });





  // [ANCHOR] MB:S:SOCKET:HOST_FORCE_FINISH_VOTE (failsafe)
socket.on("host-force-finish-vote", ({ roomCode, reason }, cb) => {
  const room = getRoom(roomCode);
  if (!room) return cb?.({ ok: false, error: "room_not_found" });
  if (!ensureHost(room, socket, cb)) return;

  if (room.phase !== "vote" || room.voteComplete) {
    return cb?.({ ok: false, error: "not_in_vote" });
  }

  tlPush(room, "host-force-finish-vote", { reason: String(reason || "host_force") });
  finalizeVoting(room, reason || "host_force");
  emitDebugState(room);
  cb?.({ ok: true });
});

  

  // [ANCHOR] MB:S:SOCKET:PLAYER_JOIN
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
          // Backward compatibility for old player objects
          if (typeof p.readyNext !== "boolean") p.readyNext = false;
          if (typeof p.missedVote !== "boolean") p.missedVote = false;
          room.socketToPlayerId[socket.id] = pid;
          socket.join(roomCode);
          socket.data.roomCode = roomCode;
          socket.data.role = "player";
          cbOk(cb, {
            rejoined: true,
            playerId: pid,
            roomCode,
            nickname: p.nickname,
            // lightweight room snapshot (so player timer works even if first room-status is missed)
            phase: room.phase,
            roundNumber: room.roundNumber,
            totalRounds: room.totalRounds,
            task: room.task,
            collectEndsAt: room.collectEndsAt || null,
            voteEndsAt: room.voteEndsAt || null,
            collectSeconds: room.collectSeconds || null,
            voteSeconds: room.voteSeconds || null,
            serverNow: Date.now(),
          });
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
        missedVote: false,
        readyNext: false,
        score: 0,
      };
      room.nickIndex[nn] = pid;
      room.socketToPlayerId[socket.id] = pid;

      socket.join(roomCode);
      socket.data.roomCode = roomCode;
      socket.data.role = "player";

      cbOk(cb, {
        rejoined: false,
        playerId: pid,
        roomCode,
        nickname: nicknameRaw,
        // lightweight room snapshot (so player timer works even if first room-status is missed)
        phase: room.phase,
        roundNumber: room.roundNumber,
        totalRounds: room.totalRounds,
        task: room.task,
        collectEndsAt: room.collectEndsAt || null,
        voteEndsAt: room.voteEndsAt || null,
        collectSeconds: room.collectSeconds || null,
        voteSeconds: room.voteSeconds || null,
        serverNow: Date.now(),
      });
      incTotal("playerJoins", 1);
      logAdmin("player_join", { roomCode, nickname: nicknameRaw, playerId: pid, rejoined: false });
      broadcast(room);
    } catch {
      cbErr(cb, "E_JOIN", "Ошибка входа");
    }
  });

  

  // [ANCHOR] MB:S:SOCKET:PLAYER_SEND_MEME
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

      // Text-only meme support: when no url/file is provided, allow plain text
      const text = String(payload?.text || "").trim().slice(0, 700);
      const isTextOnly = !url && !!text;

      // Caption is only for url/file memes (no comments for text-only)
      const caption = isTextOnly ? "" : String(payload?.caption || "").trim().slice(0, 140);

      const meta = payload?.meta || {};
      const mediaKindRaw = String(meta.kind || meta.mediaKind || meta.mediaType || payload?.mediaKind || payload?.mediaType || "").toLowerCase();
      const mediaKind = isTextOnly ? "text" : (["photo","gif","video","audio"].includes(mediaKindRaw) ? mediaKindRaw : null);

      let durationSec = Number(meta.durationSec ?? meta.duration ?? payload?.durationSec ?? payload?.duration ?? NaN);
      if (!Number.isFinite(durationSec) || durationSec <= 0) durationSec = null;
      if (durationSec != null) {
        durationSec = Math.min(durationSec, 60 * 60); // sanity cap
        durationSec = Math.round(durationSec * 100) / 100;
      }
      if (!url && !text) return cbErr(cb, "E_BAD_DATA", "Нужна ссылка, файл или текст");

      room.locked = true;

      const idx = room.memes.findIndex(m => m.ownerId === p.id);
      const memeObj = {
        id: idx >= 0 ? room.memes[idx].id : `${Date.now()}_${Math.random().toString(16).slice(2)}`,
        url,
        text: isTextOnly ? text : "",
        caption,
        submittedAt: idx >= 0 ? (room.memes[idx].submittedAt || Date.now()) : Date.now(),
        ownerId: p.id,
        nickname: p.nickname,
        votes: idx >= 0 ? Number(room.memes[idx].votes || 0) : 0,
        mediaKind,
        durationSec,
      };
      if (idx >= 0) room.memes[idx] = memeObj; else room.memes.push(memeObj);

      p.hasMeme = true;
      room.updatedAt = Date.now();

      cbOk(cb);
      incTotal("memesSubmitted", 1);
      logAdmin("meme_submitted", { roomCode, nickname: p.nickname, playerId: p.id, mediaKind, durationSec });

      // Auto-start voting when all connected players submitted their memes
      if (room.phase === "collect" && checkAllMemesReady(room)) {
        startVoting(room, "auto_all_memes");
      }

      broadcast(room);
    } catch {
      cbErr(cb, "E_MEME_SEND", "Не удалось отправить мем");
    }
  });

  

  // [ANCHOR] MB:S:SOCKET:PLAYER_VOTE
socket.on("player-vote", (payload, cb) => {
    try {
      const roomCode = String(payload?.roomCode || socket.data?.roomCode || "").trim().toUpperCase();
      const memeId = String(payload?.memeId || "").trim();
      const room = getRoom(roomCode);
      if (!room) return cbErr(cb, "E_ROOM_NOT_FOUND", "Комната не найдена");
      if (room.phase !== "vote") return cbErr(cb, "E_VOTE_NOT_STARTED", "Голосование не началось");
      if (room.voteComplete) return cbErr(cb, "E_VOTE_CLOSED", "Голосование уже завершено");

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
      tlPush(room, "player-vote", { voter: p.nickname, memeId, ownerId: meme.ownerId });

      // If everyone voted — emit a clear "voting finished" signal
      maybeFinishVoting(room);

      cbOk(cb);
      // [ANCHOR] MB:S:SOCKET:PLAYER_VOTE:SOFT_BROADCAST — avoid room-wide re-render/blink on every vote
      // Variant 1: realtime voted X/Y only for HOST, no spam to all players.
      if (room.hostId) emitRoomStatusTo(room, room.hostId);
      else broadcast(room);
    } catch {
      cbErr(cb, "E_VOTE", "Ошибка голосования");
    }
  })


  


  // [ANCHOR] MB:S:SOCKET:PLAYER_READY_NEXT
socket.on("player-ready-next", ({ roomCode }, cb) => {
  try {
    const room = getRoom(roomCode);
    if (!room) return cb?.({ ok: false, error: "room_not_found" });

    const player = getPlayer(room, socket);
    if (!player) return cb?.({ ok: false, error: "player_not_found" });

    // Can be pressed as soon as the player voted (even while voting is still running).
    if (room.phase !== "vote") return cb?.({ ok: false, error: "not_in_vote_phase" });
    if (!player.hasVoted || player.missedVote) return cb?.({ ok: false, error: "not_voted" });

    if (!player.readyNext) {
      player.readyNext = true;
      room.updatedAt = Date.now();
      tlPush(room, "player-ready-next", { playerId: player.id, nickname: player.nickname });
    }

    broadcast(room);

    // Auto-advance check only matters after voteComplete=true (winner determined).
    maybeEmitAllReadyNext(room);

    cb?.({ ok: true });
  } catch (e) {
    cb?.({ ok: false, error: "E_READY_NEXT" });
  }
});


  

  // [ANCHOR] MB:S:SOCKET:HOST_FINAL_RESULTS
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
      clearRoomTimer(room, "collect"); clearRoomTimer(room, "vote");
      room.collectEndsAt = 0; room.voteEndsAt = 0;
      logAdmin("game_finished", { roomCode, resultsCount: results.length, top: results[0] || null });
      room.updatedAt = Date.now();

      cbOk(cb, { results });
      io.to(room.code).emit("game-finished", { roomCode: room.code, results });
      broadcast(room);
    } catch {
      cbErr(cb, "E_FINAL_RESULTS", "Ошибка финальных результатов");
    }
  });

  

  // [ANCHOR] MB:S:SOCKET:HOST_NEW_GAME
socket.on("host-new-game", (payload, cb) => {
    try {
      const roomCode = String(payload?.roomCode || socket.data?.roomCode || "").trim().toUpperCase();
      const room = getRoom(roomCode);
      if (!room) return cbErr(cb, "E_ROOM_NOT_FOUND", "Комната не найдена");
      if (!ensureHost(room, socket, cb)) return;

      room.phase = "lobby";
      clearRoomTimer(room, "collect"); clearRoomTimer(room, "vote");
      room.collectEndsAt = 0; room.voteEndsAt = 0;
    Object.values(room.playersById).forEach((p) => { p.readyNext = false; });
      logAdmin("new_game", { roomCode });
      room.locked = false;
      room.roundNumber = 0;
      room.task = "";
      room.memes = [];
      room.memesRevealed = false;
      room.voteComplete = false;
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
        // [ANCHOR] MB:S:HOST_DISCONNECT_GRACE — do NOT immediately delete the room.
        // Mobile networks / refreshes can cause short disconnects; keep the room alive so host can rejoin.
        try{
          room.hostConnected = false;
          room.hostDisconnectedAt = Date.now();
          room.updatedAt = Date.now();
        }catch(e){}

        // schedule cleanup if host doesn't come back
        try{
          if(room.hostCleanupTimer) clearTimeout(room.hostCleanupTimer);
          const code = room.code;
          const prevHostId = room.hostId;
          room.hostCleanupTimer = setTimeout(() => {
            try{
              const r = getRoom(code);
              if(!r) return;
              // if host rejoined — keep room
              if(r.hostConnected) return;
              if(r.hostId !== prevHostId) return;
              // cleanup
              try{ io.to(r.code).emit("room-closed", { roomCode: r.code, reason: "host_offline" }); }catch(e){}
              clearRoomTimer(r, "collect"); clearRoomTimer(r, "vote");
              delete rooms[code];
            }catch(e){}
          }, HOST_GRACE_MS);
        }catch(e){}

        // best-effort notify clients (UI may ignore)
        try{ io.to(room.code).emit("host-disconnected", { roomCode: room.code, serverNow: Date.now(), graceMs: HOST_GRACE_MS }); }catch(e){}
        broadcast(room);
        return;
      }

      const pid = room.socketToPlayerId[socket.id];
      if (pid && room.playersById[pid]) {
        room.playersById[pid].connected = false;
        room.playersById[pid].lastSeen = Date.now();
      }
      delete room.socketToPlayerId[socket.id];

      // If someone left, we may become "all ready" or "all voted"
      if (room.phase === "collect" && checkAllMemesReady(room)) {
        startVoting(room, "auto_all_memes_disconnect");
      }
      if (room.phase === "vote") {
        maybeFinishVoting(room);
      }

      broadcast(room);
    } catch {}
  });
});


/**
 * Watchdog (anti-stuck):
 * In some environments old rooms may lack timers, or a timer handle can be lost.
 * This global loop guarantees phase transitions by server timestamps.
 */
setInterval(() => {
  try{
    const now = Date.now();
    for (const code of Object.keys(rooms)){
      const room = rooms[code];
      if(!room) continue;
      try{ ensureRoomTimers(room); }catch(e){}
      // collect deadline reached
      if(room.phase === "collect" && room.collectEndsAt && now >= (Number(room.collectEndsAt)||0) + 250){
        emitTimerDebug(room, "watchdog_collect_deadline", { collectEndsAt: room.collectEndsAt, now });
        startVoting(room, "watchdog_collect_deadline");
      }

      // vote phase: repair missing deadline/timer, and guarantee finish by deadline
      if(room.phase === "vote" && !room.voteComplete){
        if(!room.voteEndsAt){
          // some debug/sandbox flows can enter vote without setting endsAt/timer
          room.voteSeconds = clampInt(room.voteSeconds ?? VOTE_SECONDS_DEFAULT, 5, 180);
          room.voteEndsAt = now + room.voteSeconds * 1000;
          emitTimerDebug(room, "watchdog_vote_repair_missing_deadline", { voteSeconds: room.voteSeconds, voteEndsAt: room.voteEndsAt, now });
          scheduleRoomTimer(room, "vote", room.voteEndsAt - now + 60, () => finalizeVoting(room, "watchdog_repair_timer"));
          broadcast(room);
        } else if(now >= (Number(room.voteEndsAt)||0) + 250){
          emitTimerDebug(room, "watchdog_vote_deadline", { voteEndsAt: room.voteEndsAt, now });
          finalizeVoting(room, "watchdog_vote_deadline");
        }
      }
    }
  }catch(e){}
}, 500);

server.listen(PORT, () => console.log(`[server] listening on ${PORT}`));