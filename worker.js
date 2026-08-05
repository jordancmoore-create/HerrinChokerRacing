/* Cloudflare Worker entry for herrinchoker.ca.
   - Serves the static team site + /log telemetry app via the ASSETS binding.
   - Handles the shared telemetry cloud library at /log/api/* backed by R2.
   - Homepage media APIs: /api/clips (YouTube), /api/photos (R2 images),
     /api/instagram (server-cached feed; token lives in R2, cron keeps it fresh).
   Bindings (see wrangler.jsonc): ASSETS (static assets), LOGS (R2 bucket).
   Secret: UPLOAD_PASSCODE (gates uploads/edits/deletes; reads are public). */

// Deploy marker — a `wrangler deploy` where worker.js is byte-identical to the
// live version SKIPS publishing changed static assets. Bump this on asset-only
// changes so the front-end (log/*.js/css/html) actually goes live.
globalThis.HCR_BUILD = "v25";

const INDEX_KEY = "index.json";
const CLIPS_KEY = "clips.json";
const PHOTOS_KEY = "photos.json";
const IG_TOKEN_KEY = "ig-token.json";
const IG_CACHE_KEY = "instagram.json";

function json(data, status = 200, cache = "no-store") {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": cache },
  });
}
function authed(passcode, env) {
  return !!env.UPLOAD_PASSCODE && passcode === env.UPLOAD_PASSCODE;
}
// Passcode for reads (and a uniform gate for writes). Sent base64-encoded in the
// x-access-key header so any character (accents, £, non-ASCII) survives — plain
// HTTP headers can't carry those. Falls back to a raw ?k= query if present.
function accessKey(request, url) {
  const h = request.headers.get("x-access-key");
  if (h) {
    try {
      const bin = atob(h);
      return new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0)));
    } catch { return h; }   // not base64 (older client) → use as-is
  }
  return url.searchParams.get("k") || "";
}
// Keep ids stable between upload and fetch (and matching the client content id).
function sanitizeId(id) {
  return String(id || "").replace(/[\/\\\x00-\x1f]+/g, "_").slice(0, 200).trim();
}
// The race window the team set on the charts: two finite seconds-into-the-log
// marks, or null when the client is happy with auto-detection.
function raceWindow(r) {
  if (!r || typeof r !== "object") return null;
  const start = Number(r.start), end = Number(r.end);
  if (!isFinite(start) || !isFinite(end) || start < 0 || end <= start) return null;
  return { start, end, auto: r.auto !== false };
}
// One boat's official HRL line, once the league has posted the heat.
function officialTime(o) {
  if (!o || typeof o !== "object") return null;
  const time = Number(o.time);
  if (!isFinite(time) || time <= 0) return null;
  const str = (v, n) => (v == null ? "" : String(v).slice(0, n));
  return {
    time, laps: Number(o.laps) || 0, position: Number(o.position) || 0,
    heat: str(o.heat, 24), grp: str(o.grp, 64), points: str(o.points, 8),
    penalty1: str(o.penalty1, 16), penalty2: str(o.penalty2, 16),
    fetchedAt: Number(o.fetchedAt) || Date.now(),
  };
}
// Validate the "lf3" magic (0x6c 0x66 0x33) within the first bytes.
function hasMagic(bytes) {
  const n = Math.min(bytes.length - 3, 16);
  for (let i = 0; i <= n; i++)
    if (bytes[i] === 0x6c && bytes[i + 1] === 0x66 && bytes[i + 2] === 0x33) return true;
  return false;
}
async function readIndex(env) {
  const o = await env.LOGS.get(INDEX_KEY);
  if (!o) return [];
  try { return JSON.parse(await o.text()); } catch { return []; }
}
async function writeIndex(env, idx) {
  await env.LOGS.put(INDEX_KEY, JSON.stringify(idx), {
    httpMetadata: { contentType: "application/json" },
  });
}

// ---- Race clips (public homepage video section; writes need the team passcode) ----
async function readClips(env) {
  const o = await env.LOGS.get(CLIPS_KEY);
  if (!o) return [];
  try { return JSON.parse(await o.text()); } catch { return []; }
}
async function writeClips(env, arr) {
  await env.LOGS.put(CLIPS_KEY, JSON.stringify(arr), { httpMetadata: { contentType: "application/json" } });
}
// Pull a YouTube video id + start/end out of a pasted embed/watch/share URL (or a bare id).
function parseYT(input) {
  const s = String(input || "").trim();
  let videoId = "", start = 0, end = 0;
  let m = s.match(/(?:v=|embed\/|youtu\.be\/|shorts\/)([A-Za-z0-9_-]{6,})/);
  if (m) videoId = m[1]; else if (/^[A-Za-z0-9_-]{6,}$/.test(s)) videoId = s;
  m = s.match(/[?&]start=(\d+)/); if (m) start = +m[1];
  m = s.match(/[?&](?:end|stop)=(\d+)/); if (m) end = +m[1];
  m = s.match(/[?&]t=(\d+)/); if (m && !start) start = +m[1];
  return { videoId, start, end };
}

