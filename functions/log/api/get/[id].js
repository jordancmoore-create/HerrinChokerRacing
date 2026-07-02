/* GET /log/api/get/<id> — public: streams a stored .llgx file from R2. */
import { sanitizeId } from "../_lib.js";

export async function onRequestGet({ env, params }) {
  if (!env.LOGS) return new Response("Storage not configured", { status: 500 });
  const id = sanitizeId(decodeURIComponent(params.id || ""));
  const obj = await env.LOGS.get("logs/" + id + ".llgx");
  if (!obj) return new Response("Not found", { status: 404 });
  const h = new Headers();
  h.set("content-type", "application/octet-stream");
  h.set("cache-control", "public, max-age=300");
  return new Response(obj.body, { headers: h });
}
