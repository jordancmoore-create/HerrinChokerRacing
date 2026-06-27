/* db.js — persistent log storage via IndexedDB.
   Two stores: 'meta' (small, for the history list) and 'files' (raw .llgx bytes,
   fetched only when a log is reopened). Degrades gracefully if IDB is unavailable. */
(function (global) {
  "use strict";
  const NAME = "hydro-telemetry", VER = 1;
  let dbp = null;

  function open() {
    if (dbp) return dbp;
    dbp = new Promise((res, rej) => {
      let r;
      try { r = indexedDB.open(NAME, VER); }
      catch (e) { return rej(e); }
      r.onupgradeneeded = () => {
        const db = r.result;
        if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta", { keyPath: "id" });
        if (!db.objectStoreNames.contains("files")) db.createObjectStore("files", { keyPath: "id" });
      };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    return dbp;
  }

  function tx(stores, mode, fn) {
    return open().then(db => new Promise((res, rej) => {
      const t = db.transaction(stores, mode);
      const result = fn(t);
      t.oncomplete = () => res(result);
      t.onerror = () => rej(t.error);
      t.onabort = () => rej(t.error);
    }));
  }

  const DB = {
    available() { return typeof indexedDB !== "undefined"; },

    put(meta, bytes) {
      return tx(["meta", "files"], "readwrite", t => {
        t.objectStore("meta").put(meta);
        t.objectStore("files").put({ id: meta.id, bytes: bytes });
      });
    },
    putMeta(meta) {
      return tx("meta", "readwrite", t => { t.objectStore("meta").put(meta); });
    },
    allMeta() {
      return tx("meta", "readonly", t => {
        const rq = t.objectStore("meta").getAll();
        return new Promise(r => { rq.onsuccess = () => r(rq.result || []); });
      }).then(p => p);
    },
    getBytes(id) {
      return tx("files", "readonly", t => {
        const rq = t.objectStore("files").get(id);
        return new Promise(r => { rq.onsuccess = () => r(rq.result ? rq.result.bytes : null); });
      }).then(p => p);
    },
    del(id) {
      return tx(["meta", "files"], "readwrite", t => {
        t.objectStore("meta").delete(id);
        t.objectStore("files").delete(id);
      });
    },
    clear() {
      return tx(["meta", "files"], "readwrite", t => {
        t.objectStore("meta").clear();
        t.objectStore("files").clear();
      });
    },
  };

  global.DB = DB;
})(window);
