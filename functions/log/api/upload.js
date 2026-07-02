/* POST /log/api/upload — passcode-gated: store a log + update the index.
   Body: multipart/form-data { passcode, meta (JSON string), file (.llgx) }. */
import { json, authed, sanitizeId, hasMagic, readIndex, writeIndex } from "./_lib.js";

export async function onRequestPost({ request, env }) {
  if (!env.LOGS) return json({ error: "Storage not configured" }, 500);

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

  await env.LOGS.put("logs/" + id + ".llgx", buf, {
    httpMetadata: { contentType: "application/octet-stream" },
  });

  const entry = {
    id,
    name: meta.name || id, title: meta.title || "", ecu: meta.ecu || "", serial: meta.serial || "",
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
