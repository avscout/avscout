/*
 * jszip-minimal.js
 * A small, self-contained ZIP builder sufficient for storing multiple HTML files.
 * Uses the STORE compression method (no compression) to avoid needing zlib.
 * Exposes: window.JSZip  (constructor compatible with the subset used in popup.js)
 *
 *   const zip = new JSZip();
 *   zip.file('name.html', stringContent);
 *   const blob = await zip.generateAsync({ type: 'blob' });
 */
(function (global) {
  'use strict';

  /* ── CRC-32 table ───────────────────────────────────────── */
  const crcTable = (function () {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[i] = c;
    }
    return t;
  })();

  function crc32(bytes) {
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) {
      crc = (crc >>> 8) ^ crcTable[(crc ^ bytes[i]) & 0xFF];
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  /* ── String → UTF-8 Uint8Array ──────────────────────────── */
  function toBytes(str) {
    return new TextEncoder().encode(str);
  }

  /* ── Little-endian helpers ──────────────────────────────── */
  function u16(n, buf, off) { buf[off] = n & 0xFF; buf[off+1] = (n >> 8) & 0xFF; }
  function u32(n, buf, off) { u16(n & 0xFFFF, buf, off); u16((n >> 16) & 0xFFFF, buf, off+2); }

  /* ── JSZip-compatible class ─────────────────────────────── */
  function JSZip() {
    this._files = []; // { name, data: Uint8Array }
  }

  JSZip.prototype.file = function (name, content) {
    const data = (typeof content === 'string') ? toBytes(content) : content;
    this._files.push({ name, data });
    return this;
  };

  JSZip.prototype.generateAsync = function (options) {
    return new Promise((resolve) => {
      const parts = [];
      const centralDir = [];
      let offset = 0;

      this._files.forEach(f => {
        const nameBytes = toBytes(f.name);
        const crc       = crc32(f.data);
        const size      = f.data.length;
        const now       = dosDateTime();

        // ── Local file header (30 bytes + name) ──
        const lfh = new Uint8Array(30 + nameBytes.length);
        u32(0x04034B50, lfh, 0);   // signature
        u16(20, lfh, 4);           // version needed
        u16(0,  lfh, 6);           // flags
        u16(0,  lfh, 8);           // compression: STORE
        u16(now.time, lfh, 10);
        u16(now.date, lfh, 12);
        u32(crc,  lfh, 14);
        u32(size, lfh, 18);        // compressed size
        u32(size, lfh, 22);        // uncompressed size
        u16(nameBytes.length, lfh, 26);
        u16(0, lfh, 28);           // extra field length
        lfh.set(nameBytes, 30);

        // ── Central directory entry (46 bytes + name) ──
        const cde = new Uint8Array(46 + nameBytes.length);
        u32(0x02014B50, cde, 0);   // signature
        u16(20, cde, 4);           // version made by
        u16(20, cde, 6);           // version needed
        u16(0,  cde, 8);           // flags
        u16(0,  cde, 10);          // compression: STORE
        u16(now.time, cde, 12);
        u16(now.date, cde, 14);
        u32(crc,  cde, 16);
        u32(size, cde, 20);
        u32(size, cde, 24);
        u16(nameBytes.length, cde, 28);
        u16(0,  cde, 30);          // extra
        u16(0,  cde, 32);          // comment
        u16(0,  cde, 34);          // disk start
        u16(0,  cde, 36);          // internal attr
        u32(0,  cde, 38);          // external attr
        u32(offset, cde, 42);      // local header offset
        cde.set(nameBytes, 46);

        parts.push(lfh, f.data);
        centralDir.push(cde);
        offset += lfh.length + size;
      });

      // ── End of central directory ──
      const cdSize   = centralDir.reduce((s, b) => s + b.length, 0);
      const eocd     = new Uint8Array(22);
      u32(0x06054B50, eocd, 0);
      u16(0, eocd, 4);             // disk number
      u16(0, eocd, 6);             // start disk
      u16(this._files.length, eocd, 8);
      u16(this._files.length, eocd, 10);
      u32(cdSize,  eocd, 12);
      u32(offset,  eocd, 16);
      u16(0, eocd, 20);            // comment length

      const all    = [...parts, ...centralDir, eocd];
      const total  = all.reduce((s, b) => s + b.length, 0);
      const output = new Uint8Array(total);
      let pos = 0;
      all.forEach(b => { output.set(b, pos); pos += b.length; });

      const blob = new Blob([output], { type: 'application/zip' });
      resolve(blob);
    });
  };

  /* ── DOS date/time for "now" ─────────────────────────────── */
  function dosDateTime() {
    const d = new Date();
    const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
    return { date, time };
  }

  global.JSZip = JSZip;
})(typeof window !== 'undefined' ? window : this);
