/* analysis.js — segmentation, concern flags, and KPI tiles for a parsed log.
   Ported from report.py. Thresholds sourced from the PCLink manual + boat build. */
(function (global) {
  "use strict";

  // tunable reference bands (see assessment with the team)
  const ECT_COLD = 60, ECT_OPT = [75, 90];   // °C: flag below COLD; ideal band
  const VSAG = 11.5;                          // V: voltage-sag spike threshold under load

  // --- shape-analysis grid (race window + corner detection) ---
  const GDT = 0.1;          // s per grid sample
  const WOT_WIN = 8;        // s — rolling window that defines "sustained" throttle
  const WOT_FRAC = 0.85;    // fraction of the wide-open plateau that still counts
  const TURN_SMOOTH = 2.5;  // s — smoothing before looking for corner dips
  const TURN_SEP = 8;       // s — two corners can't be closer than this
  const TURN_PROM = 0.5;    // corner dip must be this deep vs. the in-race RPM range
                            // (real corners measure 68–95 % on the reference log;
                            //  the deepest non-corner wobble is under 30 %)

  // step-hold resample onto a uniform GDT grid (unlike a bucket fill, this keeps
  // genuine zeros instead of carrying the previous sample over them)
  function hold(ch, dur) {
    const n = Math.floor(dur / GDT) + 1, out = new Float64Array(n);
    let j = 0;
    for (let i = 0; i < n; i++) {
      const t = i * GDT;
      while (j + 1 < ch.times.length && ch.times[j + 1] <= t) j++;
      out[i] = ch.values[j] || 0;
    }
    return out;
  }

  // centred moving average over w samples (running sum, correct at both edges)
  function smooth(a, w) {
    const n = a.length, out = new Float64Array(n), h = w >> 1;
    let s = 0, lo = 0, hi = -1;
    for (let i = 0; i < n; i++) {
      const l = Math.max(0, i - h), r = Math.min(n - 1, i + h);
      while (hi < r) s += a[++hi];
      while (lo < l) s -= a[lo++];
      out[i] = s / (hi - lo + 1);
    }
    return out;
  }

  function pctile(a, p) {
    const s = Array.prototype.slice.call(a).sort((x, y) => x - y);
    return s[Math.min(s.length - 1, Math.floor(p * s.length))];
  }

  function mean(a) { let s = 0; for (let i = 0; i < a.length; i++) s += a[i]; return s / a.length; }
  const min = a => a.reduce((m, v) => v < m ? v : m, Infinity);
  const max = a => a.reduce((m, v) => v > m ? v : m, -Infinity);
  function median(a) { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; }

  // nearest-sample value of a (time-sorted) channel at time t
  function nearest(ch, t) {
    let lo = 0, hi = ch.times.length - 1;
    if (hi < 0) return 0;
    while (lo < hi) { const m = (lo + hi) >> 1; if (ch.times[m] < t) lo = m + 1; else hi = m; }
    return ch.values[Math.min(lo, ch.values.length - 1)];
  }

  // Auto-place the race window: the longest stretch of sustained wide-open
  // throttle. (The previous "RPM above 4500" test also caught the milling laps
  // before the gun — on an 8-minute log it returned 0–462 s for a 224 s race.)
  function raceWindow(log) {
    const dur = log.duration || 0;
    const tps = log.channel("TPS"), rpm = log.channel("Engine Speed");
    const src = (tps && tps.values.length) ? tps : rpm;
    if (!src || !src.values.length || dur <= 0) return [0, 0];
    const g = hold(src, dur), n = g.length;
    const plateau = pctile(g, 0.97);            // robust "flat out" level
    if (!(plateau > 0)) return [0, 0];
    const thr = WOT_FRAC * plateau;
    const av = smooth(g, Math.round(WOT_WIN / GDT));
    let best = null, s = -1;
    for (let i = 0; i < n; i++) {
      if (av[i] >= thr) { if (s < 0) s = i; }
      else if (s >= 0) { if (!best || i - 1 - s > best[1] - best[0]) best = [s, i - 1]; s = -1; }
    }
    if (s >= 0 && (!best || n - 1 - s > best[1] - best[0])) best = [s, n - 1];
    if (!best) return [0, 0];
    let a = best[0], b = best[1];
    while (a > 0 && g[a - 1] >= thr) a--;       // walk the edges out to the real corners
    while (b < n - 1 && g[b + 1] >= thr) b++;
    return [a * GDT, b * GDT];
  }

  // Corners read as prominent dips in RPM — he's flat out down the straights and
  // lifts for each turn. 5 laps = 10 turns, so a lap boundary sits on the straight
  // between an even-numbered turn and the next odd one. The split goes at the
  // midpoint of that pair rather than the RPM peak: the peak drifts around inside
  // the straight depending on how the boat's running, which made otherwise even
  // laps read 51 s and 40 s.
  function lapInfo(log, t0, t1) {
    const out = { turns: [], bounds: [], lap: 0, corner: 0, nLaps: 0 };
    const rpm = log.channel("Engine Speed");
    if (!rpm || !rpm.values.length || !(t1 > t0)) return out;
    const g = smooth(hold(rpm, log.duration), Math.round(TURN_SMOOTH / GDT));
    const a = Math.max(0, Math.round(t0 / GDT));
    const b = Math.min(g.length - 1, Math.round(t1 / GDT));
    out.bounds = [t0, t1];
    if (b - a < Math.round(TURN_SEP / GDT)) return out;
    const seg = g.subarray(a, b + 1);
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < seg.length; i++) { if (seg[i] < lo) lo = seg[i]; if (seg[i] > hi) hi = seg[i]; }
    const prom = (hi - lo) * TURN_PROM, sep = Math.round(TURN_SEP / GDT);

    const turns = [];
    for (let i = 1; i < seg.length - 1; i++) {
      if (!(seg[i] <= seg[i - 1] && seg[i] < seg[i + 1])) continue;
      let l = seg[i], r = seg[i];               // prominence: rise on each side
      for (let k = i; k >= 0 && seg[k] >= seg[i]; k--) if (seg[k] > l) l = seg[k];
      for (let k = i; k < seg.length && seg[k] >= seg[i]; k++) if (seg[k] > r) r = seg[k];
      if (Math.min(l, r) - seg[i] < prom) continue;
      const last = turns.length ? turns[turns.length - 1] : -1;
      if (last >= 0 && i - last < sep) { if (seg[i] < seg[last]) turns[turns.length - 1] = i; }
      else turns.push(i);
    }
    out.turns = turns.map(i => (a + i) * GDT);

    const bounds = [t0];
    for (let k = 2; k < turns.length; k += 2)
      bounds.push(0.5 * (out.turns[k - 1] + out.turns[k]));
    bounds.push(t1);
    // a sliver of a final lap means the end handle sits mid-straight — fold it in
    if (bounds.length > 2 && t1 - bounds[bounds.length - 2] < 0.35 * (t1 - t0) / (bounds.length - 1))
      bounds.splice(bounds.length - 2, 1);
    out.bounds = bounds;
    out.nLaps = bounds.length - 1;

    const gaps = [];
    for (let k = 1; k < out.turns.length; k++) gaps.push(out.turns[k] - out.turns[k - 1]);
    if (gaps.length) { out.corner = median(gaps); out.lap = 2 * out.corner; }
    else if (out.nLaps) out.lap = (t1 - t0) / out.nLaps;
    return out;
  }

  // `saved` is a stored { start, end } window (a hand-placed one wins over auto-detect)
  function segment(log, saved) {
    const out = { start: 0, raceStart: 0, raceEnd: 0, lap: 0, nLaps: 0, corner: 0,
      turns: [], bounds: [], auto: true };
    const rpm = log.channel("Engine Speed");
    if (!rpm || !rpm.values.length) return out;
    const g = hold(rpm, log.duration);
    for (let i = 0; i < g.length; i++) if (g[i] > 1500) { out.start = i * GDT; break; }
    let a, b;
    if (saved && saved.end > saved.start) { a = saved.start; b = saved.end; out.auto = false; }
    else { const w = raceWindow(log); a = w[0]; b = w[1]; }
    return setWindow(log, out, a, b);
  }

  // move the race window on an existing segment (used by the chart handles)
  function setWindow(log, seg, t0, t1) {
    seg.raceStart = t0; seg.raceEnd = t1;
    const li = lapInfo(log, t0, t1);
    seg.turns = li.turns; seg.bounds = li.bounds;
    seg.lap = li.lap; seg.corner = li.corner; seg.nLaps = li.nLaps;
    return seg;
  }

  // min/max/avg of a channel inside each [bounds[k], bounds[k+1]) slice plus the
  // total across the whole span — one pass over the raw samples, so the numbers
  // match the full-log row rather than the display grid.
  function binStats(ch, bounds) {
    const nb = Math.max(0, (bounds || []).length - 1), bins = [];
    const blank = () => ({ n: 0, sum: 0, min: Infinity, max: -Infinity });
    for (let k = 0; k < nb; k++) bins.push(blank());
    const total = blank();
    const fin = o => ({ n: o.n, avg: o.n ? o.sum / o.n : 0, min: o.n ? o.min : 0, max: o.n ? o.max : 0 });
    if (!nb || !ch || !ch.times.length) return { bins: bins.map(fin), total: fin(total) };
    const t0 = bounds[0], t1 = bounds[nb];
    let k = 0;
    for (let i = 0; i < ch.times.length; i++) {
      const t = ch.times[i];
      if (t < t0) continue;
      if (t > t1) break;
      while (k < nb - 1 && t >= bounds[k + 1]) k++;
      const v = ch.values[i], b = bins[k];
      b.n++; b.sum += v; if (v < b.min) b.min = v; if (v > b.max) b.max = v;
      total.n++; total.sum += v; if (v < total.min) total.min = v; if (v > total.max) total.max = v;
    }
    return { bins: bins.map(fin), total: fin(total) };
  }

  function during(ch, t0, t1) {
    const o = [];
    for (let i = 0; i < ch.times.length; i++)
      if (ch.times[i] >= t0 && ch.times[i] <= t1) o.push(ch.values[i]);
    return o;
  }

  // ---- derived metrics for the team's requested items ----

  // Coolant temperature while the engine is running.
  function ectRun(log) {
    const ect = log.channel("ECT"), rpm = log.channel("Engine Speed");
    if (!ect || !ect.values.length) return null;
    const run = [];
    for (let i = 0; i < ect.values.length; i++)
      if (!rpm || nearest(rpm, ect.times[i]) > 1500) run.push(ect.values[i]);
    const arr = run.length ? run : Array.from(ect.values);
    const below = t => 100 * arr.filter(v => v < t).length / arr.length;
    return { avg: mean(arr), lo: min(arr), hi: max(arr), pctCold: below(ECT_COLD), pctOpt: below(ECT_OPT[0]) };
  }

  // VTEC solenoid on Aux 2: crossover RPM + fault-state detection (status 3 = Fault).
  function vtecInfo(log) {
    const v = log.channel("Aux 2") || log.channel("VTEC");
    const rpm = log.channel("Engine Speed");
    if (!v || !v.values.length) return null;
    const ons = [], offs = [];
    for (let i = 1; i < v.values.length; i++) {
      const p = Math.round(v.values[i - 1]), c = Math.round(v.values[i]);
      if (p !== 1 && c === 1) ons.push(rpm ? nearest(rpm, v.times[i]) : 0);
      if (p === 1 && c !== 1 && c !== 3) offs.push(rpm ? nearest(rpm, v.times[i]) : 0);
    }
    const faultCount = v.values.reduce((n, x) => n + (Math.round(x) === 3 ? 1 : 0), 0);
    const engaged = 100 * v.values.reduce((n, x) => n + (Math.round(x) === 1 ? 1 : 0), 0) / v.values.length;
    return {
      onRpm: ons.length ? median(ons) : 0, offRpm: offs.length ? median(offs) : 0,
      engaged, fault: faultCount > 0, faultCount,
    };
  }

  // Throttle lifts under load → how far he lifts entering corners (avg + min).
  function cornering(log) {
    const tps = log.channel("TPS"), rpm = log.channel("Engine Speed");
    if (!tps || !tps.values.length) return null;
    const idx = [];
    for (let i = 0; i < tps.values.length; i++)
      if (!rpm || nearest(rpm, tps.times[i]) > 4500) idx.push(i);
    if (idx.length < 10) return { count: 0 };
    const maxLoad = max(idx.map(i => tps.values[i]));
    const thr = Math.max(35, 0.65 * maxLoad);
    const floors = [], entries = [];
    let inDip = false, dipMin = Infinity, entryVal = maxLoad;
    for (let k = 0; k < idx.length; k++) {
      const v = tps.values[idx[k]];
      if (v < thr) {
        if (!inDip) { inDip = true; dipMin = v; entryVal = k > 0 ? tps.values[idx[k - 1]] : v; }
        else dipMin = Math.min(dipMin, v);
      } else if (inDip) { floors.push(dipMin); entries.push(entryVal); inDip = false; }
    }
    if (inDip) floors.push(dipMin);
    if (!floors.length) return { count: 0, maxLoad };
    return { count: floors.length, avgFloor: mean(floors), minFloor: min(floors), avgEntry: mean(entries), maxLoad };
  }

  function flags(log, seg) {
    const concerns = [], opps = [], notes = [];
    const t0 = seg.raceStart, t1 = seg.raceEnd;
    const C = n => log.channel(n);
    const rpm = C("Engine Speed");

    const idc = C("Injector Duty Cycle");
    if (idc && idc.values.length) {
      const mx = max(idc.values);
      if (mx >= 90) concerns.push(["CRITICAL", `Injector Duty Cycle peaks ${mx.toFixed(1)}% — over Link's 90% full-power limit. Stock injectors are class-locked, so this is the hard ceiling on fuelling.`]);
      else if (mx >= 85) concerns.push(["WATCH", `Injector Duty Cycle peaks ${mx.toFixed(1)}% — approaching Link's 90% limit.`]);
    }
    const fp = C("Fuel Pressure");
    if (fp) {
      const run = during(fp, t0, t1).filter(v => v > 50);
      if (run.length) {
        const loKpa = min(run), hiKpa = max(run);
        const [bLoKpa, bHiKpa] = Units.fuelBandKpa();
        const u = Units.fuelLabel();
        const [bLo, bHi] = Units.fuelBand();
        const band = `${bLo.toFixed(0)}–${bHi.toFixed(0)} ${u}`;
        if (loKpa < bLoKpa) {
          const sev = loKpa < bLoKpa * 0.8 ? "CRITICAL" : "WATCH";
          concerns.push([sev, `Fuel Pressure dropped to ${Units.fuelFromKpa(loKpa).toFixed(0)} ${u} under load — below the ${band} target band. Supply can't hold pressure at high demand.`]);
        } else if (hiKpa > bHiKpa) {
          concerns.push(["WATCH", `Fuel Pressure ran up to ${Units.fuelFromKpa(hiKpa).toFixed(0)} ${u} — above the ${band} target band.`]);
        }
      }
    }
    const lam = C("Lambda 1") || C("Lambda");
    if (lam && lam.values.some(v => v)) {
      const run = during(lam, t0, t1).filter(v => v > 0.5);
      if (run.length && max(run) > 1.0)
        concerns.push(["WATCH", `Lean excursion to ${max(run).toFixed(2)} λ under load (target ~0.89) — check fuelling there.`]);
    } else if (lam) notes.push("Lambda 1 reads zero all run — wideband not logging/connected.");

    // --- Voltage sag spikes (under load) ---
    const bv = C("Batt Voltage");
    if (bv) {
      let events = 0, lowest = Infinity, inSag = false;
      for (let i = 0; i < bv.values.length; i++) {
        const running = !rpm || nearest(rpm, bv.times[i]) > 2000;
        const v = bv.values[i];
        if (running && v < VSAG) { if (!inSag) { events++; inSag = true; } if (v < lowest) lowest = v; }
        else if (v >= VSAG) inSag = false;
      }
      if (events > 0)
        concerns.push(["WATCH", `Voltage sag: ${events} dip(s) below ${VSAG} V under load (lowest ${lowest.toFixed(1)} V) — check grounds/charging connections under load.`]);
    }

    // --- VTEC (Aux 2): fault state + engagement ---
    const vi = vtecInfo(log);
    if (vi) {
      if (vi.fault)
        concerns.push(["WATCH", `VTEC output (Aux 2) reported a FAULT state ${vi.faultCount}× — per Link, Aux 'Fault' means the hardware isn't happy. Check the VTEC solenoid wiring/output before the next run.`]);
      if (vi.onRpm)
        notes.push(`VTEC (Aux 2) engages ~${vi.onRpm.toFixed(0)} RPM, drops out ~${vi.offRpm.toFixed(0)} RPM; active ${vi.engaged.toFixed(0)}% of the run.`);
    }

    // --- Coolant running cold ---
    const er = ectRun(log);
    if (er) {
      if (er.avg < ECT_COLD)
        concerns.push(["WATCH", `Coolant runs cold — avg ${er.avg.toFixed(0)}°C, ${er.pctCold.toFixed(0)}% of run below ${ECT_COLD}°C (ideal ~${ECT_OPT[0]}–${ECT_OPT[1]}°C). Warm-up enrichment likely active: costs power/response and washes oil.`]);
      notes.push(`ECT ${er.lo.toFixed(0)}–${er.hi.toFixed(0)}°C, avg ${er.avg.toFixed(0)}°C (target band ${ECT_OPT[0]}–${ECT_OPT[1]}°C).`);
    }

    // --- Cornering / throttle lift (approximate, oval) ---
    const cz = cornering(log);
    if (cz && cz.count)
      notes.push(`Cornering (oval, approx): ${cz.count} throttle lifts — avg corner throttle ${cz.avgFloor.toFixed(0)}%, min ${cz.minFloor.toFixed(0)}% (entry ~${cz.avgEntry.toFixed(0)}%).`);

    const te = C("Trig1 Err Counter");
    if (te) {
      const run = during(te, t0, t1);
      if (run.length && (max(run) - min(run)) >= 1)
        concerns.push(["WATCH", `Trigger 1 error count rose by ${(max(run) - min(run)).toFixed(0)} under load — per Link, increments while running mean trigger wiring/sensor noise.`]);
    }
    const ign = C("Ignition Angle");
    if (ign) opps.push(`Ignition reached ${max(ign.values).toFixed(1)}° BTDC — conservative tune, likely dyno room to advance if knock-safe.`);
    if (rpm) opps.push(`Peak RPM ${max(rpm.values).toFixed(0)} — confirm it's at/near the power peak (gearing/prop dependent).`);

    const iat = C("IAT"); if (iat) notes.push(`IAT ${min(iat.values).toFixed(0)}–${max(iat.values).toFixed(0)}°C.`);
    const zeros = log.channels.filter(c => c.values.length && max(c.values) === 0 && min(c.values) === 0).map(c => c.name);
    if (zeros.length) notes.push("Channels logging zero (sensor/feature inactive): " + zeros.join(", ") + ".");
    return { concerns, opps, notes };
  }

  function kpis(log, seg) {
    const C = n => log.channel(n);
    const tiles = [];
    const push = (label, value, unit, sev) => tiles.push({ label, value, unit: unit || "", sev: sev || "ok" });
    push("Duration", (log.duration / 60).toFixed(1), "min");
    const rpm = C("Engine Speed"); if (rpm) push("Peak RPM", Math.round(max(rpm.values)).toLocaleString(), "");
    const idc = C("Injector Duty Cycle");
    if (idc) { const mx = max(idc.values); push("Peak Inj Duty", mx.toFixed(1), "%", mx >= 90 ? "crit" : mx >= 85 ? "warn" : "ok"); }
    const fp = C("Fuel Pressure");
    if (fp) {
      const run = during(fp, seg.raceStart, seg.raceEnd).filter(v => v > 50);
      if (run.length) {
        const loKpa = min(run), [bLoKpa] = Units.fuelBandKpa();
        const sev = loKpa < bLoKpa * 0.8 ? "crit" : loKpa < bLoKpa ? "warn" : "ok";
        push("Min Fuel P (load)", Units.fuelFromKpa(loKpa).toFixed(0), Units.fuelLabel(), sev);
      }
    }
    const er = ectRun(log);
    if (er) push("Coolant (avg)", er.avg.toFixed(0), "°C", er.avg < ECT_COLD ? "crit" : er.avg < ECT_OPT[0] ? "warn" : "ok");
    const vi = vtecInfo(log);
    if (vi && vi.onRpm) push("VTEC Crossover", Math.round(vi.onRpm).toLocaleString(), "RPM", vi.fault ? "crit" : "ok");
    const cz = cornering(log);
    if (cz && cz.count) push("Corner Throttle", cz.avgFloor.toFixed(0), "%");
    const ign = C("Ignition Angle"); if (ign) push("Peak Ignition", max(ign.values).toFixed(1), "° BTDC");
    return tiles;
  }

  // compact numeric summary stored per log for historical aggregates (no reparse)
  function summaryStats(log, seg) {
    const C = n => log.channel(n);
    const s = { durationMin: log.duration / 60 };
    const rpm = C("Engine Speed"); if (rpm && rpm.values.length) s.peakRpm = max(rpm.values);
    const idc = C("Injector Duty Cycle"); if (idc && idc.values.length) s.peakIdc = max(idc.values);
    const er = ectRun(log); if (er) { s.coolantAvg = er.avg; s.coolantMax = er.hi; }
    const fp = C("Fuel Pressure");
    if (fp) { const run = during(fp, seg.raceStart, seg.raceEnd).filter(v => v > 50); if (run.length) s.minFuelPLoad = min(run); }
    const vi = vtecInfo(log); if (vi) { s.vtecRpm = vi.onRpm; s.vtecFault = vi.fault; }
    const ign = C("Ignition Angle"); if (ign && ign.values.length) s.maxIgn = max(ign.values);
    const tps = C("TPS"); if (tps && tps.values.length) s.maxThrottle = max(tps.values);
    const cz = cornering(log); if (cz && cz.count) { s.cornerAvg = cz.avgFloor; s.cornerMin = cz.minFloor; }
    const bv = C("Batt Voltage");
    if (bv) { const run = []; for (let i = 0; i < bv.values.length; i++) if (!rpm || nearest(rpm, bv.times[i]) > 2000) run.push(bv.values[i]); if (run.length) s.voltMin = min(run); }
    return s;
  }

  // ---- cross-log trends (reads stored summaryStats; no file reparse) ----
  // Each metric: how to read it, when it's a "breach", and which way is bad
  // (worse:+1 = higher is bad, -1 = lower is bad).
  const TREND_METRICS = [
    { key: "peakIdc", label: "Injector duty", dg: 0, unit: "%", worse: +1,
      breach: v => v >= 90, crit: v => v >= 100, breachTxt: "over 90%", extreme: "max" },
    { key: "minFuelPLoad", label: "Min fuel pressure", worse: -1,
      disp: v => Units.fuelFromKpa(v).toFixed(0) + " " + Units.fuelLabel(),
      breach: v => v < Units.fuelBandKpa()[0], crit: v => v < Units.fuelBandKpa()[0] * 0.8,
      breachTxt: "below target", extreme: "min" },
    { key: "coolantAvg", label: "Coolant", dg: 0, unit: "°C", worse: -1,
      breach: v => v < ECT_COLD, crit: () => false, breachTxt: "below " + ECT_COLD + "°C" },
    { key: "voltMin", label: "Voltage", dg: 1, unit: " V", worse: -1,
      breach: v => v < VSAG, crit: () => false, breachTxt: "under " + VSAG + " V" },
    { key: "peakRpm", label: "Peak RPM", worse: +1, noDir: true,
      disp: v => Math.round(v).toLocaleString(), extreme: "max",
      extremeTxt: "highest logged — watch over-rev vs the prop" },
  ];

  // series: comparable library metas [{id, logTime, stats}] sorted oldest→newest,
  // INCLUDING the open log. currentId = the open log's id.
  function trends(series, currentId) {
    const S = (series || []).filter(s => s && s.stats);
    const N = S.length;
    if (N < 2) return { enough: false, n: N, items: [] };
    const cur = S.find(s => s.id === currentId) || S[N - 1];
    const dv = (m, v) => m.disp ? m.disp(v) : (v.toFixed(m.dg || 0) + (m.unit || ""));
    const items = [];

    TREND_METRICS.forEach(m => {
      const arr = S.map(s => s.stats[m.key]).filter(v => typeof v === "number" && isFinite(v));
      if (arr.length < 2) return;
      const curV = (cur.stats && isFinite(cur.stats[m.key])) ? cur.stats[m.key] : null;
      let gotDir = false;

      // chronic — breached across most of the set
      if (m.breach) {
        const br = arr.filter(m.breach).length;
        if (br && (br === arr.length || br >= Math.max(3, Math.ceil(0.6 * arr.length)))) {
          const worst = m.worse > 0 ? max(arr) : min(arr);
          items.push({ sev: arr.some(m.crit) ? "crit" : "warn", tag: "Chronic", ic: "▲",
            msg: `${m.label} ${m.breachTxt} in ${br} of ${arr.length} runs — worst ${dv(m, worst)}.` });
        }
      }

      // direction — meaningful drift over the most recent runs
      if (!m.noDir && arr.length >= 3) {
        const win = arr.slice(-4), first = win[0], last = win[win.length - 1], net = last - first;
        let step = 0; for (let i = 1; i < win.length; i++) step += Math.sign(win[i] - win[i - 1]) === Math.sign(net) ? 1 : -1;
        if (Math.abs(net) / (Math.abs(mean(win)) || 1) >= 0.12 && step > 0) {
          const worsening = Math.sign(net) === m.worse;
          items.push({ sev: worsening ? "warn" : "ok", tag: worsening ? "Worsening" : "Improving",
            ic: net < 0 ? "↘" : "↗",
            msg: `${m.label} ${net < 0 ? "falling" : "rising"}: ${win.map(v => dv(m, v)).join(" → ")} (last ${win.length} runs).` });
          gotDir = true;
        }
      }

      // this run is a fresh extreme (skip if a direction line already covers it)
      if (!gotDir && m.extreme && curV != null && max(arr) !== min(arr)) {
        const hi = m.extreme === "max", ext = hi ? max(arr) : min(arr);
        if (curV === ext)
          items.push({ sev: "warn", tag: hi ? "New high" : "New low", ic: hi ? "↑" : "↓",
            msg: m.extremeTxt ? `${m.label} ${dv(m, curV)} — ${m.extremeTxt}.`
              : `This run's ${m.label.toLowerCase()} (${dv(m, curV)}) is your ${hi ? "highest" : "lowest"} logged.` });
      }
    });

    const faults = S.filter(s => s.stats && s.stats.vtecFault).length;
    if (faults) items.push({ sev: "warn", tag: "Recurring", ic: "⚠",
      msg: `VTEC fault flagged in ${faults} of ${N} runs — check the solenoid output/wiring.` });

    const rank = { crit: 0, warn: 1, ok: 2 };
    items.sort((a, b) => rank[a.sev] - rank[b.sev]);
    return { enough: true, n: N, items: items.slice(0, 6) };
  }

  global.Analysis = { segment, setWindow, raceWindow, lapInfo, binStats,
    flags, kpis, summaryStats, trends, ECT_OPT, ECT_COLD };
})(window);
