/* Shared helpers for the telemetry cloud-library Functions (Cloudflare Pages + R2).
   Underscore-prefixed → importable but never exposed as its own route. */

export function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

// Upload/edit/delete are gated by a shared team passcode (encrypted env secret).
export function authed(passcode, env) {
  return !!env.UPLOAD_PASSCODE && passcode === env.UPLOAD_PASSCODE;
}

// Keep ids stable between upload and fetch (and matching the client's content id).
// Only strip what's unsafe for an R2 key / URL path; preserve spaces/semicolons so
// the cloud id equals the client id and the two libraries de-dupe cleanly.
export function sanitizeId(id) {
  return String(id || "").replace(/[\/\\\x00-\x1f]+/g, "_").slice(0, 200).trim();
}

// Validate the "lf3" magic ('l''f''3' = 0x6c 0x66 0x33) within the first bytes.
export function hasMagic(bytes) {
  const n = Math.min(bytes.length - 3, 16);
  for (let i = 0; i <= n; i++)
    if (bytes[i] === 0x6c && bytes[i + 1] === 0x66 && bytes[i + 2] === 0x33) return true;
  return false;
}

export const INDEX_KEY = "index.json";

export async function readIndex(env) {
  const o = await env.LOGS.get(INDEX_KEY);
  if (!o) return [];
  try { return JSON.parse(await o.text()); } catch { return []; }
}

export async function writeIndex(env, idx) {
  await env.LOGS.put(INDEX_KEY, JSON.stringify(idx), {
    httpMetadata: { contentType: "application/json" },
  });
}
