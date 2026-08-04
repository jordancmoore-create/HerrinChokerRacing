/* charts.js — stacked, synced uPlot time-series for telemetry. */
(function (global) {
  "use strict";

  const PLOT = [
    { name: "Engine Speed", color: "#38bdf8" },
    { name: "TPS (Main)", color: "#34d399" },
    { name: "Injector Duty Cycle", color: "#f87171", threshold: { v: 90, label: "Link 90% limit" } },
    { name: "Fuel Pressure", color: "#c084fc" },
    { name: "MAP", color: "#22d3ee" },
    { name: "Ignition Angle", color: "#fbbf24" },
    { name: "AFR/Lambda Target", color: "#a3e635" },
    { name: "Lambda 1", color: "#fb7185" },
    { name: "Batt Voltage", color: "#818cf8" },
    { name: "ECT", color: "#2dd4bf" },
    { name: "IAT", color: "#f472b6" },
  ];
  const UNIT_FIX = { Pressure: "kPa", Temperature: "°C" };

  function interp(ch, grid) {
    const t = ch.times, v = ch.values, out = new Float64Array(grid.length);
    let j = 0, n = t.length;
    for (let i = 0; i < grid.length; i++) {
      const g = grid[i];
      while (j + 1 < n && t[j + 1] <= g) j++;
      if (j + 1 < n && t[j + 1] !== t[j]) {
        let f = (g - t[j]) / (t[j + 1] - t[j]); f = f < 0 ? 0 : f > 1 ? 1 : f;
        out[i] = v[j] + f * (v[j + 1] - v[j]);
      } else out[i] = v[j] || 0;
    }
    return out;
  }

  // plugin: shade the race window + lap dividers + optional threshold line (behind series)
  function bgPlugin(threshold) {
    return {
      hooks: {
        drawClear: u => {
          const ctx = u.ctx;
          if (win.t1 > win.t0) {
            const L = u.bbox.left, R = u.bbox.left + u.bbox.width;
            const clamp = x => x < L ? L : x > R ? R : x;
            const x0 = clamp(u.valToPos(win.t0, "x", true)), x1 = clamp(u.valToPos(win.t1, "x", true));
            ctx.save();
            ctx.fillStyle = cssVar("--chart-shade", "rgba(160,160,170,0.07)");
            ctx.fillRect(x0, u.bbox.top, x1 - x0, u.bbox.height);
            if (win.bounds.length > 2) {
              ctx.strokeStyle = cssVar("--chart-lap", "rgba(148,163,184,0.4)");
              ctx.lineWidth = 1; ctx.setLineDash([3, 4]);
              for (let i = 1; i < win.bounds.length - 1; i++) {
                const x = u.valToPos(win.bounds[i], "x", true);
                if (x < L || x > R) continue;
                ctx.beginPath(); ctx.moveTo(x, u.bbox.top); ctx.lineTo(x, u.bbox.top + u.bbox.height); ctx.stroke();
              }
            }
            ctx.restore();
          }
          if (threshold != null) {
            const y = u.valToPos(threshold, "y", true);
            if (y >= u.bbox.top && y <= u.bbox.top + u.bbox.height) {
              ctx.save();
              ctx.strokeStyle = "rgba(248,113,113,0.6)"; ctx.lineWidth = 1; ctx.setLineDash([4, 3]);
              ctx.beginPath(); ctx.moveTo(u.bbox.left, y); ctx.lineTo(u.bbox.left + u.bbox.width, y); ctx.stroke();
              ctx.restore();
            }
          }
        }
      }
    };
  }

  function gradientFill(color) {
    return (u, sidx) => {
      const ctx = u.ctx;
      const g = ctx.createLinearGradient(0, u.bbox.top, 0, u.bbox.top + u.bbox.height);
      g.addColorStop(0, hexA(color, 0.28));
      g.addColorStop(1, hexA(color, 0.01));
      return g;
    };
  }
  function hexA(hex, a) {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  }

  // contiguous [start,end] time intervals where pred(value) holds
  function intervalsOf(ch, pred) {
    const out = []; let s = null;
    for (let i = 0; i < ch.values.length; i++) {
      if (pred(ch.values[i])) { if (s === null) s = ch.times[i]; }
      else if (s !== null) { out.push([s, ch.times[i]]); s = null; }
    }
    if (s !== null) out.push([s, ch.times[ch.times.length - 1]]);
    return out;
  }

  // shade VTEC-active (green) and VTEC-fault (red) intervals across a panel
  function vtecPlugin(active, fault) {
    return { hooks: { drawClear: u => {
      const ctx = u.ctx;
      const fill = (iv, color) => {
        ctx.save(); ctx.fillStyle = color;
        iv.forEach(([a, b]) => {
          const x0 = u.valToPos(a, "x", true), x1 = u.valToPos(b, "x", true);
          ctx.fillRect(x0, u.bbox.top, Math.max(1, x1 - x0), u.bbox.height);
        });
        ctx.restore();
      };
      fill(active, "rgba(52,211,153,0.12)");
      fill(fault, "rgba(248,113,113,0.22)");
    } } };
  }

  // shade a target value band (green) + a "too low" dashed line on a panel
  function zonePlugin(lo, hi, lowLine) {
    return { hooks: { drawClear: u => {
      const ctx = u.ctx;
      const yLo = u.valToPos(lo, "y", true), yHi = u.valToPos(hi, "y", true);
      ctx.save();
      ctx.fillStyle = "rgba(52,211,153,0.10)";
      ctx.fillRect(u.bbox.left, yHi, u.bbox.width, yLo - yHi);
      if (lowLine != null) {
        const yc = u.valToPos(lowLine, "y", true);
        if (yc >= u.bbox.top && yc <= u.bbox.top + u.bbox.height) {
          ctx.strokeStyle = "rgba(251,191,36,0.7)"; ctx.lineWidth = 1; ctx.setLineDash([4, 3]);
          ctx.beginPath(); ctx.moveTo(u.bbox.left, yc); ctx.lineTo(u.bbox.left + u.bbox.width, yc); ctx.stroke();
        }
      }
      ctx.restore();
    } } };
  }

  // green target band between lo..hi with dashed boundary lines (display units)
  function bandZone(lo, hi) {
    return { hooks: { drawClear: u => {
      const ctx = u.ctx;
      const yLo = u.valToPos(lo, "y", true), yHi = u.valToPos(hi, "y", true);
      ctx.save();
      ctx.fillStyle = "rgba(52,211,153,0.12)";
      ctx.fillRect(u.bbox.left, yHi, u.bbox.width, yLo - yHi);
      ctx.strokeStyle = "rgba(52,211,153,0.55)"; ctx.lineWidth = 1; ctx.setLineDash([4, 3]);
      [yLo, yHi].forEach(y => {
        if (y >= u.bbox.top && y <= u.bbox.top + u.bbox.height) {
          ctx.beginPath(); ctx.moveTo(u.bbox.left, y); ctx.lineTo(u.bbox.left + u.bbox.width, y); ctx.stroke();
        }
      });
      ctx.restore();
    } } };
  }

  const charts = [];
  let syncing = false;
  const CH_H = 172;   // chart plot height (px)

  // ---------- race window ----------
  // One window shared by every chart: grab a handle on any of them and all the
  // charts, the Race Average rows and the lap breakdowns move together.
  const MIN_WIN = 5;                 // s — stop the window collapsing to nothing
  const win = { log: null, seg: null, t0: 0, t1: 0, bounds: [], dur: 0, auto: true };
  const panels = [];                 // one per rendered chart, for live stat updates
  let onWindowChange = null;
  let dragging = null;               // { u, idx } while a handle is held
  let raf = 0;

  function addHandles(u) {
    const els = [0, 1].map(idx => {
      const h = document.createElement("div");
      h.className = "rw-handle " + (idx ? "rw-end" : "rw-start");
      h.innerHTML = '<span class="rw-grip"></span>';
      h.title = idx ? "Drag — race end" : "Drag — race start";
      u.over.appendChild(h);
      // uPlot listens for mousedown on .u-over to start a drag-zoom; swallow both
      // the pointer event and its compatibility mouse event so grabbing a handle
      // doesn't zoom the chart instead.
      h.addEventListener("pointerdown", e => {
        e.preventDefault(); e.stopPropagation();
        dragging = { u: u, idx: idx };
        document.body.classList.add("rw-dragging");
        try { h.setPointerCapture(e.pointerId); } catch (_) { }
      });
      h.addEventListener("mousedown", e => { e.preventDefault(); e.stopPropagation(); });
      h.addEventListener("pointermove", e => { if (dragging) dragTo(u, e.clientX); });
      const end = () => { if (!dragging) return; dragging = null; document.body.classList.remove("rw-dragging"); commitWindow(); };
      h.addEventListener("pointerup", end);
      h.addEventListener("pointercancel", end);
      return h;
    });
    placeHandles(u, els);
    return els;
  }

  // percentage positioning against .u-over (which spans exactly the plot area)
  // keeps the handles aligned through resizes and drag-zooms alike
  function placeHandles(u, els) {
    const xs = u.scales.x;
    if (xs.min == null) return;
    const span = (xs.max - xs.min) || 1;
    [win.t0, win.t1].forEach((t, i) => {
      const f = (t - xs.min) / span;
      els[i].style.left = (100 * f) + "%";
      els[i].style.display = (f < -0.01 || f > 1.01) ? "none" : "";
    });
  }

  function dragTo(u, clientX) {
    const r = u.over.getBoundingClientRect();
    if (!r.width) return;
    const xs = u.scales.x, span = (xs.max - xs.min) || 1;
    let t = xs.min + ((clientX - r.left) / r.width) * span;
    t = Math.max(0, Math.min(win.dur, t));
    if (dragging.idx === 0) win.t0 = Math.min(t, win.t1 - MIN_WIN);
    else win.t1 = Math.max(t, win.t0 + MIN_WIN);
    win.auto = false;
    if (!raf) raf = requestAnimationFrame(() => { raf = 0; applyWindow(); });
  }

  // re-derive the laps, repaint the shading/handles and refresh every stats row.
  // Cheap enough to run on each animation frame while a handle is moving; the
  // expensive part (KPIs, concerns, saving) waits for commitWindow().
  function applyWindow() {
    if (!win.log) return;
    win.bounds = Analysis.lapInfo(win.log, win.t0, win.t1).bounds;
    charts.forEach(u => u.redraw(false, false));
    panels.forEach(renderPanelStats);
    const bar = document.querySelector(".rw-readout");
    if (bar) bar.innerHTML = windowLabel();
  }

  function commitWindow() {
    if (win.seg) { Analysis.setWindow(win.log, win.seg, win.t0, win.t1); win.seg.auto = win.auto; }
    applyWindow();
    if (onWindowChange) onWindowChange(win.t0, win.t1, win.auto);
  }

  function resetWindow() {
    const w = Analysis.raceWindow(win.log);
    if (!(w[1] > w[0])) return;
    win.t0 = w[0]; win.t1 = w[1]; win.auto = true;
    commitWindow();
  }

  function windowLabel() {
    const laps = Math.max(0, win.bounds.length - 1);
    return `<b>Race window</b> ${fmtMS(win.t0)} – ${fmtMS(win.t1)}`
      + ` <span class="rw-dur">(${fmtMS(win.t1 - win.t0)})</span>`
      + (laps > 1 ? ` · ${laps} laps` : "")
      + (win.auto ? ` <span class="rw-auto">auto</span>` : ` <span class="rw-auto rw-manual">adjusted</span>`);
  }

  // Race Average + per-lap rows for one chart. Stats come from the raw samples
  // (not the display grid) so they line up with the full-log row above them.
  function renderPanelStats(p) {
    const bs = Analysis.binStats(p.ch, win.bounds), us = p.us;
    const cell = (lab, v) => `<span><i>${lab}</i> ${fmt(p.conv(v))}${us}</span>`;
    p.raceEl.innerHTML = bs.total.n
      ? `<span class="rw-lead">Race avg</span>${cell("Avg", bs.total.avg)}${cell("Max", bs.total.max)}${cell("Min", bs.total.min)}`
      : `<span class="rw-lead">Race avg</span><span class="rw-none">no samples in window</span>`;
    const n = bs.bins.length;
    p.lapsEl.innerHTML = (n < 2) ? "" : bs.bins.map((b, i) => {
      const secs = win.bounds[i + 1] - win.bounds[i];
      return `<div class="lap-row"><b>Lap ${i + 1}</b><span class="lap-t">${secs.toFixed(1)}s</span>`
        + (b.n ? `${cell("Avg", b.avg)}${cell("Max", b.max)}` : `<span class="rw-none">—</span>`) + `</div>`;
    }).join("");
  }

  // "Show all channels" toggle — curated key channels by default, every
  // logged channel on demand. Persisted so it sticks across logs.
  let showAll = localStorage.getItem("show-all-channels") === "1";
  let lastBuild = null;
  const PALETTE = ["#38bdf8", "#34d399", "#f87171", "#c084fc", "#22d3ee",
    "#fbbf24", "#a3e635", "#fb7185", "#818cf8", "#2dd4bf", "#f472b6",
    "#facc15", "#60a5fa", "#4ade80", "#fca5a5", "#e879f9", "#67e8f9",
    "#fde047", "#bef264", "#fda4af", "#93c5fd", "#86efac", "#d8b4fe"];

  // read a CSS custom property (so charts follow the light/dark theme)
  function cssVar(name, fallback) {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  }

  // Toolbar above the charts: channel count + show-all toggle, and the race
  // window readout with a reset back to the auto-detected boundaries.
  function renderToolbar(container, total) {
    const bar = document.createElement("div");
    bar.className = "charts-bar";
    bar.innerHTML = `<span class="charts-count">${showAll
      ? `Showing all ${total} logged channels`
      : `Showing key channels · ${total} captured`}</span>
      <button class="chan-toggle" type="button">${showAll
        ? "Show key channels" : `Show all ${total} channels`}</button>`;
    container.appendChild(bar);
    bar.querySelector(".chan-toggle").addEventListener("click", () => {
      showAll = !showAll;
      localStorage.setItem("show-all-channels", showAll ? "1" : "0");
      if (lastBuild) build(lastBuild.log, lastBuild.seg, lastBuild.container, onWindowChange);
    });

    const rw = document.createElement("div");
    rw.className = "rw-bar";
    rw.innerHTML = `<span class="rw-readout">${windowLabel()}</span>
      <span class="rw-hint">Drag the ⟨ ⟩ handles on any chart to set the start and end of the race</span>
      <button class="rw-reset" type="button">Reset to auto</button>`;
    container.appendChild(rw);
    rw.querySelector(".rw-reset").addEventListener("click", resetWindow);
  }

  function build(log, seg, container, onChange) {
    lastBuild = { log, seg, container };
    container.innerHTML = "";
    charts.length = 0;
    panels.length = 0;
    const dur = log.duration || 1;
    const dt = dur < 1200 ? 0.1 : 0.25;
    const n = Math.floor(dur / dt) + 1;
    const grid = new Float64Array(n);
    for (let i = 0; i < n; i++) grid[i] = i * dt;

    const sync = uPlot.sync("telemetry");
    onWindowChange = onChange || null;
    win.log = log; win.seg = seg; win.dur = dur;
    win.t0 = seg.raceStart; win.t1 = seg.raceEnd;
    win.bounds = (seg.bounds && seg.bounds.length > 1) ? seg.bounds : [seg.raceStart, seg.raceEnd];
    win.auto = seg.auto !== false;

    // Resolve the curated channels first, tracking which log channels they
    // consumed so "show all" doesn't double-plot the same channel.
    const used = new Set();
    const specs = [];
    PLOT.forEach(s => {
      const ch = log.channel(s.name);
      if (ch) used.add(ch);
      specs.push(Object.assign({}, s, { _ch: ch }));
    });
    if (showAll) {
      let pi = 0, first = true;
      for (const ch of log.channels) {
        if (used.has(ch)) continue;
        used.add(ch);
        specs.push({ name: ch.name, color: PALETTE[pi++ % PALETTE.length], _ch: ch, _extra: first });
        first = false;
      }
    }
    renderToolbar(container, log.channels.length);

    specs.forEach(spec => {
      const ch = spec._ch;
      if (!ch || !ch.values.length) return;
      if (spec._extra) {
        const lbl = document.createElement("div");
        lbl.className = "charts-divider";
        lbl.textContent = "All other logged channels";
        container.appendChild(lbl);
      }
      let lo = Infinity, hi = -Infinity, sum = 0;
      for (const v of ch.values) { if (v < lo) lo = v; if (v > hi) hi = v; sum += v; }
      if (lo === 0 && hi === 0 && !showAll) return; // skip flat-zero channels (key view only)
      const avg = sum / ch.values.length;
      const ys = interp(ch, grid);

      // Fuel Pressure: convert from kPa to the selected display unit (PSI default)
      const isFuel = spec.name === "Fuel Pressure";
      const conv = isFuel ? Units.fuelFromKpa : (x => x);
      if (isFuel) for (let i = 0; i < ys.length; i++) ys[i] = Units.fuelFromKpa(ys[i]);
      const unit = isFuel ? Units.fuelLabel() : (UNIT_FIX[ch.unit] || ch.unit);
      const us = unit ? " " + unit : "";
      let dLo = conv(lo), dHi = conv(hi), dAvg = conv(avg);

      const card = document.createElement("div");
      card.className = "chart-card";
      const unitHtml = isFuel
        ? `<span class="chart-unit unit-toggle" data-fuel-toggle title="Toggle PSI / kPa">${unit} ⇄</span>`
        : `<span class="chart-unit">${unit || ""}</span>`;
      card.innerHTML = `<div class="chart-head">
          <span class="chart-dot" style="background:${spec.color}"></span>
          <span class="chart-name">${ch.name}</span>
          ${unitHtml}
          <span class="chart-val" data-val></span>
        </div><div class="chart-body"></div>
        <div class="chart-stats">
          <span class="rw-lead">Whole log</span>
          <span><i>Min</i> ${fmt(dLo)}${us}</span>
          <span><i>Max</i> ${fmt(dHi)}${us}</span>
          <span><i>Avg</i> ${fmt(dAvg)}${us}</span>
        </div>
        <div class="chart-stats chart-race" data-race></div>
        <div class="chart-laps" data-laps></div>`;
      container.appendChild(card);
      const valEl = card.querySelector("[data-val]");
      const body = card.querySelector(".chart-body");
      const ft = card.querySelector("[data-fuel-toggle]");
      if (ft) ft.addEventListener("click", () => {
        Units.toggleFuel();
        global.dispatchEvent(new CustomEvent("fuelunitchange"));
      });

      // per-channel overlays for the team's requested items
      const extra = [];
      if (spec.name === "Engine Speed") {
        const vt = log.channel("Aux 2") || log.channel("VTEC");
        if (vt) extra.push(vtecPlugin(
          intervalsOf(vt, v => Math.round(v) === 1),
          intervalsOf(vt, v => Math.round(v) === 3)));
      }
      if (spec.name === "ECT") {
        dLo = Math.min(dLo, 55); dHi = Math.max(dHi, 92);   // keep coolant target band in view
        extra.push(zonePlugin(75, 90, 60));
      }
      if (isFuel) {
        const [bLo, bHi] = Units.fuelBand();                // 48–52 psi (or kPa) target band
        dLo = Math.min(dLo, bLo); dHi = Math.max(dHi, bHi);
        extra.push(bandZone(bLo, bHi));
      }
      const pad = (dHi - dLo) * 0.08 || 1;
      const opts = {
        width: body.clientWidth || 900, height: CH_H,
        cursor: { sync: { key: sync.key }, points: { size: 6 }, drag: { x: true, y: false } },
        scales: { x: { time: false }, y: { range: [dLo - pad, dHi + pad] } },
        legend: { show: false },
        axes: [
          { stroke: cssVar("--chart-axis", "#64748b"), grid: { stroke: cssVar("--chart-grid", "rgba(148,163,184,0.08)") }, ticks: { stroke: cssVar("--chart-grid", "rgba(148,163,184,0.15)") },
            values: (u, vals) => vals.map(v => v + "s"), font: "11px system-ui" },
          { stroke: cssVar("--chart-axis", "#64748b"), grid: { stroke: cssVar("--chart-grid", "rgba(148,163,184,0.06)") }, ticks: { show: false }, size: 52, font: "11px system-ui" },
        ],
        series: [
          {},
          { stroke: spec.color, width: 1.6, fill: gradientFill(spec.color),
            points: { show: false }, value: (u, v) => v == null ? "" : fmt(v) + (unit ? " " + unit : "") },
        ],
        plugins: [bgPlugin(spec.threshold ? spec.threshold.v : null), ...extra],
        hooks: {
          setCursor: [u => {
            const i = u.cursor.idx;
            valEl.textContent = (i == null || ys[i] == null) ? "" : fmt(ys[i]) + (unit ? " " + unit : "");
          }],
          setScale: [(u, key) => {
            if (key !== "x" || syncing) return;
            syncing = true;
            const xs = u.scales.x;
            charts.forEach(c => { if (c !== u) c.setScale("x", { min: xs.min, max: xs.max }); });
            syncing = false;
          }],
          draw: [u => { if (u._rwHandles) placeHandles(u, u._rwHandles); }],
        },
      };
      const u = new uPlot(opts, [grid, ys], body);
      u._rwHandles = addHandles(u);
      sync.sub(u);
      charts.push(u);
      const p = {
        u, ch, conv, us, raceEl: card.querySelector("[data-race]"), lapsEl: card.querySelector("[data-laps]"),
      };
      panels.push(p);
      renderPanelStats(p);
    });

    if (!charts.length) {
      container.innerHTML = `<div class="empty">No plottable channels in this log.</div>`;
    }
    resize();
  }

  function fmt(v) {
    const a = Math.abs(v);
    return a >= 1000 ? Math.round(v).toLocaleString() : a >= 100 ? v.toFixed(0) : v.toFixed(1);
  }

  // ---------- Readout (point-in-time) view ----------
  // Scrub the RPM header chart → every key parameter's value at that instant.
  const READOUT = [
    { name: "Engine Speed", label: "Engine Speed", unit: "RPM", dec: 0 },
    { name: "TPS (Main)", label: "TPS", unit: "%", dec: 0 },
    { name: "MAP", label: "MAP", unit: "kPa", dec: 1 },
    { name: "Injector Duty Cycle", label: "Injector Duty", unit: "%", dec: 1, warn: v => v >= 100 ? "crit" : v >= 90 ? "warn" : "" },
    { name: "Fuel Pressure", label: "Fuel Pressure", fuel: true, dec: 0, warn: (v, psi) => psi < 48 ? "crit" : "" },
    { name: "Lambda 1", label: "Lambda", unit: "λ", dec: 2, warn: v => v > 1.0 ? "crit" : "" },
    { name: "ECT", label: "Coolant", unit: "°C", dec: 0, warn: v => v < 60 ? "cold" : "" },
    { name: "IAT", label: "Intake Air", unit: "°C", dec: 0 },
    { name: "Ignition Angle", label: "Ignition", unit: "°BTDC", dec: 1 },
    { name: "Batt Voltage", label: "Battery", unit: "V", dec: 2, warn: v => v < 11.5 ? "warn" : "" },
  ];
  let readoutChart = null;

  function fmtMS(sec) {
    sec = Math.max(0, sec); const m = Math.floor(sec / 60), s = Math.round(sec % 60);
    return m + ":" + (s < 10 ? "0" : "") + s;
  }

  function buildReadout(log, seg, container) {
    container.innerHTML = "";
    if (readoutChart) { try { readoutChart.destroy(); } catch (e) {} readoutChart = null; }
    const dur = log.duration || 1;
    const dt = dur < 1200 ? 0.1 : 0.25;
    const n = Math.floor(dur / dt) + 1;
    const grid = new Float64Array(n);
    for (let i = 0; i < n; i++) grid[i] = i * dt;

    const series = READOUT.map(spec => {
      const ch = log.channel(spec.name);
      return ch && ch.values.length ? interp(ch, grid) : null;
    });
    const rpm = series[0] || new Float64Array(n);

    const head = document.createElement("div");
    head.className = "ro-head";
    head.innerHTML = `<div class="ro-head-top"><span class="ro-head-title">Engine Speed — drag to scrub</span>
        <span class="ro-time" data-time>—</span></div><div class="ro-chart"></div>`;
    container.appendChild(head);

    const gridWrap = document.createElement("div");
    gridWrap.className = "ro-grid";
    gridWrap.innerHTML = READOUT.map((spec, i) =>
      `<div class="ro-tile" data-i="${i}"><div class="ro-label">${spec.label}</div>
         <div class="ro-val"><span data-val>—</span><span class="ro-unit" data-unit></span></div></div>`).join("");
    container.appendChild(gridWrap);

    const timeEl = head.querySelector("[data-time]");
    const tiles = READOUT.map((spec, i) => {
      const t = gridWrap.querySelector(`[data-i="${i}"]`);
      return { spec, el: t, val: t.querySelector("[data-val]"), unit: t.querySelector("[data-unit]") };
    });

    function update(idx) {
      if (idx == null || idx < 0 || idx >= n) return;
      timeEl.textContent = fmtMS(grid[idx]);
      tiles.forEach((t, i) => {
        const arr = series[i];
        if (!arr) { t.val.textContent = "—"; t.unit.textContent = ""; t.el.className = "ro-tile"; return; }
        const raw = arr[idx];
        let disp = raw, unit = t.spec.unit || "", cls = "";
        if (t.spec.fuel) { disp = Units.fuelFromKpa(raw); unit = Units.fuelLabel(); cls = t.spec.warn(disp, raw / Units.KPA_PER_PSI) || ""; }
        else if (t.spec.warn) cls = t.spec.warn(raw) || "";
        t.val.textContent = disp.toFixed(t.spec.dec);
        t.unit.textContent = unit;
        t.el.className = "ro-tile" + (cls ? " " + cls : "");
      });
    }

    const body = head.querySelector(".ro-chart");
    const opts = {
      width: body.clientWidth || 900, height: 168,
      cursor: { show: false },   // custom playhead + pointer handling instead (touch-friendly)
      scales: { x: { time: false, range: [0, grid[n - 1]] } },   // no edge padding → playhead aligns
      legend: { show: false },
      axes: [
        { stroke: cssVar("--chart-axis", "#64748b"), grid: { stroke: cssVar("--chart-grid", "rgba(148,163,184,0.08)") },
          ticks: { stroke: cssVar("--chart-grid", "rgba(148,163,184,0.15)") },
          values: (u, vals) => vals.map(fmtMS), font: "11px system-ui",
          label: "Time (m:s)", labelFont: "600 11px system-ui", labelSize: 24 },
        { stroke: cssVar("--chart-axis", "#64748b"), grid: { stroke: cssVar("--chart-grid", "rgba(148,163,184,0.06)") },
          ticks: { show: false }, size: 58, font: "11px system-ui",
          label: "Engine Speed (RPM)", labelFont: "600 11px system-ui", labelSize: 24,
          values: (u, vals) => vals.map(v => Math.round(v).toLocaleString()) },
      ],
      series: [{}, { stroke: "#38bdf8", width: 1.6, fill: gradientFill("#38bdf8"), points: { show: false } }],
    };
    readoutChart = new uPlot(opts, [grid, rpm], body);
    const w0 = body.clientWidth; if (w0) readoutChart.setSize({ width: w0, height: 168 });

    // Custom playhead + pointer scrubbing — works for mouse hover AND touch drag.
    // (uPlot's own cursor gets pre-empted by iOS text selection on touch-drag.)
    const over = readoutChart.over;
    over.style.touchAction = "none";
    const playhead = document.createElement("div");
    playhead.className = "ro-playhead";
    over.appendChild(playhead);
    let selIdx = Math.floor(n / 2), down = false;
    function moveTo(idx) {
      selIdx = Math.max(0, Math.min(n - 1, idx));
      // percentage so CSS positions it correctly whatever the plot width is / whenever it settles
      playhead.style.left = (n > 1 ? 100 * selIdx / (n - 1) : 0) + "%";
      update(selIdx);
    }
    function idxAt(clientX) {
      const r = over.getBoundingClientRect();
      const frac = r.width ? (clientX - r.left) / r.width : 0;
      return Math.round(Math.max(0, Math.min(1, frac)) * (n - 1));
    }
    over.addEventListener("pointerdown", e => { down = true; try { over.setPointerCapture(e.pointerId); } catch (x) {} moveTo(idxAt(e.clientX)); e.preventDefault(); });
    over.addEventListener("pointermove", e => { if (down || e.pointerType === "mouse") moveTo(idxAt(e.clientX)); });
    over.addEventListener("pointerup", () => { down = false; });
    readoutChart._reposition = () => moveTo(selIdx);
    moveTo(selIdx);   // default: middle of the run (% left → correct at any width)
  }

  function resize() {
    charts.forEach(u => {
      const w = u.root.parentElement.clientWidth;
      if (w && Math.abs(w - u.width) > 2) u.setSize({ width: w, height: CH_H });
    });
    if (readoutChart) {
      const w = readoutChart.root.parentElement.clientWidth;
      if (w && Math.abs(w - readoutChart.width) > 2) { readoutChart.setSize({ width: w, height: 168 }); if (readoutChart._reposition) readoutChart._reposition(); }
    }
  }
  global.addEventListener("resize", () => { clearTimeout(resize._t); resize._t = setTimeout(resize, 120); });

  // Resize charts to a fixed page-friendly width for printing, then restore.
  function setPrintMode(on) {
    charts.forEach(u => {
      const w = on ? 700 : (u.root.parentElement.clientWidth || 700);
      u.setSize({ width: w, height: on ? 210 : CH_H });
    });
  }

  global.Charts = { build, buildReadout, resize, setPrintMode };
})(window);
