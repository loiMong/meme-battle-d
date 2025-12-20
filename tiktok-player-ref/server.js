import express from "express";
import path from "path";
import { fileURLToPath } from "url";

const app = express();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

function sanitizeUrl(u) {
  if (typeof u !== "string") return null;
  const trimmed = u.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    if (!["http:", "https:"].includes(url.protocol)) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function extractVideoId(finalUrl) {
  try {
    const u = new URL(finalUrl);
    const m = u.pathname.match(/\/video\/(\d+)/);
    if (m) return m[1];

    const qid = u.searchParams.get("item_id") || u.searchParams.get("video_id");
    if (qid && /^\d+$/.test(qid)) return qid;

    return null;
  } catch {
    return null;
  }
}

function buildEmbedUrl(videoId) {
  if (!videoId) return null;
  return `https://www.tiktok.com/embed/v2/${videoId}`;
}

async function resolveRedirects(inputUrl, { maxHops = 10, timeoutMs = 12000 } = {}) {
  let current = inputUrl;
  let hops = 0;

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);

  try {
    while (hops < maxHops) {
      hops += 1;

      const res = await fetch(current, {
        method: "GET",
        redirect: "manual",
        headers: {
          "User-Agent": UA,
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9",
        },
        signal: controller.signal,
      });

      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get("location");
        if (!loc) break;
        current = new URL(loc, current).toString();
        continue;
      }

      return { finalUrl: current, status: res.status, hops };
    }

    return { finalUrl: current, status: 0, hops };
  } finally {
    clearTimeout(t);
  }
}

app.get("/api/resolve", async (req, res) => {
  const input = sanitizeUrl(req.query.url);
  if (!input) return res.status(400).json({ ok: false, error: "Bad or empty url" });

  try {
    const { finalUrl, status, hops } = await resolveRedirects(input);
    const videoId = extractVideoId(finalUrl);
    const embedUrl = buildEmbedUrl(videoId);

    res.json({
      ok: true,
      inputUrl: input,
      finalUrl,
      status,
      hops,
      videoId,
      embedUrl,
    });
  } catch (e) {
    const msg = e?.name === "AbortError" ? "Timeout while resolving" : "Failed to resolve";
    res.status(502).json({ ok: false, error: msg });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, "0.0.0.0", () => {
  console.log(`TikTok Converter running on http://0.0.0.0:${port}`);
});