async function handleClips(request, env, url) {
  if (!env.LOGS) return json({ error: "storage not configured" }, 503);
  const method = request.method === "HEAD" ? "GET" : request.method;   // runtime strips HEAD bodies
  const sub = url.pathname.replace(/^\/api\/clips\/?/, "");

  if (method === "GET" && sub === "") {
    const clips = await readClips(env);
    clips.sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")) || (b.added || 0) - (a.added || 0));
    return json(clips, 200, "public, max-age=60");
  }
  // everything below mutates → require the team passcode
  if (!authed(accessKey(request, url), env)) return json({ error: "auth required" }, 401);

  if (method === "POST" && sub === "") {
    let body;
    try { body = await request.json(); } catch { return json({ error: "Bad JSON" }, 400); }
    const p = parseYT(body.url || body.videoId || "");
    const videoId = p.videoId || sanitizeId(body.videoId);
    if (!videoId) return json({ error: "Couldn't read a YouTube video id" }, 400);
    const start = Math.max(0, parseInt(body.start ?? p.start, 10) || 0);
    const end = Math.max(0, parseInt(body.end ?? p.end, 10) || 0);
    const clip = {
      id: sanitizeId(body.id || (videoId + "_" + start)),
      videoId, start, end,
      title: String(body.title || "").slice(0, 140),
      date: String(body.date || "").slice(0, 10),
      added: Date.now(),
    };
    const clips = await readClips(env);
    const next = clips.filter(c => c.id !== clip.id);
    next.push(clip);
    await writeClips(env, next);
    return json({ ok: true, clip });
  }

  if (method === "POST" && sub === "delete") {
    let body;
    try { body = await request.json(); } catch { return json({ error: "Bad JSON" }, 400); }
    const clips = await readClips(env);
    await writeClips(env, clips.filter(c => c.id !== sanitizeId(body.id)));
    return json({ ok: true });
  }

  return json({ error: "Not found" }, 404);
}

// ---- Team photos (public homepage gallery; writes need the team passcode) ----
async function readPhotos(env) {
  const o = await env.LOGS.get(PHOTOS_KEY);
  if (!o) return [];
  try { return JSON.parse(await o.text()); } catch { return []; }
}
async function writePhotos(env, arr) {
  await env.LOGS.put(PHOTOS_KEY, JSON.stringify(arr), { httpMetadata: { contentType: "application/json" } });
}
// Sniff the real image type from magic bytes — never trust the uploaded name.
function imageType(bytes) {
  if (bytes.length < 12) return "";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) return "image/gif";
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
      bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return "image/webp";
  return "";
}

async function handlePhotos(request, env, url) {
  if (!env.LOGS) return json({ error: "storage not configured" }, 503);
  const method = request.method === "HEAD" ? "GET" : request.method;   // runtime strips HEAD bodies
  const sub = url.pathname.replace(/^\/api\/photos\/?/, "");

  if (method === "GET" && sub.startsWith("img/")) {
    const id = sanitizeId(decodeURIComponent(sub.slice(4)));
    const obj = await env.LOGS.get("photos/" + id);
    if (!obj) return new Response("Not found", { status: 404 });
    return new Response(obj.body, {
      headers: {
        "content-type": obj.httpMetadata?.contentType || "image/jpeg",
        "cache-control": "public, max-age=31536000, immutable",   // ids are unique per upload
      },
    });
  }
  if (method === "GET" && sub === "") {
    const photos = await readPhotos(env);
    photos.sort((a, b) => (b.added || 0) - (a.added || 0));
    return json(photos, 200, "public, max-age=60");
  }
  // everything below mutates → require the team passcode
  if (!authed(accessKey(request, url), env)) return json({ error: "auth required" }, 401);

  if (method === "POST" && sub === "") {
    let form;
    try { form = await request.formData(); } catch { return json({ error: "Bad form data" }, 400); }
    const file = form.get("file");
    if (!file || typeof file === "string") return json({ error: "Missing image" }, 400);
    const buf = await file.arrayBuffer();
    if (buf.byteLength === 0) return json({ error: "Empty file" }, 400);
    if (buf.byteLength > 10 * 1024 * 1024) return json({ error: "Image too large (>10MB)" }, 413);
    const type = imageType(new Uint8Array(buf, 0, Math.min(16, buf.byteLength)));
    if (!type) return json({ error: "Not a JPG/PNG/WebP/GIF image" }, 415);
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    await env.LOGS.put("photos/" + id, buf, { httpMetadata: { contentType: type } });
    const photo = { id, caption: String(form.get("caption") || "").slice(0, 140), added: Date.now() };
    const photos = await readPhotos(env);
    photos.push(photo);
    await writePhotos(env, photos);
    return json({ ok: true, photo });
  }

  if (method === "POST" && sub === "delete") {
    let body;
    try { body = await request.json(); } catch { return json({ error: "Bad JSON" }, 400); }
    const id = sanitizeId(body.id);
    await env.LOGS.delete("photos/" + id);
    const photos = await readPhotos(env);
    await writePhotos(env, photos.filter(p => p.id !== id));
    return json({ ok: true });
  }

  return json({ error: "Not found" }, 404);
}

