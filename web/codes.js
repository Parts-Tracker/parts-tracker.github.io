/* Part code rules, shared by the scanner and the app. Keep normalise() identical to normaliseCode() in backend/Code.gs. */
(function () {
  'use strict';

  // Exact = spaces removed, capitals, FFB/FB prefix replaced by P, P added if missing.
  // Family = P + 3 digits + letter + first 4 digits + X  (059K58130 -> P059K5813X, FFB053K9189X -> P053K9189X).
  function normalise(raw) {
    let s = String(raw || '').toUpperCase().replace(/\s+/g, '');
    if (!s) return { exact: '', family: '', warning: 'Empty code' };
    const prefixed = s.match(/^(?:PFFB|PFB|FFB|FB|P)?(\d{3}[A-Z]\d{4,5}X?)$/);
    if (prefixed) s = 'P' + prefixed[1];
    else if (!s.startsWith('P')) s = 'P' + s;
    const m = s.match(/^P(\d{3}[A-Z]\d{4})\d?X?$/);
    if (m) return { exact: s, family: 'P' + m[1] + 'X', warning: '' };
    const family = /\d$/.test(s) ? s.slice(0, -1) + 'X' : s;
    return { exact: s, family: family, warning: 'Unusual code shape' };
  }

  // Part codes in text read off a label. Text reading confuses some digits with letters
  // (0/O, 1/I, 5/S, 8/B), so digit slots accept both. S is offered as both 5 and 8.
  // Returns family codes, one per part.
  function findCandidates(text) {
    const up = String(text || '').toUpperCase();
    const D = '[0-9OQDILSB]';
    const re = new RegExp('(?:FFB|FB|P)?\\s?(' + D + '{3})\\s?([A-Z])\\s?(' + D + '(?:\\s?' + D + '){3,4})(X?)', 'g');
    const base = t => t.replace(/\s/g, '').replace(/[OQD]/g, '0').replace(/[IL]/g, '1').replace(/B/g, '8');
    const variants = t => {
      let v = [base(t)];
      while (v.some(x => x.includes('S')) && v.length < 4) v = v.flatMap(x => x.includes('S') ? [x.replace('S', '5'), x.replace('S', '8')] : [x]);
      return v.map(x => x.replace(/S/g, '5'));
    };
    const seen = new Set(), out = [];
    let m;
    while ((m = re.exec(up))) {
      for (const a of variants(m[1])) for (const b of variants(m[3])) {
        const code = a + m[2] + b + m[4];
        if (!/^\d{3}[A-Z]\d{4,5}X?$/.test(code)) continue;
        const n = normalise(code);
        if (!seen.has(n.family)) { seen.add(n.family); out.push(n.family); }
      }
    }
    return out;
  }

  // Partial code fragments (e.g. "FFB059K5" from a crumpled label) for narrowing a search
  function findFragments(text) {
    const up = String(text || '').toUpperCase().replace(/\s+/g, ' ');
    const out = new Set();
    const re = /(?:FFB|FB|P)?([0-9O]{3}[A-Z][0-9OSIB]{1,4})/g;
    let m;
    while ((m = re.exec(up))) out.add(m[1].replace(/O/g, '0').replace(/I/g, '1').replace(/S/g, '5').replace(/B/g, '8'));
    return [...out];
  }

  window.PTCodes = { normalise, findCandidates, findFragments };
})();
