/* cloud.js — client for the shared cloud library (Cloudflare Worker + R2).
   The whole library is private: the team passcode (kept in localStorage) is
   required to READ (list/files) and to WRITE (upload/edit/delete). It's sent as
   an x-access-key header on every request. list() reports ok / auth / offline so
   the app can show a passcode gate vs. fall back to local when the API is down. */
(function (global) {
  "use strict";

  // Resolve /log/api/ regardless of trailing-slash, relative to this page.
  const BASE = new URL("api/", document.baseURI).href;
  const KEY = "cloud-key";
  let online = null;   // null = not checked yet, true/false after first list()

  const key = () => localStorage.getItem(KEY) || "";
  const setKey = k => { k ? localStorage.setItem(KEY, k) : localStorage.removeItem(KEY); };
  const hasKey = () => !!key();
  // base64-encode the passcode (UTF-8) so any character survives the HTTP header
  function b64(s) {
    const bytes = new TextEncoder().encode(s);
    let bin = ""; for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }
  const auth = () => ({ "x-access-key": b64(key()) });
  const fileUrl = id => BASE + "get/" + encodeURIComponent(id);
  const fetchFile = id => fetch(fileUrl(id), { headers: auth() });

  // → { status: "ok", logs } | { status: "auth" } (passcode needed) | { status: "offline" }
  async function list() {
    try {
      const r = await fetch(BASE + "list", { cache: "no-store", headers: auth() });
      if (r.status === 401) { online = true; return { status: "auth" }; }
      if (!r.ok) { online = false; return { status: "offline" }; }
      const data = await r.json();
      online = true;
      return { status: "ok", logs: Array.isArray(data) ? data : [] };
    } catch (_) { online = false; return { status: "offline" }; }
  }

  async function upload(meta, bytes) {
    const fd = new FormData();
    fd.append("passcode", key());
    fd.append("meta", JSON.stringify(meta));
    fd.append("file", new Blob([bytes], { type: "application/octet-stream" }), (meta.id || "log") + ".llgx");
    const r = await fetch(BASE + "upload", { method: "POST", headers: auth(), body: fd });
    if (r.status === 401) throw new Error("passcode");
    if (!r.ok) throw new Error("upload failed (" + r.status + ")");
    return r.json();
  }

  async function post(path, body) {
    const r = await fetch(BASE + path, {
      method: "POST",
      headers: Object.assign({ "content-type": "application/json" }, auth()),
      body: JSON.stringify(Object.assign({ passcode: key() }, body)),
    });
    if (r.status === 401) throw new Error("passcode");
    if (!r.ok) throw new Error(path + " failed (" + r.status + ")");
    return r.json();
  }

  const update = (id, patch) => post("update", Object.assign({ id }, patch));
  const remove = id => post("delete", { id });

  // Official HRL timing for one boat on one race day.
  // → { status: "ok", heats } | { status: "pending" } | { status: "error", message }
  async function hrlTime(q) {
    const p = new URLSearchParams(q);
    try {
      const r = await fetch(BASE + "hrl?" + p, { cache: "no-store", headers: auth() });
      if (r.status === 401) return { status: "error", message: "passcode" };
      if (!r.ok) return { status: "error", message: "HTTP " + r.status };
      return await r.json();
    } catch (e) { return { status: "error", message: "offline" }; }
  }

  global.Cloud = {
    list, upload, update, remove, fileUrl, fetchFile, hrlTime,
    key, setKey, hasKey, isOnline: () => online,
  };
})(window);