// ---- Instagram feed (official Instagram API, professional account) ----
// The long-lived access token is pasted once in the media admin and stored in R2
// (ig-token.json). It expires after 60 days; refreshIgTokenIfDue() renews it via
// graph.instagram.com weekly (cron + lazy on feed reads). The feed itself is
// cached in R2 (instagram.json) and re-fetched at most every 30 minutes.
const IG_GRAPH = "https://graph.instagram.com";
const IG_FIELDS = "id,caption,media_type,media_url,thumbnail_url,permalink,timestamp";

async function readIgToken(env) {
  const o = await env.LOGS.get(IG_TOKEN_KEY);
  if (!o) return null;
  try { return JSON.parse(await o.text()); } catch { return null; }
}
async function writeIgToken(env, t) {
  await env.LOGS.put(IG_TOKEN_KEY, JSON.stringify(t), { httpMetadata: { contentType: "application/json" } });
}
async function readIgCache(env) {
  const o = await env.LOGS.get(IG_CACHE_KEY);
  if (!o) return null;
  try { return JSON.parse(await o.text()); } catch { return null; }
}

async function fetchIgFeed(env) {
  const tok = await readIgToken(env);
  if (!tok || !tok.token) return null;
  const old = (await readIgCache(env)) || {};
  let next;
  try {
    const r = await fetch(IG_GRAPH + "/me/media?fields=" + IG_FIELDS + "&limit=12&access_token=" + encodeURIComponent(tok.token));
    const d = await r.json();
    if (!r.ok || !Array.isArray(d.data)) throw new Error(d.error?.message || "HTTP " + r.status);
    const posts = d.data.map(p => ({
      id: p.id,
      permalink: p.permalink,
      type: p.media_type,
      img: p.media_type === "VIDEO" ? (p.thumbnail_url || p.media_url) : p.media_url,
      caption: String(p.caption || "").slice(0, 200),
      time: p.timestamp,
    })).filter(p => p.img);
    next = { fetchedAt: Date.now(), username: tok.username || "", posts, error: "" };
  } catch (e) {
    // keep serving the last good posts; fetchedAt still moves so we retry in 30 min, not per-request
    next = { ...old, fetchedAt: Date.now(), error: String((e && e.message) || e) };
  }
  await env.LOGS.put(IG_CACHE_KEY, JSON.stringify(next), { httpMetadata: { contentType: "application/json" } });
  return next;
}

async function refreshIgTokenIfDue(env) {
  const tok = await readIgToken(env);
  if (!tok || !tok.token) return;
  const age = Date.now() - (tok.refreshedAt || tok.savedAt || 0);
  if (age < 7 * 864e5) return;   // weekly is plenty (Instagram also refuses tokens <24h old)
  try {
    const r = await fetch(IG_GRAPH + "/refresh_access_token?grant_type=ig_refresh_token&access_token=" + encodeURIComponent(tok.token));
    const d = await r.json();
    if (r.ok && d.access_token) {
      await writeIgToken(env, {
        ...tok, token: d.access_token, refreshedAt: Date.now(),
        expiresAt: Date.now() + (d.expires_in ? d.expires_in * 1000 : 60 * 864e5),
      });
    }
  } catch { /* cron retries tomorrow */ }
}

