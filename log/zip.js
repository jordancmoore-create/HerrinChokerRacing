/* zip.js — minimal STORE-only (no compression) ZIP writer. Dependency-free.
   .llgx data is float-dense and barely compresses, so "store" is fine and keeps
   this tiny. Used by the Publish feature to bundle manifest.json + logs/. */
(function (global) {
  "use strict";
  const crcTable = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c >>> 0; }
    return t;
  })();
  function crc32(u8) { let c = 0xFFFFFFFF; for (let i = 0; i < u8.length; i++) c = crcTable[(c ^ u8[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
  const u16 = v => [v & 255, (v >> 8) & 255];
  const u32 = v => [v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >> 24) & 255];

  // files: [{ name, data:Uint8Array }]  →  Blob
  function zipStore(files) {
    const parts = [], central = [];
    let offset = 0;
    const enc = new TextEncoder();
    files.forEach(f => {
      const nameB = enc.encode(f.name), crc = crc32(f.data), sz = f.data.length;
      const local = new Uint8Array([].concat(
        u32(0x04034b50), u16(20), u16(0), u16(0), u16(0), u16(0),
        u32(crc), u32(sz), u32(sz), u16(nameB.length), u16(0)));
      parts.push(local, nameB, f.data);
      const cen = new Uint8Array([].concat(
        u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(0), u16(0),
        u32(crc), u32(sz), u32(sz), u16(nameB.length), u16(0), u16(0), u16(0), u16(0),
        u32(0), u32(offset)));
      central.push(cen, nameB);
      offset += local.length + nameB.length + f.data.length;
    });
    let cdSize = 0; central.forEach(c => cdSize += c.length);
    const end = new Uint8Array([].concat(
      u32(0x06054b50), u16(0), u16(0), u16(files.length), u16(files.length),
      u32(cdSize), u32(offset), u16(0)));
    return new Blob(parts.concat(central, [end]), { type: "application/zip" });
  }

  global.Zip = { zipStore };
})(window);
