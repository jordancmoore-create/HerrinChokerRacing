/* history.js — log library: 2026 HRL schedule, auto-classification (testing vs
   race → event → day → heat), grouped collapsible tree, and historical stats. */
(function (global) {
  "use strict";

  // 2026 HRL season calendar (hrlhydroplane.com/en/calendrier/). Dates inclusive.
  const SCHEDULE = [
    { id: "cambridge",   name: "Cambridge",       loc: "MD, USA", start: "2026-05-23", end: "2026-05-24" },
    { id: "sorel",       name: "Sorel-Tracy",     loc: "QC",      start: "2026-06-06", end: "2026-06-07" },
    { id: "brockville",  name: "Brockville",      loc: "ON",      start: "2026-06-27", end: "2026-06-28" },
    { id: "valleyfield", name: "Valleyfield",     loc: "QC",      start: "2026-07-10", end: "2026-07-12" },
    { id: "tonawanda",   name: "North Tonawanda", loc: "NY, USA", start: "2026-08-01", end: "2026-08-02" },
    { id: "beauharnois", name: "Beauharnois",     loc: "QC",      start: "2026-08-22", end: "2026-08-23" },
  ];
  const HEAT_CUTOFF_HR = 13;   // before 1pm → Heat 1, else Heat 2 (auto-guess)
  const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  const eventById = id => SCHEDULE.find(e => e.id === id) || null;

  // parse the log's datetime from its title/name → epoch ms (or null)
  function parseLogTime(title, name) {
    const src = (title || "") + " " + (name || "");
    const m = src.match(/(\d{4})-(\d{2})-(\d{2})\s+(\d{1,2})[;:_](\d{2})[;:_](\d{2})\s*([ap]m)?/i);
    if (!m) return null;
    let h = +m[4]; const ap = (m[7] || "").toLowerCase();
    if (ap === "pm" && h < 12) h += 12;
    if (ap === "am" && h === 12) h = 0;
    return new Date(+m[1], +m[2] - 1, +m[3], h, +m[5], +m[6]).getTime();
  }

  function ymd(d) {
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  }

  // auto-classification from a log timestamp (a SUGGESTION; user can override)
  function classify(logTime) {
    if (!logTime) return { group: "testing", auto: true };
    const d = new Date(logTime), ds = ymd(d);
    for (const ev of SCHEDULE)
      if (ds >= ev.start && ds <= ev.end)
        return { group: "race", event: ev.id, day: DOW[d.getDay()], heat: d.getHours() < HEAT_CUTOFF_HR ? 1 : 2, auto: true };
    return { group: "testing", auto: true };
  }

  function clsLabel(cls) {
    if (!cls || cls.group !== "race") return "Testing";
    const ev = eventById(cls.event);
    return (ev ? ev.name : "Race") + " · " + (cls.day || "?") + " · H" + (cls.heat || "?");
  }

  function fmtDateRange(ev) {
    const s = new Date(ev.start + "T00:00"), e = new Date(ev.end + "T00:00");
    const mon = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    return mon[s.getMonth()] + " " + s.getDate() + "–" + e.getDate();
  }

  // ---- aggregate stats across a set of records ----
  function aggregate(records) {
    const withStats = records.filter(r => r.stats);
    const agg = (key, fn) => {
      const vals = withStats.map(r => r.stats[key]).filter(v => typeof v === "number" && isFinite(v));
      if (!vals.length) return null;
      return fn(vals);
    };
    const sum = a => a.reduce((x, y) => x + y, 0);
    const mean = a => sum(a) / a.length;
    return {
      count: records.length,
      runtimeMin: agg("durationMin", sum) || 0,
      peakRpm: agg("peakRpm", a => Math.max(...a)),
      peakIdc: agg("peakIdc", a => Math.max(...a)),
      coolantAvg: agg("coolantAvg", mean),
      minFuelP: agg("minFuelPLoad", a => Math.min(...a)),
      vtecRpm: agg("vtecRpm", mean),
      maxIgn: agg("maxIgn", a => Math.max(...a)),
      voltMin: agg("voltMin", a => Math.min(...a)),
      faults: withStats.filter(r => r.stats.vtecFault).length,
    };
  }

  // ---- rendering ----
  function esc(s) { return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
  function shortName(n) { return String(n || "").replace(/^ECU Log /, "").replace(/\.llgx$/i, ""); }

  function card(r) {
    const dt = r.logTime ? new Date(r.logTime).toLocaleString() : new Date(r.added).toLocaleString();
    const st = r.stats || {};
    const chips = [];
    if (st.peakRpm) chips.push(`${Math.round(st.peakRpm).toLocaleString()} rpm`);
    if (st.peakIdc != null) chips.push(`${st.peakIdc.toFixed(0)}% IDC`);
    if (st.coolantAvg != null) chips.push(`${st.coolantAvg.toFixed(0)}°C`);
    const note = r.note ? `<div class="hist-note">📝 ${esc(r.note)}</div>` : "";
    const ro = !!r.published;
    const delBtn = ro ? "" : `<button class="hist-del" data-del="${esc(r.id)}" title="Remove">×</button>`;
    const tag = ro
      ? `<span class="hist-tag ro">${esc(clsLabel(r.cls))}</span>`
      : `<button class="hist-tag" data-edit="${esc(r.id)}">${esc(clsLabel(r.cls))} ✎</button>`;
    return `<div class="hist-card${ro ? " published" : ""}" data-id="${esc(r.id)}">
      ${delBtn}
      <div class="hist-title">${esc(shortName(r.name))}</div>
      <div class="hist-meta">${esc((r.duration / 60).toFixed(1))} min · ${esc(r.channels)} ch · ${chips.join(" · ")}</div>
      <div class="hist-date">${esc(dt)}</div>
      ${note}
      ${tag}
    </div>`;
  }

  function cardsGrid(records) {
    return `<div class="history-grid">${records.map(card).join("")}</div>`;
  }

  function statBlock(label, value, unit) {
    return `<div class="hstat"><div class="hstat-label">${label}</div>
      <div class="hstat-value">${value == null ? "–" : value}<span>${unit || ""}</span></div></div>`;
  }

  function renderStats(records) {
    const a = aggregate(records);
    const cells = [
      statBlock("Logs", a.count, ""),
      statBlock("Total runtime", a.runtimeMin != null ? a.runtimeMin.toFixed(0) : "–", "min"),
      statBlock("Highest IDC", a.peakIdc != null ? a.peakIdc.toFixed(1) : "–", "%"),
      statBlock("Top RPM", a.peakRpm != null ? Math.round(a.peakRpm).toLocaleString() : "–", ""),
      statBlock("Avg coolant", a.coolantAvg != null ? a.coolantAvg.toFixed(0) : "–", "°C"),
      statBlock("Lowest fuel P", a.minFuelP != null ? a.minFuelP.toFixed(0) : "–", "kPa"),
      statBlock("Avg VTEC pt", a.vtecRpm != null ? Math.round(a.vtecRpm).toLocaleString() : "–", "rpm"),
      statBlock("Min voltage", a.voltMin != null ? a.voltMin.toFixed(1) : "–", "V"),
    ];
    return `<div class="hstats-grid">${cells.join("")}</div>`;
  }

  function details(summary, inner, open, cls) {
    return `<details class="${cls || ""}" ${open ? "open" : ""}><summary>${summary}</summary>${inner}</details>`;
  }

  // build the grouped, collapsible library
  function render(container, records, handlers) {
    if (!records.length) { container.innerHTML = ""; container.style.display = "none"; return; }
    container.style.display = "";
    records = records.slice().sort((a, b) => (b.logTime || b.added) - (a.logTime || a.added));

    const testing = records.filter(r => !r.cls || r.cls.group !== "race");
    const racing = records.filter(r => r.cls && r.cls.group === "race");

    // stats: overall + testing vs race split
    let html = `<div class="history-head"><h2>Historical stats</h2>
      <button class="link-btn" data-clear="1">Clear all</button></div>`;
    html += renderStats(records);
    html += `<div class="hstats-split">
       <div class="hsplit"><span class="hsplit-h">Races</span>${miniStats(aggregate(racing))}</div>
       <div class="hsplit"><span class="hsplit-h">Testing</span>${miniStats(aggregate(testing))}</div></div>`;

    // library tree
    html += `<div class="history-head" style="margin-top:18px"><h2>Log library</h2></div>`;

    // races grouped by event → day → heat
    let racesInner = "";
    SCHEDULE.forEach(ev => {
      const evRecs = racing.filter(r => r.cls.event === ev.id);
      if (!evRecs.length) return;
      const days = groupBy(evRecs, r => r.cls.day || "?");
      let daysHtml = "";
      Object.keys(days).sort(daySort).forEach(day => {
        const heats = groupBy(days[day], r => "H" + (r.cls.heat || "?"));
        let heatsHtml = "";
        Object.keys(heats).sort().forEach(h => {
          heatsHtml += details(`Heat ${h.replace("H", "")} <b>(${heats[h].length})</b>`, cardsGrid(heats[h]), true, "lvl-heat");
        });
        daysHtml += details(`${dayFull(day)} <b>(${days[day].length})</b>`, heatsHtml, true, "lvl-day");
      });
      racesInner += details(`${ev.name} <span class="ev-date">${fmtDateRange(ev)}</span> <b>(${evRecs.length})</b>`, daysHtml, true, "lvl-event");
    });
    html += details(`🏁 Races <b>(${racing.length})</b>`, racesInner || '<div class="muted pad">No race logs yet.</div>', true, "lvl-top");
    html += details(`🔧 Testing <b>(${testing.length})</b>`, cardsGrid(testing) || '<div class="muted pad">No testing logs.</div>', testing.length <= racing.length, "lvl-top");

    container.innerHTML = html;
    wire(container, handlers, records);
  }

  function miniStats(a) {
    if (!a.count) return `<span class="muted">—</span>`;
    const bits = [`${a.count} logs`, `${(a.runtimeMin || 0).toFixed(0)} min`];
    if (a.peakIdc != null) bits.push(`IDC ${a.peakIdc.toFixed(0)}%`);
    if (a.coolantAvg != null) bits.push(`${a.coolantAvg.toFixed(0)}°C`);
    if (a.faults) bits.push(`${a.faults} fault${a.faults > 1 ? "s" : ""}`);
    return bits.join(" · ");
  }

  function groupBy(arr, fn) {
    const o = {};
    arr.forEach(x => { const k = fn(x); (o[k] = o[k] || []).push(x); });
    return o;
  }
  const DAY_ORDER = { Fri: 0, Sat: 1, Sun: 2, Mon: 3, Tue: 4, Wed: 5, Thu: 6 };
  function daySort(a, b) { return (DAY_ORDER[a] ?? 9) - (DAY_ORDER[b] ?? 9); }
  function dayFull(d) { return ({ Fri: "Friday", Sat: "Saturday", Sun: "Sunday", Mon: "Monday", Tue: "Tuesday", Wed: "Wednesday", Thu: "Thursday" })[d] || d; }

  // reassignment editor (inline popover)
  function editor(rec) {
    const cls = rec.cls || { group: "testing" };
    const evOpts = SCHEDULE.map(e => `<option value="${e.id}" ${cls.event === e.id ? "selected" : ""}>${e.name}</option>`).join("");
    const dayOpts = ["Fri", "Sat", "Sun"].map(d => `<option ${cls.day === d ? "selected" : ""}>${d}</option>`).join("");
    const heatOpts = [1, 2].map(h => `<option value="${h}" ${(+cls.heat) === h ? "selected" : ""}>Heat ${h}</option>`).join("");
    const isRace = cls.group === "race";
    return `<div class="hist-editor" data-for="${esc(rec.id)}">
      <select data-f="group">
        <option value="testing" ${!isRace ? "selected" : ""}>Testing</option>
        <option value="race" ${isRace ? "selected" : ""}>Race</option>
      </select>
      <span class="race-fields" style="${isRace ? "" : "display:none"}">
        <select data-f="event">${evOpts}</select>
        <select data-f="day">${dayOpts}</select>
        <select data-f="heat">${heatOpts}</select>
      </span>
      <input class="note-input" data-f="note" type="text" maxlength="120"
        placeholder="Note / context — e.g. Blowover, crash lap 1; DNS, boat wouldn't start"
        value="${esc(rec.note || "")}">
      <button class="mini-btn" data-save="${esc(rec.id)}">Save</button>
      <button class="mini-btn ghost" data-cancel="1">Cancel</button>
    </div>`;
  }

  function wire(container, handlers, records) {
    const byId = id => records.find(r => r.id === id);

    container.onclick = e => {
      const clearBtn = e.target.closest("[data-clear]");
      if (clearBtn) { handlers.clear(); return; }
      const del = e.target.closest("[data-del]");
      if (del) { e.stopPropagation(); handlers.del(del.getAttribute("data-del")); return; }
      const edit = e.target.closest("[data-edit]");
      if (edit) {
        e.stopPropagation();
        const cardEl = edit.closest(".hist-card");
        if (cardEl.querySelector(".hist-editor")) return;
        const rec = byId(edit.getAttribute("data-edit"));
        edit.insertAdjacentHTML("afterend", editor(rec));
        return;
      }
      const cancel = e.target.closest("[data-cancel]");
      if (cancel) { const ed = cancel.closest(".hist-editor"); if (ed) ed.remove(); return; }
      const save = e.target.closest("[data-save]");
      if (save) {
        const ed = save.closest(".hist-editor");
        const g = ed.querySelector('[data-f="group"]').value;
        let cls;
        if (g === "race") cls = { group: "race", event: ed.querySelector('[data-f="event"]').value, day: ed.querySelector('[data-f="day"]').value, heat: +ed.querySelector('[data-f="heat"]').value, auto: false };
        else cls = { group: "testing", auto: false };
        const note = (ed.querySelector('[data-f="note"]').value || "").trim();
        handlers.reassign(save.getAttribute("data-save"), cls, note);
        return;
      }
      const openCard = e.target.closest(".hist-card");
      if (openCard && !e.target.closest(".hist-editor")) handlers.open(openCard.getAttribute("data-id"));
    };

    container.addEventListener("change", e => {
      const grp = e.target.closest('[data-f="group"]');
      if (grp) {
        const rf = grp.parentElement.querySelector(".race-fields");
        if (rf) rf.style.display = grp.value === "race" ? "" : "none";
      }
    });
  }

  global.History = { SCHEDULE, parseLogTime, classify, clsLabel, render, aggregate };
})(window);
