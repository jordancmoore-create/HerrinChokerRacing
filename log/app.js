/* app.js — UI glue: drag/drop, persistence + library, tabs, dashboard render. */
(function () {
  "use strict";
  const $ = sel => document.querySelector(sel);
  const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };

  const logs = [];        // in-session open logs: {id, name, log, seg, flags, kpis}
  let active = -1;
  let home = true;
  let historyMeta = [];   // merged library: local (IndexedDB) + published (manifest)
  let publishedMeta = []; // read-only entries served from manifest.json

  const fileInput = $("#fileInput");

  // content-based id: same log dedupes even if the file was renamed
  function contentId(log, name) { return (log.title || name || "log") + "__" + (log.serial || ""); }

  function onFiles(fileList) {
    const files = [...fileList].filter(f => /\.llgx$/i.test(f.name));
    if (!files.length) { toast("Drop .llgx log files"); return; }
    let pending = files.length, added = 0, dupes = 0;
    files.forEach(file => {
      const r = new FileReader();
      r.onload = () => {
        try {
          const buf = r.result;
          const log = LLGX.parse(buf);
          const seg = Analysis.segment(log);
          const id = contentId(log, file.name);
          if (logs.some(e => e.id === id) || historyMeta.some(m => m.id === id)) dupes++; else added++;
          const ex = logs.findIndex(e => e.id === id);
          const entry = { id, name: file.name, log, seg, flags: Analysis.flags(log, seg), kpis: Analysis.kpis(log, seg) };
          if (ex >= 0) logs.splice(ex, 1);
          logs.push(entry);
          active = logs.length - 1; home = false;
          saveHistory(id, file, buf, log, seg);
        } catch (e) {
          console.error(e); toast("Couldn't read " + file.name + ": " + e.message);
        }
        if (--pending === 0) { render(); if (dupes) toast(`${added} added, ${dupes} already in library`); }
      };
      r.onerror = () => { toast("Read error: " + file.name); if (--pending === 0) render(); };
      r.readAsArrayBuffer(file);
    });
  }

  // ---------- persistence ----------
  function saveHistory(id, file, bytes, log, seg) {
    if (!DB.available()) return;
    const logTime = History.parseLogTime(log.title, file.name);
    // preserve a manual (non-auto) classification if this log is already saved
    const prev = historyMeta.find(m => m.id === id);
    const cls = (prev && prev.cls && prev.cls.auto === false) ? prev.cls : History.classify(logTime);
    const meta = {
      id, name: file.name, size: file.size, added: (prev && prev.added) || Date.now(),
      title: log.title, ecu: log.ecu_model, serial: log.serial,
      duration: log.duration, channels: log.channels.length,
      logTime, cls, note: (prev && prev.note) || "", stats: Analysis.summaryStats(log, seg),
    };
    DB.put(meta, bytes).then(refreshHistory).catch(e => console.warn("history save failed", e));
  }

  // load the published (shared) library from the host, if present
  function loadPublished() {
    return fetch("manifest.json", { cache: "no-cache" })
      .then(r => (r.ok ? r.json() : null))
      .then(man => { if (man && Array.isArray(man.logs)) publishedMeta = man.logs.map(e => Object.assign({}, e, { published: true })); })
      .catch(() => { });
  }

  function refreshHistory() {
    const localP = DB.available() ? DB.allMeta() : Promise.resolve([]);
    return localP.then(localList => {
      const localIds = new Set(localList.map(m => m.id));
      const pub = publishedMeta.filter(p => !localIds.has(p.id));  // local overrides published
      historyMeta = localList.concat(pub);
      document.body.classList.toggle("has-local", localList.length > 0);
      History.render($("#history"), historyMeta, handlers);
    }).catch(e => console.warn("history load failed", e));
  }

  const handlers = {
    open: openFromHistory,
    del: id => DB.del(id).then(refreshHistory).catch(e => console.warn(e)),
    clear: () => { if (confirm("Remove all saved logs from history?")) DB.clear().then(refreshHistory); },
    reassign: (id, cls, note) => {
      const m = historyMeta.find(r => r.id === id);
      if (!m) return;
      m.cls = cls;
      if (note !== undefined) m.note = note;
      DB.putMeta(m).then(refreshHistory).catch(e => console.warn(e));
    },
  };

  function openFromHistory(id) {
    const ex = logs.findIndex(e => e.id === id);
    if (ex >= 0) { active = ex; home = false; render(); return; }
    const m = historyMeta.find(r => r.id === id) || {};
    const source = (m.published && m.file)
      ? fetch(m.file).then(r => { if (!r.ok) throw new Error("file not found"); return r.arrayBuffer(); })
      : DB.getBytes(id);
    Promise.resolve(source).then(bytes => {
      if (!bytes) { toast("Saved file missing"); return; }
      const log = LLGX.parse(bytes);
      const seg = Analysis.segment(log);
      logs.push({ id, name: m.name || log.title, log, seg, flags: Analysis.flags(log, seg), kpis: Analysis.kpis(log, seg) });
      active = logs.length - 1; home = false; render();
    }).catch(e => toast("Couldn't open: " + e.message));
  }

  // ---------- publish (export shareable bundle) ----------
  async function publish() {
    const local = historyMeta.filter(m => !m.published);
    if (!local.length) { toast("No local logs to publish"); return; }
    toast("Building publish bundle…");
    const files = [], manifestLogs = [];
    for (const m of local) {
      const bytes = await DB.getBytes(m.id);
      if (!bytes) continue;
      const safe = m.id.replace(/[^a-z0-9._-]+/gi, "_").slice(0, 120);
      const path = "logs/" + safe + ".llgx";
      files.push({ name: path, data: new Uint8Array(bytes) });
      manifestLogs.push({
        id: m.id, name: m.name, title: m.title, ecu: m.ecu, serial: m.serial,
        duration: m.duration, channels: m.channels, logTime: m.logTime,
        cls: m.cls, note: m.note || "", stats: m.stats, file: path,
      });
    }
    const manifest = { generated: Date.now(), team: "Herrin Choker Racing #38 · INFERNO", logs: manifestLogs };
    files.push({ name: "manifest.json", data: new TextEncoder().encode(JSON.stringify(manifest, null, 2)) });
    downloadBlob(Zip.zipStore(files), "inferno-telemetry-data.zip");
    toast(`Published ${manifestLogs.length} logs → unzip into the app folder, then redeploy`);
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = filename; document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1000);
  }

  // ---------- render ----------
  function render() {
    document.body.classList.toggle("has-logs", logs.length > 0);
    document.body.classList.toggle("home", home || active < 0);
    renderTabs();
    if (active >= 0 && !home) {
      const e = logs[active];
      renderHeader(e); renderKpis(e); renderFlags(e);
      Charts.build(e.log, e.seg, $("#charts"));
    }
  }

  function renderTabs() {
    const tabs = $("#tabs"); tabs.innerHTML = "";
    logs.forEach((e, i) => {
      const t = el("button", "tab" + (i === active && !home ? " active" : ""), esc(shortName(e.name)));
      t.onclick = () => { active = i; home = false; render(); };
      const x = el("span", "tab-x", "×");
      x.onclick = ev => { ev.stopPropagation(); logs.splice(i, 1); if (active >= logs.length) active = logs.length - 1; if (!logs.length) home = true; render(); };
      t.appendChild(x); tabs.appendChild(t);
    });
    const add = el("button", "tab tab-add", "+ Add log");
    add.onclick = () => fileInput.click();
    tabs.appendChild(add);
  }

  function renderHeader(e) {
    const L = e.log;
    $("#sessionTitle").textContent = L.title || e.name;
    const dur = (L.duration / 60).toFixed(1);
    const m = historyMeta.find(r => r.id === e.id);
    const clsTxt = m ? History.clsLabel(m.cls) : null;
    const chips = [
      clsTxt ? ["", clsTxt] : null,
      ["ECU", L.ecu_model], ["Firmware", L.firmware], ["PCLink", L.pclink_version],
      ["Serial", L.serial], ["Duration", dur + " min"], ["Channels", L.channels.length],
    ].filter(c => c && c[1] != null && c[1] !== "");
    const noteHtml = (m && m.note) ? `<span class="chip chip-note">📝 ${esc(m.note)}</span>` : "";
    $("#chips").innerHTML = noteHtml + chips.map(c => `<span class="chip">${c[0] ? "<b>" + c[0] + "</b>" : ""}${esc(String(c[1]))}</span>`).join("");
    const s = e.seg;
    let tl = `<span class="seg-dot"></span>Engine start ~${s.start.toFixed(0)}s`;
    if (s.raceStart) {
      tl += `&nbsp;·&nbsp;Sustained load ${s.raceStart.toFixed(0)}–${s.raceEnd.toFixed(0)}s `
          + `(${((s.raceEnd - s.raceStart) / 60).toFixed(1)} min)`;
      if (s.lap) tl += `&nbsp;·&nbsp;<span class="muted">if race: ~${s.lap.toFixed(0)}s lap → ~${Math.round(s.nLaps)} laps (approx)</span>`;
    }
    $("#timeline").innerHTML = tl;
  }

  function renderKpis(e) {
    $("#kpis").innerHTML = e.kpis.map(k => `
      <div class="kpi kpi-${k.sev}">
        <div class="kpi-label">${k.label}</div>
        <div class="kpi-value">${k.value}<span class="kpi-unit">${k.unit}</span></div>
      </div>`).join("");
  }

  function renderFlags(e) {
    const f = e.flags;
    const sevMeta = { CRITICAL: ["crit", "▲"], WATCH: ["warn", "●"] };
    let html = "";
    const items = f.concerns.map(([sev, msg]) => {
      const [cls, ic] = sevMeta[sev] || ["warn", "●"];
      return `<div class="flag flag-${cls}"><span class="flag-ic">${ic}</span>
        <div><div class="flag-sev">${sev}</div><div class="flag-msg">${esc(msg)}</div></div></div>`;
    }).join("");
    html += `<div class="panel"><h2>Concerns</h2>${items || '<div class="ok-note">✓ Nothing flagged.</div>'}</div>`;
    html += `<div class="panel"><h2>Opportunities</h2>` +
      (f.opps.map(m => `<div class="li">• ${esc(m)}</div>`).join("") || '<div class="muted">—</div>') + `</div>`;
    html += `<div class="panel"><h2>Notes</h2>` +
      (f.notes.map(m => `<div class="li muted">• ${esc(m)}</div>`).join("") || '<div class="muted">—</div>') + `</div>`;
    $("#flags").innerHTML = html;
  }

  function shortName(n) { return String(n || "").replace(/^ECU Log /, "").replace(/\.llgx$/i, ""); }
  function esc(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }

  let toastT;
  function toast(msg) {
    let t = $("#toast"); if (!t) { t = el("div"); t.id = "toast"; document.body.appendChild(t); }
    t.textContent = msg; t.classList.add("show");
    clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove("show"), 2600);
  }

  // ---------- events ----------
  ["dragenter", "dragover"].forEach(ev => document.addEventListener(ev, e => {
    e.preventDefault(); document.body.classList.add("dragging");
  }));
  ["dragleave", "drop"].forEach(ev => document.addEventListener(ev, e => {
    e.preventDefault();
    if (ev === "drop" || e.relatedTarget === null) document.body.classList.remove("dragging");
  }));
  document.addEventListener("drop", e => { if (e.dataTransfer && e.dataTransfer.files) onFiles(e.dataTransfer.files); });

  $("#dropzone").addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", () => { onFiles(fileInput.files); fileInput.value = ""; });
  $("#openBtn").addEventListener("click", () => fileInput.click());
  $("#homeBtn").addEventListener("click", () => { home = true; render(); });

  // theme (light / dark) — attribute is pre-set in <head> to avoid a flash
  function applyTheme(t) {
    document.documentElement.dataset.theme = t;
    const b = $("#themeBtn"); if (b) b.textContent = t === "light" ? "🌙" : "☀";
  }
  applyTheme(localStorage.getItem("inferno-theme") || "dark");
  $("#themeBtn").addEventListener("click", () => {
    const next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
    localStorage.setItem("inferno-theme", next);
    applyTheme(next);
    if (active >= 0 && !home) render();   // rebuild charts so canvas colors follow the theme
  });

  $("#exportBtn").addEventListener("click", () => {
    if (active < 0 || home) { toast("Open a log first"); return; }
    window.print();
  });
  const pubBtn = $("#publishBtn");
  if (pubBtn) pubBtn.addEventListener("click", () => publish());
  window.addEventListener("beforeprint", () => Charts.setPrintMode(true));
  window.addEventListener("afterprint", () => Charts.setPrintMode(false));

  // ---------- init ----------
  loadPublished().then(refreshHistory);
  render();
})();
