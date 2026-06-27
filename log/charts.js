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

  // plugin: shade the sustained-load window + optional threshold line (behind series)
  function bgPlugin(band, threshold) {
    return {
      hooks: {
        drawClear: u => {
          const ctx = u.ctx;
          if (band && band[1] > band[0]) {
            const x0 = u.valToPos(band[0], "x", true), x1 = u.valToPos(band[1], "x", true);
            ctx.save();
            ctx.fillStyle = cssVar("--chart-shade", "rgba(160,160,170,0.07)");
            ctx.fillRect(x0, u.bbox.top, x1 - x0, u.bbox.height);
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

  const charts = [];
  let syncing = false;
  const CH_H = 172;   // chart plot height (px)

  // read a CSS custom property (so charts follow the light/dark theme)
  function cssVar(name, fallback) {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  }

  function build(log, seg, container) {
    container.innerHTML = "";
    charts.length = 0;
    const dur = log.duration || 1;
    const dt = dur < 1200 ? 0.1 : 0.25;
    const n = Math.floor(dur / dt) + 1;
    const grid = new Float64Array(n);
    for (let i = 0; i < n; i++) grid[i] = i * dt;

    const sync = uPlot.sync("telemetry");
    const band = [seg.raceStart, seg.raceEnd];

    PLOT.forEach(spec => {
      const ch = log.channel(spec.name);
      if (!ch || !ch.values.length) return;
      let lo = Infinity, hi = -Infinity, sum = 0;
      for (const v of ch.values) { if (v < lo) lo = v; if (v > hi) hi = v; sum += v; }
      if (lo === 0 && hi === 0) return;            // skip dead channels
      const avg = sum / ch.values.length;
      const ys = interp(ch, grid);
      const unit = UNIT_FIX[ch.unit] || ch.unit;
      const us = unit ? " " + unit : "";

      const card = document.createElement("div");
      card.className = "chart-card";
      card.innerHTML = `<div class="chart-head">
          <span class="chart-dot" style="background:${spec.color}"></span>
          <span class="chart-name">${ch.name}</span>
          <span class="chart-unit">${unit || ""}</span>
          <span class="chart-val" data-val></span>
        </div><div class="chart-body"></div>
        <div class="chart-stats">
          <span><i>Min</i> ${fmt(lo)}${us}</span>
          <span><i>Max</i> ${fmt(hi)}${us}</span>
          <span><i>Avg</i> ${fmt(avg)}${us}</span>
        </div>`;
      container.appendChild(card);
      const valEl = card.querySelector("[data-val]");
      const body = card.querySelector(".chart-body");

      // per-channel overlays for the team's requested items
      const extra = [];
      if (spec.name === "Engine Speed") {
        const vt = log.channel("Aux 2") || log.channel("VTEC");
        if (vt) extra.push(vtecPlugin(
          intervalsOf(vt, v => Math.round(v) === 1),
          intervalsOf(vt, v => Math.round(v) === 3)));
      }
      if (spec.name === "ECT") {
        lo = Math.min(lo, 55); hi = Math.max(hi, 92);   // keep coolant target band in view
        extra.push(zonePlugin(75, 90, 60));
      }
      const pad = (hi - lo) * 0.08 || 1;
      const opts = {
        width: body.clientWidth || 900, height: CH_H,
        cursor: { sync: { key: sync.key }, points: { size: 6 }, drag: { x: true, y: false } },
        scales: { x: { time: false }, y: { range: [lo - pad, hi + pad] } },
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
        plugins: [bgPlugin(band, spec.threshold ? spec.threshold.v : null), ...extra],
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
        },
      };
      const u = new uPlot(opts, [grid, ys], body);
      sync.sub(u);
      charts.push(u);
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

  function resize() {
    charts.forEach(u => {
      const w = u.root.parentElement.clientWidth;
      if (w && Math.abs(w - u.width) > 2) u.setSize({ width: w, height: CH_H });
    });
  }
  global.addEventListener("resize", () => { clearTimeout(resize._t); resize._t = setTimeout(resize, 120); });

  // Resize charts to a fixed page-friendly width for printing, then restore.
  function setPrintMode(on) {
    charts.forEach(u => {
      const w = on ? 700 : (u.root.parentElement.clientWidth || 700);
      u.setSize({ width: w, height: on ? 210 : CH_H });
    });
  }

  global.Charts = { build, resize, setPrintMode };
})(window);