async function handleInstagram(request, env, ctx, url) {
  if (!env.LOGS) return json({ error: "storage not configured" }, 503);
  const method = request.method === "HEAD" ? "GET" : request.method;   // runtime strips HEAD bodies
  const sub = url.pathname.replace(/^\/api\/instagram\/?/, "");

  if (method === "GET" && sub === "") {
    const tok = await readIgToken(env);
    if (!tok || !tok.token) return json({ configured: false, posts: [] }, 200, "public, max-age=300");
    let cache = await readIgCache(env);
    if (!cache || !cache.fetchedAt) {
      cache = await fetchIgFeed(env);
    } else if (Date.now() - cache.fetchedAt > 30 * 60e3) {
      ctx.waitUntil(fetchIgFeed(env).then(() => refreshIgTokenIfDue(env)));   // serve stale now, refresh behind
    }
    return json({
      configured: true,
      username: cache?.username || tok.username || "",
      posts: cache?.posts || [],
    }, 200, "public, max-age=300");
  }
  // everything below is admin-only
  if (!authed(accessKey(request, url), env)) return json({ error: "auth required" }, 401);

  if (method === "POST" && sub === "token") {
    let body;
    try { body = await request.json(); } catch { return json({ error: "Bad JSON" }, 400); }
    const token = String(body.token || "").trim();
    if (!token) return json({ error: "Paste the access token first" }, 400);
    let username = "";
    try {
      const r = await fetch(IG_GRAPH + "/me?fields=username&access_token=" + encodeURIComponent(token));
      const d = await r.json();
      if (!r.ok) return json({ error: "Instagram rejected the token: " + (d.error?.message || "HTTP " + r.status) }, 400);
      username = d.username || "";
    } catch { return json({ error: "Couldn't reach Instagram to verify the token" }, 502); }
    await writeIgToken(env, { token, username, savedAt: Date.now(), refreshedAt: Date.now(), expiresAt: Date.now() + 60 * 864e5 });
    const feed = await fetchIgFeed(env);
    return json({ ok: true, username, posts: feed?.posts?.length || 0, feedError: feed?.error || "" });
  }

  if (method === "GET" && sub === "status") {
    const tok = await readIgToken(env);
    const cache = await readIgCache(env);
    return json({
      configured: !!(tok && tok.token),
      username: tok?.username || "",
      tokenRefreshedAt: tok?.refreshedAt || 0,
      tokenExpiresAt: tok?.expiresAt || 0,
      feedFetchedAt: cache?.fetchedAt || 0,
      postCount: cache?.posts?.length || 0,
      lastError: cache?.error || "",
    });
  }

  if (method === "POST" && sub === "disconnect") {
    await env.LOGS.delete(IG_TOKEN_KEY);
    await env.LOGS.delete(IG_CACHE_KEY);
    return json({ ok: true });
  }

  return json({ error: "Not found" }, 404);
}

// ---------- official HRL results ----------
// hrlhydroplane.com renders each event's results server-side as Elementor markup:
// no public JSON, but every heat header and every boat row carries a stable
// data-grpid="<date>-<class>-<heat>" (e.g. 2026-6-27-FormuleF-Q-1A). Anchor on
// that, flatten the markup to text, and read the labelled fields. The page is
// several MB, so the parsed rows are cached in R2 rather than refetched per poll.
const HRL_BASE = "https://hrlhydroplane.com/en/site_de_course/";
const HRL_CACHE_TTL = 10 * 60 * 1000;

function hrlText(frag) {
  return frag.replace(/<[^>]+>/g, "\n")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'").replace(/&[a-z]+;/g, " ")
    .split("\n").map(s => s.trim()).filter(Boolean);
}

