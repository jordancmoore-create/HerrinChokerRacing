/* analysis.js — segmentation, concern flags, and KPI tiles for a parsed log.
   Ported from report.py. Thresholds sourced from the PCLink manual + boat build. */
(function (global) {
  "use strict";

  // tunable reference bands (see assessment with the team)
  const ECT_COLD = 60, ECT_OPT = [75, 90];   // °C: flag below COLD; ideal band
  const VSAG = 11.5;                          // V: voltage-sag spike threshold under load

  function resample(ch, dt, dur) {
    const n = Math.floor(dur / dt) + 1;
    const out = new Float64Array(n);
    for (let k = 0; k < ch.times.length; k++) {
      const b = Math.floor(ch.times[k] / dt);
      if (b >= 0 && b < n) out[b] = ch.values[k];
    }
    for (let i = 1; i < n; i++) if (out[i] === 0) out[i] = out[i - 1];
    return out;
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

  function autocorr(seg, dt, loS, hiS) {
    const m = mean(seg), x = seg.map(v => v - m);
    let den = 0; for (const v of x) den += v * v; den = den || 1;
    let best = [0, -2];
    for (let lag = Math.floor(loS / dt); lag < Math.floor(hiS / dt); lag++) {
      if (lag >= seg.length) break;
      let s = 0; for (let i = 0; i < seg.length - lag; i++) s += x[i] * x[i + lag];
      s /= den; if (s > best[1]) best = [lag * dt, s];
    }
    return best;
  }

  function segment(log) {
    const dt = 0.5, dur = log.duration;
    const rpm = log.channel("Engine Speed"), tps = log.channel("TPS");
    const out = { start: 0, raceStart: 0, raceEnd: 0, lap: 0, nLaps: 0, corner: 0 };
    if (!rpm) return out;
    const rs = resample(rpm, dt, dur);
    let firstRun = -1, a = -1, b = -1;
    for (let i = 0; i < rs.length; i++) {
      if (rs[i] > 1500 && firstRun < 0) firstRun = i;
      if (rs[i] > 4500) { if (a < 0) a = i; b = i; }
    }
    out.start = firstRun > 0 ? firstRun * dt : 0;
    if (a < 0) return out;
    out.raceStart = a * dt; out.raceEnd = b * dt;
    if (tps) {
      const ts = resample(tps, dt, dur).slice(a, b);
      const corner = autocorr(ts, dt, 12, 40);
      let lap = autocorr(ts, dt, 38, 75);
      let lapS = lap[0];
      if (lapS <= 0 || (corner[0] && Math.abs(lapS - 2 * corner[0]) > 12))
        lapS = corner[0] ? 2 * corner[0] : 0;
      out.corner = corner[0]; out.lap = lapS;
      out.nLaps = lapS ? (out.raceEnd - out.raceStart) / lapS : 0;
    }
    return out;
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

  global.Analysis = { segment, flags, kpis, summaryStats, trends, resample, ECT_OPT, ECT_COLD };
})(window);
