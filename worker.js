/* Cloudflare Worker entry for herrinchoker.ca.
   - Serves the static team site + /log telemetry app via the ASSETS binding.
   - Handles the shared telemetry cloud library at /log/api/* backed by R2.
   Bindings (see wrangler.jsonc): ASSETS (static assets), LOGS (R2 bucket).
   Secret: UPLOAD_PASSCODE (gates uploads/edits/deletes; reads are public). */

// Deploy marker — a `wrangler deploy` where worker.js is byte-identical to the
// live version SKIPS publishing changed static assets. Bump this on asset-only
// changes so the front-end (log/*.js/css/html) actually goes live.
globalThis.HCR_BUILD = "v24";

const INDEX_KEY = "index.json";
const CLIPS_KEY = "clips.json";

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
  const method = request.method;
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
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/log/api/")) return handleApi(request, env, url);
    if (url.pathname === "/api/clips" || url.pathname.startsWith("/api/clips/")) return handleClips(request, env, url);
    return env.ASSETS.fetch(request);   // static team site + /log app
  },
};
