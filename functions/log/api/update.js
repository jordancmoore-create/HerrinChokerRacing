/* POST /log/api/update — passcode-gated: edit a log's note / classification.
   Body: application/json { passcode, id, cls?, note? }. */
import { json, authed, sanitizeId, readIndex, writeIndex } from "./_lib.js";

export async function onRequestPost({ request, env }) {
  if (!env.LOGS) return json({ error: "Storage not configured" }, 500);

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
