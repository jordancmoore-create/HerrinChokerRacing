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

  function readFile(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = () => reject(new Error("read error"));
      r.readAsArrayBuffer(file);
    });
  }

  // Handle dropped/opened logs one at a time: parse → prompt for race/heat → save + auto-upload.
  async function onFiles(fileList) {
    const files = [...fileList].filter(f => /\.llgx$/i.test(f.name));
    if (!files.length) { toast("Drop .llgx log files"); return; }
    for (const file of files) {
      let buf, log, seg, id;
      try {
        buf = await readFile(file);
        log = LLGX.parse(buf);
        id = contentId(log, file.name);
        // re-dropping a log that already has a hand-placed race window keeps it
        const known = historyMeta.find(m => m.id === id);
        seg = Analysis.segment(log, known && known.race);
      } catch (e) { console.error(e); toast("Couldn't read " + file.name + ": " + e.message); continue; }

      const ex = logs.findIndex(e => e.id === id);
      const entry = { id, name: file.name, log, seg, flags: Analysis.flags(log, seg), kpis: Analysis.kpis(log, seg) };
      if (ex >= 0) logs.splice(ex, 1);
      logs.push(entry);
      active = logs.length - 1; home = false;

      // prompt to confirm race / heat (pre-filled from the log's date) before saving
      const prev = historyMeta.find(m => m.id === id);
      const preset = (prev && prev.cls) || History.classify(History.parseLogTime(log.title, file.name));
      const res = await classifyModal(file.name, preset, prev ? prev.note : "");
      if (res === null) {   // cancelled → drop this log from the session, skip save
        logs.splice(logs.findIndex(e => e.id === id), 1);
        active = logs.length - 1; if (!logs.length) home = true;
        render(); continue;
      }
      saveHistory(id, file, buf, log, seg, res.cls, res.note);
      render();
    }
  }

  // ---------- persistence ----------
  function saveHistory(id, file, bytes, log, seg, clsOverride, noteOverride) {
    const logTime = History.parseLogTime(log.title, file.name);
    const prev = historyMeta.find(m => m.id === id);
    // use the classification chosen at drop; else keep a manual one; else auto-guess
    const cls = clsOverride || (prev && prev.cls && prev.cls.auto === false ? prev.cls : History.classify(logTime));
    const note = noteOverride !== undefined ? noteOverride : ((prev && prev.note) || "");
    const meta = {
      id, name: file.name, size: file.size, added: (prev && prev.added) || Date.now(),
      title: log.title, ecu: log.ecu_model, serial: log.serial,
      duration: log.duration, channels: log.channels.length,
      logTime, cls, note, race: raceMeta(seg, log), official: (prev && prev.official) || null,
      stats: Analysis.summaryStats(log, seg),
    };
    if (DB.available())
      DB.put(meta, bytes).then(refreshHistory).catch(e => console.warn("history save failed", e));
    maybeCloudUpload(meta, bytes);   // auto-save to the shared library if connected
  }

  // load the shared library. The library is private: if the API asks for a
  // passcode, show the gate; if it's unreachable, fall back to the static manifest.
  function loadShared() {
    return Cloud.list().then(res => {
      if (res.status === "ok") { setCloudMeta(res.logs); showGate(false); return; }
      if (res.status === "auth") { publishedMeta = []; showGate(true); return; }
      return loadPublished();   // API unreachable → static-manifest behaviour
    });
  }

  // cloud entries are editable/deletable (having the passcode = full access)
  function setCloudMeta(arr) {
    publishedMeta = arr.map(e => Object.assign({}, e, {
      published: true, cloud: true, editable: true, file: Cloud.fileUrl(e.id),
    }));
  }
  function reloadCloud() {
    return Cloud.list().then(res => { if (res.status === "ok") setCloudMeta(res.logs); });
  }

  // static manifest.json fallback (legacy publish-to-ZIP model)
  function loadPublished() {
    return fetch("manifest.json", { cache: "no-cache" })
      .then(r => (r.ok ? r.json() : null))
      .then(man => { if (man && Array.isArray(man.logs)) publishedMeta = man.logs.map(e => Object.assign({}, e, { published: true })); })
      .catch(() => { });
  }

  // lean metadata the cloud needs (matches the index entry shape)
  function cloudMeta(m) {
    return {
      id: m.id, name: m.name, title: m.title, ecu: m.ecu, serial: m.serial,
      duration: m.duration, channels: m.channels, logTime: m.logTime,
      cls: m.cls, note: m.note || "", race: m.race || null,
      official: m.official || null, stats: m.stats,
    };
  }

  // ---------- official HRL timing ----------
  // We pull logs off the ECU and upload them minutes after a heat, long before
  // the league posts results, so "not there yet" is the normal first answer.
  // Poll on a widening schedule while the log is open, then hand it over to a
  // manual button rather than retrying forever.
  const BOAT = "38", BOAT_CLASS = "F";
  const HRL_SITE = {
    cambridge: "cambridge", sorel: "sorel-tracy", brockville: "brockville",
    valleyfield: "valleyfield", tonawanda: "north-tonawanda", beauharnois: "beauharnois",
  };
  const RETRY_MS = [60e3, 5 * 60e3, 15 * 60e3, 30 * 60e3];
  const official = {};   // logId → { state, tries, timer, msg }

  // HRL's group ids are unpadded local dates: 2026-6-27, not 2026-06-27
  function hrlDate(m) {
    let d = m.logTime ? new Date(m.logTime) : null;
    if (!d && m.cls && m.cls.event) {
      const ev = History.SCHEDULE.find(e => e.id === m.cls.event);
      if (ev) { d = new Date(ev.start + "T12:00:00"); if (m.cls.day === "Sun") d.setDate(d.getDate() + 1); }
    }
    return d ? d.getFullYear() + "-" + (d.getMonth() + 1) + "-" + d.getDate() : "";
  }

  // Adam runs one heat per session, so the heat number picks the Nth of that
  // day's races; "Final" matches on the heat code instead.
  function pickHeat(heats, want) {
    if (!heats || !heats.length) return null;
    if (String(want) === "Final")
      return heats.find(h => /final/i.test(h.heat)) || null;
    const qual = heats.filter(h => !/final/i.test(h.heat));
    const n = +want;
    return (n >= 1 && qual[n - 1]) ? qual[n - 1] : (qual[0] || heats[0]);
  }

  function officialQuery(m) {
    const site = HRL_SITE[m.cls && m.cls.event];
    const date = hrlDate(m);
    if (!site || !date) return null;
    return { site, date, cls: BOAT_CLASS, boat: BOAT };
  }

  function clearOfficial(id) {
    const s = official[id];
    if (s && s.timer) clearTimeout(s.timer);
  }

  // Kick off (or resume) the lookup for the open log.
  function ensureOfficial(e) {
    const m = historyMeta.find(r => r.id === e.id);
    if (!m || !m.cls || m.cls.group !== "race") { renderOfficial(e, null); return; }
    if (m.official) { renderOfficial(e, m.official); return; }
    if (!Cloud.hasKey() || Cloud.isOnline() === false) {
      renderOfficial(e, null, { state: "offline" }); return;
    }
    if (!officialQuery(m)) { renderOfficial(e, null, { state: "unknown" }); return; }
    const s = official[e.id] || (official[e.id] = { tries: 0 });
    if (s.state === "waiting" || s.state === "loading") { renderOfficial(e, null, s); return; }
    fetchOfficial(e, false);
  }

  function fetchOfficial(e, manual) {
    const m = historyMeta.find(r => r.id === e.id);
    const q = m && officialQuery(m);
    if (!q) return;
    const s = official[e.id] || (official[e.id] = { tries: 0 });
    clearOfficial(e.id);
    if (manual) { s.tries = 0; q.fresh = "1"; }
    s.state = "loading";
    renderOfficial(e, null, s);
    Cloud.hrlTime(q).then(res => {
      const cur = logs[active];
      const showing = cur && cur.id === e.id && !home;
      if (res.status === "ok") {
        const hit = pickHeat(res.heats, m.cls.heat);
        if (hit) {
          s.state = "ok";
          saveOfficial(m, Object.assign({ fetchedAt: Date.now() }, hit));
          if (showing) { renderOfficial(e, m.official); renderHeader(e); }
          return;
        }
      }
      s.tries++;
      s.msg = res.status === "error" ? (res.message || "unavailable") : "";
      if (res.status !== "error" && s.tries <= RETRY_MS.length) {
        s.state = "waiting";
        s.next = Date.now() + RETRY_MS[s.tries - 1];
        s.timer = setTimeout(() => {
          const still = logs.find(l => l.id === e.id);
          if (still) fetchOfficial(still, false);
        }, RETRY_MS[s.tries - 1]);
      } else {
        s.state = "gaveup";
      }
      if (showing) renderOfficial(e, null, s);
    });
  }

  function saveOfficial(m, o) {
    m.official = o;
    if (m.cloud) Cloud.update(m.id, { official: o }).then(reloadCloud).then(refreshHistory).catch(() => { });
    else if (DB.available() && !m.published) DB.putMeta(m).then(refreshHistory).catch(() => { });
  }

  function renderOfficial(e, o, s) {
    const el = $("#official");
    if (!el) return;
    if (o) {
      const det = e.seg.raceEnd - e.seg.raceStart;
      const gap = det ? o.time - det : 0;
      const pen = [o.penalty1, o.penalty2].filter(p => p && p !== "0").join(" ");
      el.innerHTML = `<span class="off-tag">Official HRL</span>`
        + `<b>${o.time.toFixed(2)}s</b>`
        + `<span class="off-sub">${o.heat ? esc(o.heat) + " · " : ""}P${o.position} · ${o.laps} laps`
        + `${pen ? " · penalty " + esc(pen) : ""}${o.points ? " · " + esc(o.points) + " pts" : ""}</span>`
        + (det ? `<span class="off-cmp">detected window ${det.toFixed(1)}s `
            + `<i class="${Math.abs(gap) <= 5 ? "ok" : "off"}">${gap >= 0 ? "+" : ""}${gap.toFixed(1)}s</i></span>` : "")
        + `<button class="off-btn" type="button" data-official-refresh>Refresh</button>`;
      return;
    }
    const st = s && s.state;
    if (st === "loading") el.innerHTML = `<span class="off-tag">Official HRL</span><span class="off-sub">checking…</span>`;
    else if (st === "waiting") el.innerHTML = `<span class="off-tag">Official HRL</span>`
      + `<span class="off-sub">not posted yet — checking again shortly (try ${s.tries} of ${RETRY_MS.length})</span>`
      + `<button class="off-btn" type="button" data-official-refresh>Check now</button>`;
    else if (st === "gaveup" || st === "unknown") el.innerHTML = `<span class="off-tag">Official HRL</span>`
      + `<span class="off-sub">${s && s.msg ? esc(s.msg) : "no result posted"}</span>`
      + `<button class="off-btn" type="button" data-official-refresh>Fetch time</button>`;
    else el.innerHTML = "";
  }

  document.addEventListener("click", ev => {
    if (!ev.target.closest("[data-official-refresh]")) return;
    if (active < 0 || home) return;
    const e = logs[active];
    const m = historyMeta.find(r => r.id === e.id);
    if (m) m.official = null;
    fetchOfficial(e, true);
  });

  // logDur pins the window to the timebase it was placed against, so it survives
  // a change in how the log's clock is derived
  const raceMeta = (seg, log) => ({
    start: seg.raceStart, end: seg.raceEnd, auto: seg.auto !== false, logDur: log.duration,
  });

  // Handles moved on a chart: the race window drives the KPI tiles, the Concerns
  // and the cross-log trends, so recompute all of it, then save the window to the
  // shared library so the rest of the team opens the log on the same boundaries.
  function onRaceWindow() {
    if (active < 0 || home) return;
    const e = logs[active];
    e.kpis = Analysis.kpis(e.log, e.seg);
    e.flags = Analysis.flags(e.log, e.seg);
    renderHeader(e); renderKpis(e); renderFlags(e);
    const m = historyMeta.find(r => r.id === e.id);
    if (!m) return;
    if (m.official) renderOfficial(e, m.official);   // the +/- vs the window just moved
    m.race = raceMeta(e.seg, e.log);
    m.stats = Analysis.summaryStats(e.log, e.seg);
    clearTimeout(onRaceWindow._t);
    onRaceWindow._t = setTimeout(() => {
      // entries from the static manifest are read-only — saving them locally would
      // shadow the published copy with a meta record that has no file behind it
      const local = (DB.available() && !m.cloud && !m.published) ? DB.putMeta(m) : Promise.resolve();
      const cloud = m.cloud ? Cloud.update(m.id, { race: m.race, stats: m.stats }).then(reloadCloud) : Promise.resolve();
      Promise.all([local, cloud])
        .then(() => { refreshHistory(); renderTrends(e); })
        .catch(err => toast(err.message === "passcode" ? "Connect (☁) to save the race window" : "Couldn't save window: " + err.message));
    }, 600);
  }

  // auto-save a freshly-dropped log to the shared library when connected
  function maybeCloudUpload(meta, bytes) {
    if (!Cloud.hasKey() || Cloud.isOnline() === false) return;
    Cloud.upload(cloudMeta(meta), bytes)
      .then(() => reloadCloud())
      .then(() => { refreshHistory(); toast("Saved to shared library ☁"); })
      .catch(err => {
        if (err.message === "passcode") { Cloud.setKey(""); toast("Upload rejected — wrong passcode"); reloadCloud().then(refreshHistory); }
        else toast("Cloud save failed: " + err.message);
      });
  }

  function refreshHistory() {
    const localP = DB.available() ? DB.allMeta() : Promise.resolve([]);
    return localP.then(localList => {
      const connected = Cloud.hasKey() && Cloud.isOnline() !== false;
      let merged;
      if (connected) {
        const cloudIds = new Set(publishedMeta.map(p => p.id));   // shared library wins when connected
        merged = publishedMeta.concat(localList.filter(m => !cloudIds.has(m.id)));
      } else {
        const localIds = new Set(localList.map(m => m.id));        // local wins offline / for viewers
        merged = localList.concat(publishedMeta.filter(p => !localIds.has(p.id)));
      }
      historyMeta = merged;
      document.body.classList.toggle("has-local", localList.length > 0);
      History.render($("#history"), historyMeta, handlers);
    }).catch(e => console.warn("history load failed", e));
  }

  const handlers = {
    open: openFromHistory,
    del: id => {
      const m = historyMeta.find(r => r.id === id);
      const local = DB.available() ? DB.del(id) : Promise.resolve();
      const cloud = (m && m.cloud) ? Cloud.remove(id).then(reloadCloud) : Promise.resolve();
      Promise.all([local, cloud]).then(refreshHistory)
        .catch(e => toast(e.message === "passcode" ? "Connect (☁) to delete shared logs" : "Delete failed: " + e.message));
    },
    clear: () => { if (confirm("Remove all locally-saved logs? (Shared library is not affected.)")) DB.clear().then(refreshHistory); },
    reassign: (id, cls, note) => {
      const m = historyMeta.find(r => r.id === id);
      if (!m) return;
      m.cls = cls;
      if (note !== undefined) m.note = note;
      const local = DB.available() && !m.cloud ? DB.putMeta(m) : Promise.resolve();
      const cloud = m.cloud ? Cloud.update(id, { cls, note: m.note }).then(reloadCloud) : Promise.resolve();
      Promise.all([local, cloud]).then(refreshHistory)
        .catch(e => toast(e.message === "passcode" ? "Connect (☁) to edit shared logs" : "Update failed: " + e.message));
    },
  };

  function openFromHistory(id) {
    const ex = logs.findIndex(e => e.id === id);
    if (ex >= 0) { active = ex; home = false; render(); return; }
    const m = historyMeta.find(r => r.id === id) || {};
    const fetchIt = r => { if (!r.ok) throw new Error("file not found"); return r.arrayBuffer(); };
    const source = m.cloud
      ? Cloud.fetchFile(id).then(fetchIt)                      // private R2 file (sends passcode)
      : (m.published && m.file)
        ? fetch(m.file).then(fetchIt)                          // legacy static file
        : DB.getBytes(id);
    Promise.resolve(source).then(bytes => {
      if (!bytes) { toast("Saved file missing"); return; }
      const log = LLGX.parse(bytes);
      const seg = Analysis.segment(log, m.race);
      logs.push({ id, name: m.name || log.title, log, seg, flags: Analysis.flags(log, seg), kpis: Analysis.kpis(log, seg) });
      active = logs.length - 1; home = false; render();
    }).catch(e => toast("Couldn't open: " + e.message));
  }

  // ---------- classify-on-drop modal (race / heat) ----------
  // Shown for each dropped log; pre-filled from the log's date. Resolves to
  // { cls, note } on save, or null on cancel.
  function classifyModal(fileName, preset, presetNote) {
    return new Promise(resolve => {
      const cls0 = preset || { group: "race" };
      let group = cls0.group === "race" ? "race" : "testing";
      const opt = (v, sel, label) => `<option value="${v}"${sel ? " selected" : ""}>${label || v}</option>`;
      const evOpts = History.SCHEDULE.map(e => opt(e.id, cls0.event === e.id, e.name)).join("");
      const dayOpts = ["Fri", "Sat", "Sun"].map(d => opt(d, cls0.day === d)).join("");
      const heatOpts = History.HEAT_OPTIONS.map(h => opt(h, String(cls0.heat) === String(h), History.heatName(h))).join("");

      const m = el("div", "modal open");
      m.innerHTML = `<div class="modal-card">
          <div class="modal-logo">38</div>
          <div class="modal-title">New log — classify it</div>
          <div class="modal-file">${esc(shortName(fileName))}</div>
          <div class="seg-toggle" id="segToggle">
            <button type="button" data-g="race" class="${group === "race" ? "on" : ""}">🏁 Race</button>
            <button type="button" data-g="testing" class="${group === "testing" ? "on" : ""}">🔧 Testing</button>
          </div>
          <div class="modal-fields" id="raceFields" style="${group === "race" ? "" : "display:none"}">
            <label>Event<select data-f="event">${evOpts}</select></label>
            <div class="modal-row">
              <label>Day<select data-f="day">${dayOpts}</select></label>
              <label>Heat<select data-f="heat">${heatOpts}</select></label>
            </div>
          </div>
          <input class="note-input" data-f="note" type="text" maxlength="120"
            placeholder="Note (optional) — e.g. Blowover lap 1; DNS" value="${esc(presetNote || "")}">
          <button class="modal-save" type="button">Save &amp; upload ☁</button>
          <button class="modal-cancel" type="button">Cancel</button>
        </div>`;
      document.body.appendChild(m);
      document.body.classList.add("modal-open");

      const raceFields = m.querySelector("#raceFields");
      m.querySelector("#segToggle").addEventListener("click", e => {
        const b = e.target.closest("[data-g]"); if (!b) return;
        group = b.getAttribute("data-g");
        m.querySelectorAll("#segToggle button").forEach(x => x.classList.toggle("on", x === b));
        raceFields.style.display = group === "race" ? "" : "none";
      });
      const close = val => { m.remove(); document.body.classList.remove("modal-open"); resolve(val); };
      m.querySelector(".modal-cancel").onclick = () => close(null);
      m.querySelector(".modal-save").onclick = () => {
        const cls = group === "race"
          ? { group: "race", event: m.querySelector('[data-f="event"]').value, day: m.querySelector('[data-f="day"]').value, heat: History.parseHeat(m.querySelector('[data-f="heat"]').value), auto: false }
          : { group: "testing", auto: false };
        close({ cls, note: (m.querySelector('[data-f="note"]').value || "").trim() });
      };
      setTimeout(() => m.querySelector(".modal-save").focus(), 50);
    });
  }

  // ---------- render ----------
  let viewMode = localStorage.getItem("log-view") === "readout" ? "readout" : "charts";

  function render() {
    document.body.classList.toggle("has-logs", logs.length > 0);
    document.body.classList.toggle("home", home || active < 0);
    renderTabs();
    if (active >= 0 && !home) {
      const e = logs[active];
      renderHeader(e); renderKpis(e); renderFlags(e); renderTrends(e); ensureOfficial(e);
      renderView(e);
    }
  }

  // Charts (trends) vs Readout (point-in-time) toggle, above the charts.
  function renderView(e) {
    const t = $("#viewToggle");
    if (t) t.innerHTML =
      `<button class="vt-btn${viewMode === "charts" ? " on" : ""}" data-view="charts">📈 Charts</button>
       <button class="vt-btn${viewMode === "readout" ? " on" : ""}" data-view="readout">🎯 Readout</button>`;
    const charts = $("#charts"), readout = $("#readout");
    if (viewMode === "readout") {
      charts.style.display = "none"; readout.style.display = "block";
      Charts.buildReadout(e.log, e.seg, readout);
    } else {
      readout.style.display = "none"; charts.style.display = "";
      Charts.build(e.log, e.seg, charts, onRaceWindow);
    }
  }
  document.addEventListener("click", ev => {
    const b = ev.target.closest("#viewToggle [data-view]"); if (!b) return;
    const v = b.getAttribute("data-view");
    if (v === viewMode || active < 0 || home) return;
    viewMode = v; localStorage.setItem("log-view", v);
    renderView(logs[active]);
  });

  function renderTabs() {
    const tabs = $("#tabs"); tabs.innerHTML = "";
    logs.forEach((e, i) => {
      const t = el("button", "tab" + (i === active && !home ? " active" : ""), esc(shortName(e.name)));
      t.onclick = () => { active = i; home = false; render(); };
      const x = el("span", "tab-x", "×");
      x.onclick = ev => { ev.stopPropagation(); clearOfficial(e.id); delete official[e.id]; logs.splice(i, 1); if (active >= logs.length) active = logs.length - 1; if (!logs.length) home = true; render(); };
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
    const s = e.seg, ms = t => Math.floor(t / 60) + ":" + String(Math.round(t % 60)).padStart(2, "0");
    let tl = `<span class="seg-dot"></span>Engine start ~${s.start.toFixed(0)}s`;
    if (s.raceEnd > s.raceStart) {
      tl += `&nbsp;·&nbsp;Race ${s.raceStart.toFixed(0)}–${s.raceEnd.toFixed(0)}s (${ms(s.raceEnd - s.raceStart)})`
          + (s.auto === false ? ` <span class="muted">· window set by hand</span>` : "");
      if (s.nLaps > 1)
        tl += `&nbsp;·&nbsp;<span class="muted">${s.nLaps} laps, ~${s.lap.toFixed(0)}s each `
            + `(${s.turns.length} turns detected)</span>`;
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

  // Cross-log trends — compares the open log against the rest of the library of
  // the SAME type (race↔race, testing↔testing). Hidden until there are ≥2 to compare.
  function renderTrends(e) {
    const sec = $("#trends"), lab = $("#flagsLabel");
    if (!sec) return;
    const cm = historyMeta.find(m => m.id === e.id);
    const grp = cm && cm.cls && cm.cls.group === "race" ? "race" : "testing";
    const comparable = historyMeta
      .filter(m => m.stats && (m.cls && m.cls.group === "race" ? "race" : "testing") === grp)
      .sort((a, b) => (a.logTime || a.added || a.uploadedAt || 0) - (b.logTime || b.added || b.uploadedAt || 0));
    const res = Analysis.trends(comparable, e.id);

    if (!res.enough) {   // nothing to compare against → keep the single-run view clean
      sec.style.display = "none"; sec.innerHTML = "";
      if (lab) lab.style.display = "none";
      return;
    }
    if (lab) lab.style.display = "block";
    const type = grp === "race" ? "race" : "testing";
    const rows = res.items.length
      ? res.items.map(t => `<div class="trend-row trend-${t.sev}"><span class="tr-ic">${t.ic}</span>
          <div><span class="trend-tag">${esc(t.tag)}</span><span class="trend-msg">${esc(t.msg)}</span></div></div>`).join("")
      : `<div class="trend-row trend-ok"><span class="tr-ic">✓</span><div><span class="trend-msg">No adverse trends across your last ${res.n} ${type} runs.</span></div></div>`;
    sec.style.display = "block";
    sec.innerHTML = `<div class="scope-label">Across your last ${res.n} ${type} logs · the bigger picture</div>${rows}`;
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

  // ---------- passcode gate (private shared library) ----------
  let gateEl = null, gateShown = false;
  function buildGate() {
    const g = el("div", "gate"); g.id = "gate";
    g.innerHTML = `<div class="gate-card">
        <div class="gate-logo">38</div>
        <div class="gate-title">Go Fast Logs</div>
        <div class="gate-sub">Herrin Choker Racing #38 · private log library</div>
        <input id="gateInput" type="password" placeholder="Team passcode" autocomplete="current-password" spellcheck="false">
        <button id="gateBtn" type="button">Unlock</button>
        <div class="gate-err" id="gateErr"></div>
      </div>`;
    document.body.appendChild(g);
    const input = g.querySelector("#gateInput"), err = g.querySelector("#gateErr"), btn = g.querySelector("#gateBtn");
    const submit = () => {
      const v = input.value.trim(); if (!v) return;
      err.textContent = ""; btn.disabled = true;
      Cloud.setKey(v);
      loadShared().then(() => {
        btn.disabled = false;
        if (!gateShown) { input.value = ""; refreshHistory().then(updateCloudBtn); render(); }  // unlocked
        else { Cloud.setKey(""); err.textContent = "Wrong passcode — try again."; input.select(); }
      });
    };
    btn.onclick = submit;
    input.addEventListener("keydown", e => { if (e.key === "Enter") submit(); });
    gateEl = g;
  }
  function showGate(show) {
    gateShown = show;
    if (show && !gateEl) buildGate();
    if (gateEl) gateEl.classList.toggle("open", show);
    document.body.classList.toggle("gated", show);
    if (show && gateEl) setTimeout(() => gateEl.querySelector("#gateInput").focus(), 60);
  }

  // topbar cloud button: shows state; click locks the library on this device
  function updateCloudBtn() {
    const b = $("#cloudBtn"); if (!b) return;
    const off = Cloud.isOnline() === false;
    const label = off ? "offline" : (Cloud.hasKey() ? "connected" : "locked");
    const bl = b.querySelector(".bl");
    if (bl) bl.textContent = label; else b.textContent = "☁ " + label;
    b.classList.toggle("on", Cloud.hasKey() && !off);
    b.title = off ? "Shared library not reachable" : "Connected to the shared library. Click to lock on this device.";
  }
  const cloudBtn = $("#cloudBtn");
  if (cloudBtn) cloudBtn.addEventListener("click", () => {
    if (Cloud.isOnline() === false) { toast("Shared library not reachable"); return; }
    if (!Cloud.hasKey()) { showGate(true); return; }
    if (confirm("Lock the shared library on this device? You'll need the team passcode to view it again.")) {
      Cloud.setKey(""); publishedMeta = [];
      updateCloudBtn(); refreshHistory(); showGate(true);
    }
  });
  window.addEventListener("beforeprint", () => Charts.setPrintMode(true));
  window.addEventListener("afterprint", () => Charts.setPrintMode(false));

  // fuel-pressure unit toggle (PSI ⇄ kPa): recompute the open log's flags/KPIs + refresh
  window.addEventListener("fuelunitchange", () => {
    if (active >= 0) {
      const e = logs[active];
      e.kpis = Analysis.kpis(e.log, e.seg);
      e.flags = Analysis.flags(e.log, e.seg);
    }
    refreshHistory();
    render();
  });

  // ---------- init ----------
  loadShared().then(refreshHistory).then(updateCloudBtn);
  render();
})();
