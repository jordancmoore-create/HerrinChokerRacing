/* GET /log/api/list — public: returns the shared library index (newest first). */
import { json, readIndex } from "./_lib.js";

export async function onRequestGet({ env }) {
  // R2 not bound yet → signal "unavailable" (not empty) so the client keeps using
  // its static-manifest fallback instead of showing a blank shared library.
  if (!env.LOGS) return json({ error: "storage not configured" }, 503);
  const idx = await readIndex(env);
  idx.sort((a, b) => (b.logTime || b.uploadedAt || 0) - (a.logTime || a.uploadedAt || 0));
  return json(idx);
}
