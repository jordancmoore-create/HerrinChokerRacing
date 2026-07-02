/* cloud.js — client for the shared cloud library (Cloudflare Pages Functions + R2).
   Uploads are gated by a team passcode kept in localStorage; reads are public.
   Degrades gracefully: if the API isn't deployed, isOnline() reports false and the
   app falls back to its local/static-manifest behaviour. */
(function (global) {
  "use strict";

  // Resolve /log/api/ regardless of trailing-slash, relative to this page.
  const BASE = new URL("api/", document.baseURI).href;
  const KEY = "cloud-key";
  let online = null;   // null = not checked yet, true/false after first list()

  const key = () => localStorage.getItem(KEY) || "";
  const setKey = k => { k ? localStorage.setItem(KEY, k) : localStorage.removeItem(KEY); };
  const hasKey = () => !!key();
  const fileUrl = id => BASE + "get/" + encodeURIComponent(id);

  async function list() {
    try {
      const r = await fetch(BASE + "list", { cache: "no-store" });
      if (!r.ok) { online = false; return null; }
      const data = await r.json();
      online = true;
      return Array.isArray(data) ? data : [];
    } catch (_) { online = false; return null; }
  }

  async function upload(meta, bytes) {
    const fd = new FormData();
    fd.append("passcode", key());
    fd.append("meta", JSON.stringify(meta));
    fd.append("file", new Blob([bytes], { type: "application/octet-stream" }), (meta.id || "log") + ".llgx");
    const r = await fetch(BASE + "upload", { method: "POST", body: fd });
    if (r.status === 401) throw new Error("passcode");
    if (!r.ok) throw new Error("upload failed (" + r.status + ")");
    return r.json();
  }

  async function post(path, body) {
    const r = await fetch(BASE + path, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(Object.assign({ passcode: key() }, body)),
    });
    if (r.status === 401) throw new Error("passcode");
    if (!r.ok) throw new Error(path + " failed (" + r.status + ")");
    return r.json();
  }

  const update = (id, patch) => post("update", Object.assign({ id }, patch));
  const remove = id => post("delete", { id });

  global.Cloud = {
    list, upload, update, remove, fileUrl,
    key, setKey, hasKey, isOnline: () => online,
  };
})(window);