function hrlParse(html) {
  const marks = [], out = [];
  const re = /<(h5|section)\b[^>]*data-grpid="([^"]+)"/g;
  let m;
  while ((m = re.exec(html))) marks.push({ tag: m[1], grp: m[2], i: m.index });
  marks.forEach((mk, k) => {
    if (mk.tag !== "section") return;
    const end = k + 1 < marks.length ? marks[k + 1].i : html.length;
    const t = hrlText(html.slice(mk.i, end));
    const bi = t.findIndex(x => /^[A-Z]{1,3}\s*\d+\s*-\s*\S/.test(x));
    if (bi < 0) return;
    const bm = t[bi].match(/^([A-Z]{1,3})\s*(\d+)\s*-\s*(.+)$/);
    const gm = mk.grp.match(/^(\d{4}-\d{1,2}-\d{1,2})-(.+)-([^-]+(?:-[^-]+)?)$/);
    const after = lbl => { const i = t.findIndex(x => x.toLowerCase().indexOf(lbl) === 0); return i >= 0 ? t[i + 1] : null; };
    const num = v => { const f = parseFloat(String(v).replace(",", ".")); return isFinite(f) ? f : null; };
    out.push({
      grp: mk.grp,
      date: gm ? gm[1] : "", heat: mk.grp.replace(/^\d{4}-\d{1,2}-\d{1,2}-[^-]+-/, ""),
      cls: bm[1], boat: bm[2], name: bm[3].trim(),
      driver: (t[bi + 1] && !/^(time|completed|penalty|\d+\s*pts)/i.test(t[bi + 1])) ? t[bi + 1] : "",
      position: num(t[0]), time: num(after("time (sec)")), laps: num(after("completed laps")),
      penalty1: after("penalty 1"), penalty2: after("penalty 2"),
      points: (t.find(x => /^\d+\s*PTS$/i.test(x)) || "").replace(/\s*PTS/i, ""),
    });
  });
  return out;
}

async function hrlResults(site, env, fresh) {
  const key = "hrl/" + site + ".json";
  if (!fresh) {
    const cached = await env.LOGS.get(key);
    if (cached) {
      const c = await cached.json().catch(() => null);
      if (c && Date.now() - c.at < HRL_CACHE_TTL) return c.rows;
      if (c) var stale = c.rows;   // keep as a fallback if the fetch fails
    }
  }
  let html;
  try {
    const r = await fetch(HRL_BASE + site + "/", {
      headers: { "user-agent": "HerrinChokerRacing/1.0 (+https://herrinchoker.ca)" },
      cf: { cacheTtl: 300, cacheEverything: true },
    });
    if (!r.ok) throw new Error("HRL responded " + r.status);
    html = await r.text();
  } catch (e) {
    if (typeof stale !== "undefined") return stale;
    throw e;
  }
  const rows = hrlParse(html);
  if (rows.length)
    await env.LOGS.put(key, JSON.stringify({ at: Date.now(), rows }),
      { httpMetadata: { contentType: "application/json" } });
  return rows;
}

