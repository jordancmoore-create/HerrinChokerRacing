/* POST /log/api/delete — passcode-gated: remove a log + its index entry.
   Body: application/json { passcode, id }. */
import { json, authed, sanitizeId, readIndex, writeIndex } from "./_lib.js";

export async function onRequestPost({ request, env }) {
  if (!env.LOGS) return json({ error: "Storage not configured" }, 500);

  let body;
  try { body = await request.json(); } catch { return json({ error: "Bad JSON" }, 400); }
  if (!authed(body.passcode || "", env)) return json({ error: "Wrong or missing passcode" }, 401);

  const id = sanitizeId(body.id);
  await env.LOGS.delete("logs/" + id + ".llgx");
  const idx = await readIndex(env);
  await writeIndex(env, idx.filter(e => e.id !== id));

  return json({ ok: true });
}
