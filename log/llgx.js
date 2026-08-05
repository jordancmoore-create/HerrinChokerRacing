/* llgx.js — in-browser parser for Link ECU (PCLink G5) .llgx logs.
   Faithful port of the validated Python parser. All client-side. */
(function (global) {
  "use strict";
  const td16 = new TextDecoder("utf-16le");
  const UNIT_FIX = { Pressure: "kPa", Temperature: "°C" };

  const DS3 = [0x64, 0x73, 0x33];  // "ds3" channel-block tag
  const LM1 = [0x6c, 0x6d, 0x31];  // "lm1" marker tag
  const MAGIC = [0x6c, 0x66, 0x33]; // "lf3"
  const HDR = 0x285, NAME = 0xD3, UNIT = 0x19B, COUNT = 3;

  function find(buf, seq, from) {
    const n = buf.length, m = seq.length;
    outer: for (let i = from; i <= n - m; i++) {
      for (let j = 0; j < m; j++) if (buf[i + j] !== seq[j]) continue outer;
      return i;
    }
    return -1;
  }

  function utf16At(buf, off, maxBytes) {
    maxBytes = maxBytes || 512;
    let end = off;
    while (end + 1 < buf.length && !(buf[end] === 0 && buf[end + 1] === 0)
           && (end - off) < maxBytes) end += 2;
    return td16.decode(buf.subarray(off, end));
  }

  function scanUtf16(buf, a, b, minChars) {
    const out = [];
    let i = a;
    while (i < b - 1) {
      if (buf[i] >= 0x20 && buf[i] < 0x7f && buf[i + 1] === 0) {
        let j = i;
        while (j < b - 1 && buf[j] >= 0x20 && buf[j] < 0x7f && buf[j + 1] === 0) j += 2;
        if ((j - i) / 2 >= minChars) out.push([i, td16.decode(buf.subarray(i, j))]);
        i = j;
      } else i++;
    }
    return out;
  }

  function classifyMeta(strings) {
    let model = "", serial = "", title = ""; const vers = [];
    for (const [, s] of strings) {
      if (s.indexOf("Monsoon") >= 0 || s.slice(0, 2) === "G4" || s.slice(0, 2) === "G5") {
        if (!model) model = s;
      } else if (s.indexOf("Datalog") >= 0) { if (!title) title = s; }
      else if (/^[0-9.]+$/.test(s) && s.indexOf(".") >= 0) vers.push(s);
      else if (/^[0-9]+$/.test(s) && s.length >= 5) { if (!serial) serial = s; }
    }
    return {
      ecu_model: model, firmware: vers[0] || "", pclink_version: vers[1] || "",
      serial: serial, title: title,
    };
  }

  function channelLookup(channels) {
    return function (name) {
      const nl = name.toLowerCase();
      let c = channels.find(c => c.name.toLowerCase() === nl);
      if (!c) c = channels.find(c => c.name.toLowerCase().indexOf(nl) >= 0);
      return c || null;
    };
  }

  // Link's internal datalog keeps two clocks and they disagree. The ECU samples
  // at exactly its configured rate, but the timestamp it writes only advances
  // ~0.981 s per nominal second — on a 20 Hz channel every 20th interval comes
  // out at 31 ms instead of 50 ms — so a log reads about 1.9 % short. Sample
  // count over the configured rate is the trustworthy clock: on the Brockville
  // Saturday log all seven populated channels, across four different rates, agree
  // on 493.5 s while the timestamps claim 484.1 s, and 493.5 s is what reproduces
  // the official 234.85 s race time. So rebuild each channel's timebase from the
  // sample index. Channels whose spacing isn't uniform are left alone — a log
  // with a real recording gap must not be silently stretched.
  const RATES = [1, 2, 4, 5, 10, 20, 25, 40, 50, 100, 200];

  function rebuildTimes(ch) {
    const t = ch.times, n = t.length;
    if (n < 20) return 0;
    const d = new Array(n - 1);
    for (let i = 1; i < n; i++) d[i - 1] = t[i] - t[i - 1];
    d.sort((a, b) => a - b);
    const med = d[d.length >> 1], mx = d[d.length - 1];
    if (!(med > 0) || mx > 2.5 * med) return 0;      // recording gap → leave as logged
    let rate = 0;
    for (let i = 0; i < RATES.length; i++)
      if (Math.abs(1 / med - RATES[i]) <= 0.03 * RATES[i]) { rate = RATES[i]; break; }
    if (!rate) return 0;                             // unrecognised rate → leave as logged
    const t0 = t[0], span = t[n - 1] - t0;
    if (!(span > 0)) return 0;
    for (let i = 0; i < n; i++) t[i] = t0 + i / rate;
    return (t[n - 1] - t0) / span;
  }

  function parse(arrayBuffer) {
    const buf = new Uint8Array(arrayBuffer);
    const dv = new DataView(arrayBuffer);
    if (find(buf.subarray(0, 16), MAGIC, 0) < 0)
      throw new Error("Not a recognised .llgx (missing 'lf3' magic)");

    const firstTag = find(buf, DS3, 0);
    if (firstTag < 0) throw new Error("No channel blocks ('ds3') found");

    const info = classifyMeta(scanUtf16(buf, 0, firstTag, 3));

    const markers = [];
    let p = 0, mi;
    while ((mi = find(buf, LM1, p)) >= 0 && mi < firstTag) {
      const s = utf16At(buf, mi + 3); if (s) markers.push(s); p = mi + 3;
    }

    const channels = [];
    let pos = firstTag, tag;
    while ((tag = find(buf, DS3, pos)) >= 0) {
      const count = dv.getUint32(tag + COUNT, true);
      const name = utf16At(buf, tag + NAME);
      let unit = utf16At(buf, tag + UNIT).trim();
      const dataOff = tag + HDR;
      const nAvail = Math.floor((buf.length - dataOff) / 8);
      let n = (count > 0 && count < 1e7) ? Math.min(count, nAvail) : nAvail;
      const nxt = find(buf, DS3, tag + 4);
      if (nxt > 0) n = Math.min(n, Math.floor((nxt - 4 - dataOff) / 8));
      const times = new Float64Array(n), values = new Float64Array(n);
      let o = dataOff;
      for (let i = 0; i < n; i++) {
        values[i] = dv.getFloat32(o, true);
        times[i] = dv.getFloat32(o + 4, true);
        o += 8;
      }
      channels.push({ name: name, unit: UNIT_FIX[unit] || unit, times: times, values: values });
      pos = tag + 4;
    }

    let recorded = 0;
    for (const c of channels) if (c.times.length) recorded = Math.max(recorded, c.times[c.times.length - 1]);

    const scales = [];
    for (const c of channels) { const s = rebuildTimes(c); if (s) scales.push(s); }
    scales.sort((a, b) => a - b);

    let duration = 0;
    for (const c of channels) if (c.times.length) duration = Math.max(duration, c.times[c.times.length - 1]);

    const timebase = {
      rebuilt: scales.length > 0, channels: scales.length, total: channels.length,
      scale: scales.length ? scales[scales.length >> 1] : 1, recorded: recorded,
    };
    const log = Object.assign({}, info, { markers, channels, duration, timebase });
    log.channel = channelLookup(channels);
    return log;
  }

  global.LLGX = { parse };
})(window);