async function handleApi(request, env, url) {
  const path = url.pathname.replace(/^\/log\/api\/?/, "");   // "list" | "get/<id>" | "upload" | ...
  const method = request.method;

  // R2 not bound yet → tell the client "unavailable" so it keeps its static/local fallback.
  if (!env.LOGS) return json({ error: "storage not configured" }, path === "list" ? 503 : 500);

  // The whole library is private: reads AND writes require the team passcode
  // (sent as x-access-key header or ?k= query on GETs; in body/form on writes).
  if (!authed(accessKey(request, url), env)) return json({ error: "auth required" }, 401);

  if (path === "list" && method === "GET") {
    const idx = await readIndex(env);
    idx.sort((a, b) => (b.logTime || b.uploadedAt || 0) - (a.logTime || a.uploadedAt || 0));
    return json(idx);
  }

  // Official timing for one boat, scraped from HRL's public results page.
  // Logs get uploaded straight after a heat, well before HRL posts anything, so
  // "not there yet" is the normal case and answers 200 with status "pending" —
  // the client retries on its own schedule rather than treating it as an error.
  if (path === "hrl" && method === "GET") {
    const site = String(url.searchParams.get("site") || "").toLowerCase().replace(/[^a-z0-9-]/g, "");
    const date = String(url.searchParams.get("date") || "").replace(/[^0-9-]/g, "");
    const cls = String(url.searchParams.get("cls") || "").replace(/[^A-Za-z]/g, "").toUpperCase();
    const boat = String(url.searchParams.get("boat") || "").replace(/[^0-9]/g, "");
    if (!site || !boat) return json({ error: "site and boat required" }, 400);
    let rows;
    try { rows = await hrlResults(site, env, url.searchParams.get("fresh") === "1"); }
    catch (e) { return json({ status: "error", message: String(e.message || e) }); }
    if (!rows) return json({ status: "error", message: "results page unavailable" });
    const heats = rows.filter(r => r.boat === boat
      && (!cls || r.cls === cls) && (!date || r.date === date));
    return json(heats.length ? { status: "ok", heats } : { status: "pending", scanned: rows.length });
  }

  if (path.startsWith("get/") && method === "GET") {
    const id = sanitizeId(decodeURIComponent(path.slice(4)));
    const obj = await env.LOGS.get("logs/" + id + ".llgx");
    if (!obj) return new Response("Not found", { status: 404 });
    return new Response(obj.body, {
      headers: { "content-type": "application/octet-stream", "cache-control": "private, no-store" },
    });
  }

  if (path === "upload" && method === "POST") {
    let form;
    try { form = await request.formData(); } catch { return json({ error: "Bad form data" }, 400); }
    const passcode = form.get("passcode") || request.headers.get("x-upload-key") || "";
    if (!authed(passcode, env)) return json({ error: "Wrong or missing passcode" }, 401);
    const file = form.get("file");
    const metaStr = form.get("meta");
    if (!file || typeof file === "string" || !metaStr) return json({ error: "Missing file or meta" }, 400);
    const buf = await file.arrayBuffer();
    if (buf.byteLength === 0) return json({ error: "Empty file" }, 400);
    if (buf.byteLength > 30 * 1024 * 1024) return json({ error: "File too large (>30MB)" }, 413);
    const bytes = new Uint8Array(buf);
    if (!hasMagic(bytes)) return json({ error: "Not a .llgx file" }, 415);
    let meta;
    try { meta = JSON.parse(metaStr); } catch { return json({ error: "Bad meta JSON" }, 400); }
    const id = sanitizeId(meta.id);
    if (!id) return json({ error: "Missing id" }, 400);
    await env.LOGS.put("logs/" + id + ".llgx", buf, { httpMetadata: { contentType: "application/octet-stream" } });
    const entry = {
      id, name: meta.name || id, title: meta.title || "", ecu: meta.ecu || "", serial: meta.serial || "",
      duration: meta.duration || 0, channels: meta.channels || 0, logTime: meta.logTime || null,
      cls: meta.cls || { group: "testing", auto: true }, note: meta.note || "",
      race: raceWindow(meta.race), official: officialTime(meta.official),
      stats: meta.stats || {}, uploadedAt: Date.now(),
    };
    const idx = await readIndex(env);
    const next = idx.filter(e => e.id !== id);   // overwrite same id (de-dupe)
    next.push(entry);
    await writeIndex(env, next);
    return json({ ok: true, id });
  }

  if (path === "update" && method === "POST") {
    let body;
    try { body = await request.json(); } catch { return json({ error: "Bad JSON" }, 400); }
    if (!authed(body.passcode || "", env)) return json({ error: "Wrong or missing passcode" }, 401);
    const id = sanitizeId(body.id);
    const idx = await readIndex(env);
    const e = idx.find(x => x.id === id);
    if (!e) return json({ error: "Not found" }, 404);
    if (body.cls !== undefined) e.cls = body.cls;
    if (body.note !== undefined) e.note = body.note;
    if (body.race !== undefined) e.race = raceWindow(body.race);
    if (body.official !== undefined) e.official = officialTime(body.official);
    if (body.stats !== undefined && body.stats && typeof body.stats === "object") e.stats = body.stats;
    await writeIndex(env, idx);
    return json({ ok: true });
  }

  if (path === "delete" && method === "POST") {
    let body;
    try { body = await request.json(); } catch { return json({ error: "Bad JSON" }, 400); }
    if (!authed(body.passcode || "", env)) return json({ error: "Wrong or missing passcode" }, 401);
    const id = sanitizeId(body.id);
    await env.LOGS.delete("logs/" + id + ".llgx");
    const idx = await readIndex(env);
    await writeIndex(env, idx.filter(e => e.id !== id));
    return json({ ok: true });
  }

  return json({ error: "Not found" }, 404);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/log/api/")) return handleApi(request, env, url);
    if (url.pathname === "/api/clips" || url.pathname.startsWith("/api/clips/")) return handleClips(request, env, url);
    if (url.pathname === "/api/photos" || url.pathname.startsWith("/api/photos/")) return handlePhotos(request, env, url);
    if (url.pathname === "/api/instagram" || url.pathname.startsWith("/api/instagram/")) return handleInstagram(request, env, ctx, url);
    return env.ASSETS.fetch(request);   // static team site + /log app
  },

  // Daily cron (wrangler.jsonc → triggers.crons): renew the Instagram token when
  // it's a week old and keep the cached feed warm even with no site traffic.
  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      if (!env.LOGS) return;
      await refreshIgTokenIfDue(env);
      const tok = await readIgToken(env);
      if (tok && tok.token) await fetchIgFeed(env);
    })());
  },
};
