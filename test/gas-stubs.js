/* In-memory stand-ins for the Google Apps Script services the backend uses, so it can run in a browser for tests.
   Hashes here are simple non-cryptographic stand-ins: tests only need them to be consistent. */
(function () {
  'use strict';

  function colIndex(letters) { return letters.split('').reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0); }

  class Range {
    constructor(sheet, row, col, rows, cols) { Object.assign(this, { sheet, row, col, rows, cols }); }
    getValues() {
      const out = [];
      for (let r = 0; r < this.rows; r++) {
        const line = [];
        for (let c = 0; c < this.cols; c++) {
          const v = (this.sheet.data[this.row - 1 + r] || [])[this.col - 1 + c];
          line.push(v === undefined || v === null ? '' : v);
        }
        out.push(line);
      }
      return out;
    }
    getValue() { return this.getValues()[0][0]; }
    setValues(values) {
      values.forEach((line, r) => line.forEach((v, c) => this.sheet.set(this.row + r, this.col + c, v)));
      return this;
    }
    setValue(v) { this.sheet.set(this.row, this.col, v); return this; }
    setFontWeight() { return this; }
    setNumberFormat() { return this; }
  }

  class Sheet {
    constructor(name) { this.name = name; this.data = []; }
    getName() { return this.name; }
    set(row, col, v) {
      while (this.data.length < row) this.data.push([]);
      const line = this.data[row - 1];
      while (line.length < col) line.push('');
      line[col - 1] = v instanceof Date ? new Date(v.getTime()) : v;
    }
    getLastRow() {
      for (let r = this.data.length; r > 0; r--) if ((this.data[r - 1] || []).some(v => v !== '' && v !== null && v !== undefined)) return r;
      return 0;
    }
    getLastColumn() { return this.data.reduce((m, line) => { let c = line.length; while (c > 0 && (line[c - 1] === '' || line[c - 1] == null)) c--; return Math.max(m, c); }, 0); }
    getDataRange() { return new Range(this, 1, 1, Math.max(1, this.getLastRow()), Math.max(1, this.getLastColumn())); }
    getRange(a, b, c, d) {
      if (typeof a === 'string') {
        const m = a.match(/^([A-Z]+)(\d*)(?::([A-Z]+)(\d*))?$/);
        return new Range(this, Number(m[2]) || 1, colIndex(m[1]), 1, 1);
      }
      return new Range(this, a, b, c || 1, d || 1);
    }
    setFrozenRows() {}
  }

  const sheets = {};
  const spreadsheet = {
    getName: () => 'Parts Tracker (test)',
    getSheetByName: n => sheets[n] || null,
    insertSheet: n => (sheets[n] = new Sheet(n)),
    getSheets: () => Object.values(sheets)
  };
  window.SpreadsheetApp = { getActiveSpreadsheet: () => spreadsheet, openById: () => spreadsheet, getUi: () => ({ alert() {}, createMenu() { return { addItem() { return this; }, addSeparator() { return this; }, addToUi() {} }; } }) };

  // Simple consistent hash -> 32 signed bytes
  function fakeHash(str) {
    const out = [];
    let h = 2166136261;
    for (let round = 0; round < 32; round++) {
      for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i) + round; h = Math.imul(h, 16777619) >>> 0; }
      out.push(((h & 0xff) << 24) >> 24);
    }
    return out;
  }
  const toBytes = s => Array.from(new TextEncoder().encode(String(s)), b => (b << 24) >> 24);
  const fromBytes = bytes => new TextDecoder().decode(new Uint8Array(bytes.map(b => (b + 256) % 256)));
  const b64 = bytes => btoa(String.fromCharCode(...bytes.map(b => (b + 256) % 256))).replace(/\+/g, '-').replace(/\//g, '_');

  window.Utilities = {
    DigestAlgorithm: { MD5: 'MD5', SHA_256: 'SHA_256' },
    Charset: { UTF_8: 'UTF_8' },
    getUuid: () => crypto.randomUUID(),
    computeDigest: (alg, str) => fakeHash(alg + ':' + str),
    computeHmacSha256Signature: (value, key) => fakeHash('hmac:' + key + ':' + value),
    base64EncodeWebSafe: v => b64(typeof v === 'string' ? toBytes(v) : v),
    base64DecodeWebSafe: s => Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), ch => (ch.charCodeAt(0) << 24) >> 24),
    newBlob: bytes => ({ getDataAsString: () => fromBytes(bytes) })
  };

  const cache = {};
  window.CacheService = { getScriptCache: () => ({ get: k => cache[k] || null, put: (k, v) => { cache[k] = v; }, remove: k => { delete cache[k]; } }) };
  window.LockService = { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) };
  const props = {};
  window.PropertiesService = { getScriptProperties: () => ({ getProperty: k => props[k] || null, setProperty: (k, v) => { props[k] = v; } }) };
  window.ContentService = { MimeType: { JSON: 'json' }, createTextOutput: s => ({ setMimeType() { return this; }, getContent: () => s }) };

  window.__gas = { sheets, cache, props };
})();
