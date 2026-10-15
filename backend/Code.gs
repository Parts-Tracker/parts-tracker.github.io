/**
 * Parts Tracker - backend (Google Apps Script, bound to the tracker Google Sheet).
 *
 * The phone app (hosted separately) POSTs JSON to this web app's /exec URL:
 *   { action: 'bootstrap' | 'login' | 'submit' | 'admin', ...fields }
 * and gets back { ok: true, ... } or { ok: false, error, code }.
 *
 * Stock is never typed in: it is the sum of the Movements rows for a site.
 */

// Leave blank when this script is attached to the Sheet (Extensions > Apps Script).
// For a separate Apps Script project, paste the Sheet's ID: the long part of its address
// between /d/ and /edit, e.g. https://docs.google.com/spreadsheets/d/THIS_PART/edit
const SHEET_ID = '';

const SHEETS = {
  Sites: ['SiteID', 'Name', 'Address', 'Postcode', 'Contact', 'Phone', 'Token', 'Active', 'LastCount'],
  Printers: ['SiteID', 'Model', 'Serial'],
  Parts: ['Family', 'Name', 'ExactCodes', 'Cost', 'Reviewed', 'AddedBy', 'AddedAt'],
  Users: ['UserID', 'Name', 'Role', 'PIN', 'PinHash', 'Active'],
  Movements: ['MovementID', 'Timestamp', 'SiteID', 'Family', 'ExactCode', 'Qty', 'Type', 'JobNo', 'By', 'Role', 'Device', 'Note', 'BatchID'],
  Kits: ['Model', 'Family', 'Qty']
};

// Which movement types each role may record, and the sign of their quantity
const MOVEMENT_TYPES = {
  BOOK_IN: { sign: 1, roles: ['customer', 'engineer', 'admin'] },
  CUSTOMER_FITTED: { sign: -1, roles: ['customer', 'engineer', 'admin'] },
  USED: { sign: -1, roles: ['engineer', 'admin'], needsJob: true },
  COUNT: { sign: 0, roles: ['engineer', 'admin'] }
};

const SESSION_HOURS = 24 * 30; // engineers stay signed in on their phone for 30 days
const USERS_CACHE_SECONDS = 300;
const MAX_PIN_FAILS = 5;          // wrong PINs per site (or the admin page) in 10 minutes
const MAX_PIN_FAILS_TOTAL = 30;   // wrong PINs across everything in 10 minutes, so varying the site cannot get round the limit

// ---------------------------------------------------------------- entry points

function doGet() {
  return json_({ ok: true, service: 'parts-tracker', time: new Date().toISOString() });
}

function doPost(e) {
  let req;
  try {
    req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (err) {
    return json_({ ok: false, code: 'bad_request', error: 'Request was not valid JSON.' });
  }
  try {
    const handler = ACTIONS[req.action];
    if (!handler) return json_({ ok: false, code: 'bad_request', error: 'Unknown action.' });
    return json_(Object.assign({ ok: true }, handler(req)));
  } catch (err) {
    if (err && err.code) return json_({ ok: false, code: err.code, error: err.message });
    console.error(err && err.stack || err);
    return json_({ ok: false, code: 'server', error: 'Something went wrong on the server: ' + (err && err.message) });
  }
}

const ACTIONS = {
  bootstrap: actionBootstrap,
  login: actionLogin,
  submit: actionSubmit,
  admin: actionAdmin
};

// ---------------------------------------------------------------- actions

/** Everything the app needs for one site: details, printers, stock, recent activity, and the parts list if it changed. */
function actionBootstrap(req) {
  const site = siteFromToken_(req.site);
  const parts = readTable_('Parts');
  const names = partNames_(parts);
  const out = {
    site: { id: site.SiteID, name: site.Name, address: site.Address, postcode: site.Postcode, lastCount: iso_(site.LastCount) },
    printers: readTable_('Printers').filter(p => String(p.SiteID) === String(site.SiteID)).map(p => p.Model),
    stock: stockList_(site.SiteID, names),
    recent: recentMovements_(site.SiteID, names, 10),
    partsVersion: partsVersion_(parts)
  };
  if (req.partsVersion !== out.partsVersion) out.parts = parts.map(p => [p.Family, p.Name, String(p.ExactCodes || '')]);
  if (req.session) {
    const user = sessionUser_(req.session, true);
    if (user) out.user = { name: user.Name, role: user.Role };
  }
  return out;
}

/** PIN sign-in for engineers and admins. Returns a signed session token. */
function actionLogin(req) {
  const pin = String(req.pin || '').trim();
  const failKey = 'pinfail:' + String(req.site || 'admin').slice(0, 40);
  const cache = CacheService.getScriptCache();
  const fails = Number(cache.get(failKey) || 0);
  const totalFails = Number(cache.get('pinfail:all') || 0);
  if (fails >= MAX_PIN_FAILS || totalFails >= MAX_PIN_FAILS_TOTAL) throw err_('locked', 'Too many wrong PINs. Wait 10 minutes and try again.');
  if (!/^\d{4,8}$/.test(pin)) throw err_('bad_pin', 'PIN must be 4 to 8 digits.');

  // Fast path: the user list from the cache. If the PIN is not found there, re-read the Sheet
  // (and secure any newly typed PINs) before saying it is wrong, so new users work straight away.
  const hash = pinHash_(pin);
  const find = users => users.filter(u => u.Active && u.PinHash === hash);
  let matches = find(cachedUsers_());
  if (matches.length !== 1) {
    hashPendingPins_();
    matches = find(cachedUsers_(true));
  }
  if (matches.length !== 1) {
    cache.put(failKey, String(fails + 1), 600);
    cache.put('pinfail:all', String(totalFails + 1), 600);
    throw err_('bad_pin', matches.length > 1 ? 'That PIN is shared by two people. Ask an admin to change one.' : 'Wrong PIN.');
  }
  cache.remove(failKey);
  const user = matches[0];
  return { session: makeSession_(user), user: { name: user.Name, role: user.Role } };
}

/**
 * Record a batch of scans for a site.
 * req: { site, session?, batchId, type, jobNo?, device?, note?, items: [{ code, qty, name? }], zero?: [family] }
 * For COUNT, items are the counted quantities and `zero` lists families to set to 0.
 */
function actionSubmit(req) {
  const site = siteFromToken_(req.site);
  const user = req.session ? sessionUser_(req.session, false) : null;
  const role = user ? String(user.Role).toLowerCase() : 'customer';
  const by = user ? user.Name : 'Customer';
  const type = String(req.type || '');
  const spec = MOVEMENT_TYPES[type];
  if (!spec) throw err_('bad_request', 'Unknown movement type.');
  if (spec.roles.indexOf(role) < 0) throw err_('forbidden', 'Only engineers can do that. Sign in with your PIN.');
  const jobNo = String(req.jobNo || '').trim();
  if (spec.needsJob && !jobNo) throw err_('bad_request', 'A job or ticket number is needed for parts used.');
  const batchId = String(req.batchId || '').slice(0, 64);
  if (!batchId) throw err_('bad_request', 'Missing batch id.');
  const items = Array.isArray(req.items) ? req.items : [];
  if (!items.length && !(type === 'COUNT' && (req.zero || []).length)) throw err_('bad_request', 'Nothing to record.');

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    // The phone retries batches it could not confirm, so ignore one already recorded
    if (batchSeen_(batchId)) {
      return { duplicate: true, stock: stockList_(site.SiteID, partNames_(readTable_('Parts'))) };
    }

    // Normalise codes and add any new parts to the catalogue (marked unreviewed)
    const parts = readTable_('Parts');
    const byFamily = {};
    parts.forEach(p => { byFamily[p.Family] = p; });
    const lines = [];
    const newParts = [];
    items.forEach(it => {
      const n = normaliseCode(it.code);
      if (!n.family) return;
      const qty = Math.max(0, Math.floor(Number(it.qty) || 0));
      if (type !== 'COUNT' && qty < 1) return;
      if (!byFamily[n.family]) {
        const part = { Family: n.family, Name: String(it.name || '').trim().slice(0, 120) || 'Unnamed part', ExactCodes: n.exact, Cost: '', Reviewed: false, AddedBy: by, AddedAt: new Date() };
        byFamily[n.family] = part;
        newParts.push(part);
      } else if (n.exact !== n.family) {
        addExactCode_(byFamily[n.family], n.exact);
      }
      lines.push({ family: n.family, exact: n.exact, qty: qty, odd: !!n.warning });
    });
    if (newParts.length) appendObjects_('Parts', newParts);

    const now = new Date();
    const device = String(req.device || '').slice(0, 80);
    const note = String(req.note || '').slice(0, 200);
    const rows = [];
    const row = (family, exact, qty, rowNote) => rows.push({
      MovementID: Utilities.getUuid(), Timestamp: now, SiteID: site.SiteID, Family: family, ExactCode: exact,
      Qty: qty, Type: type, JobNo: jobNo, By: by, Role: role, Device: device, Note: rowNote || note, BatchID: batchId
    });

    const current = stockBySite_(site.SiteID);
    const warnings = [];
    if (type === 'COUNT') {
      // Counted lines set the quantity; families in `zero` are set to 0. Only differences are written.
      const counted = {};
      lines.forEach(l => { counted[l.family] = (counted[l.family] || 0) + l.qty; });
      (req.zero || []).forEach(f => { const fam = normaliseCode(f).family; if (fam && counted[fam] === undefined) counted[fam] = 0; });
      Object.keys(counted).forEach(fam => {
        const was = current[fam] || 0;
        const delta = counted[fam] - was;
        if (delta !== 0) row(fam, fam, delta, 'counted ' + counted[fam] + ', was ' + was + (note ? '. ' + note : ''));
      });
      setSiteField_(site, 'LastCount', now);
    } else {
      lines.forEach(l => {
        const qty = spec.sign * l.qty;
        let rowNote = l.odd ? 'unusual code' : '';
        if (spec.sign < 0) {
          const after = (current[l.family] || 0) + qty;
          current[l.family] = after;
          if (after < 0) {
            rowNote = (rowNote ? rowNote + '; ' : '') + 'stock went below zero: count may be wrong';
            warnings.push(l.family);
          }
        }
        row(l.family, l.exact, qty, rowNote);
      });
    }
    if (rows.length) appendObjects_('Movements', rows);
    rememberBatch_(batchId);

    const names = partNames_(readTable_('Parts'));
    return { recorded: rows.length, newParts: newParts.map(p => p.Family), belowZero: warnings, stock: stockList_(site.SiteID, names) };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Admin dashboard data in one request: every active site (QR token, town, printers, last count,
 * last activity), every non-zero stock line across all sites, and part names for the search.
 * stock rows are [siteIndex, family, qty] to keep the response small.
 */
function actionAdmin(req) {
  const user = sessionUser_(req.session, false);
  if (String(user.Role).toLowerCase() !== 'admin') throw err_('forbidden', 'Admins only.');
  ensureSiteTokens_();
  const iTime = SHEETS.Movements.indexOf('Timestamp');
  const lines = {};
  const lastActivity = {};
  movementColumns_().forEach(m => {
    const k = m.site + '|' + m.family;
    lines[k] = (lines[k] || 0) + m.qty;
    const t = m.row[iTime];
    if (t instanceof Date && (!lastActivity[m.site] || t > lastActivity[m.site])) lastActivity[m.site] = t;
  });
  const printers = {};
  readTable_('Printers').forEach(p => { (printers[String(p.SiteID)] = printers[String(p.SiteID)] || []).push(String(p.Model)); });
  const sites = readTable_('Sites').filter(s => isTrue_(s.Active) && s.Name);
  const index = {};
  sites.forEach((s, i) => { index[String(s.SiteID)] = i; });
  const stock = [];
  const totals = {};
  Object.keys(lines).forEach(k => {
    const [site, family] = k.split('|');
    if (index[site] === undefined || !lines[k]) return;
    stock.push([index[site], family, lines[k]]);
    if (lines[k] > 0) totals[site] = (totals[site] || 0) + lines[k];
  });
  const parts = readTable_('Parts');
  return {
    sites: sites.map(s => ({
      id: s.SiteID, name: s.Name, town: s.Address, postcode: s.Postcode, token: s.Token,
      items: totals[s.SiteID] || 0, lastCount: iso_(s.LastCount), lastActivity: iso_(lastActivity[String(s.SiteID)]),
      printers: printers[String(s.SiteID)] || []
    })),
    stock: stock,
    parts: parts.map(p => [p.Family, p.Name, String(p.ExactCodes || '')]),
    unreviewedParts: parts.filter(p => !isTrue_(p.Reviewed)).length
  };
}

// ---------------------------------------------------------------- part codes

/**
 * Exact code = spaces removed, capitals, FFB/FB prefix replaced by P, P added if missing.
 * Family code = P + 3 digits + letter + first 4 digits + X  (059K58130 -> P059K5813X, FFB053K9189X -> P053K9189X).
 * Keep identical to normalise() in web/codes.js.
 */
function normaliseCode(raw) {
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

// ---------------------------------------------------------------- stock

function movementColumns_() {
  const sh = sheet_('Movements');
  const last = sh.getLastRow();
  if (last < 2) return [];
  const head = SHEETS.Movements;
  const iSite = head.indexOf('SiteID'), iFam = head.indexOf('Family'), iQty = head.indexOf('Qty');
  return sh.getRange(2, 1, last - 1, head.length).getValues().map(r => ({ site: String(r[iSite]), family: String(r[iFam]), qty: Number(r[iQty]) || 0, row: r }));
}

function stockBySite_(siteId) {
  const out = {};
  movementColumns_().forEach(m => {
    if (m.site === String(siteId)) out[m.family] = (out[m.family] || 0) + m.qty;
  });
  return out;
}

function stockList_(siteId, names) {
  const s = stockBySite_(siteId);
  return Object.keys(s).filter(f => s[f] !== 0)
    .map(f => ({ family: f, name: names[f] || '', qty: s[f] }))
    .sort((a, b) => (a.name || a.family).localeCompare(b.name || b.family));
}

function recentMovements_(siteId, names, limit) {
  const head = SHEETS.Movements;
  const idx = k => head.indexOf(k);
  return movementColumns_().filter(m => m.site === String(siteId)).slice(-limit).reverse().map(m => ({
    at: iso_(m.row[idx('Timestamp')]), family: m.family, name: names[m.family] || '', qty: m.qty,
    type: m.row[idx('Type')], by: m.row[idx('By')], jobNo: m.row[idx('JobNo')]
  }));
}

function partNames_(parts) {
  const names = {};
  parts.forEach(p => { names[p.Family] = p.Name; });
  return names;
}

function partsVersion_(parts) {
  const text = parts.map(p => p.Family + '|' + p.Name + '|' + p.ExactCodes).join('\n');
  return hex_(Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, text, Utilities.Charset.UTF_8));
}

function addExactCode_(part, exact) {
  const codes = String(part.ExactCodes || '').split(/[\s,]+/).filter(Boolean);
  if (codes.indexOf(exact) >= 0 || part._row === undefined) return;
  codes.push(exact);
  part.ExactCodes = codes.join(', ');
  sheet_('Parts').getRange(part._row, SHEETS.Parts.indexOf('ExactCodes') + 1).setValue(part.ExactCodes);
}

// ---------------------------------------------------------------- batches (offline retries)

function batchSeen_(batchId) {
  if (CacheService.getScriptCache().get('batch:' + batchId)) return true;
  const sh = sheet_('Movements');
  const last = sh.getLastRow();
  if (last < 2) return false;
  const col = SHEETS.Movements.indexOf('BatchID') + 1;
  const start = Math.max(2, last - 4999);
  return sh.getRange(start, col, last - start + 1, 1).getValues().some(r => r[0] === batchId);
}

function rememberBatch_(batchId) {
  CacheService.getScriptCache().put('batch:' + batchId, '1', 21600);
}

// ---------------------------------------------------------------- sites, users, sessions

function siteFromToken_(token) {
  token = String(token || '').trim();
  if (token.length < 16) throw err_('bad_site', 'This QR code is not valid. Ask for a new one.');
  const site = readTable_('Sites').find(s => String(s.Token) === token);
  if (!site || !isTrue_(site.Active)) throw err_('bad_site', 'This site is not recognised. The QR code may have been replaced.');
  return site;
}

function setSiteField_(site, field, value) {
  sheet_('Sites').getRange(site._row, SHEETS.Sites.indexOf(field) + 1).setValue(value);
}

/** Gives every named site an ID, a QR token and Active=true where missing. */
function ensureSiteTokens_() {
  const sh = sheet_('Sites');
  readTable_('Sites').forEach(s => {
    if (!s.Name) return;
    if (!s.SiteID) sh.getRange(s._row, SHEETS.Sites.indexOf('SiteID') + 1).setValue('S' + String(s._row - 1).padStart(4, '0'));
    if (!s.Token) sh.getRange(s._row, SHEETS.Sites.indexOf('Token') + 1).setValue(newToken_());
    if (s.Active === '' || s.Active === null) sh.getRange(s._row, SHEETS.Sites.indexOf('Active') + 1).setValue(true);
  });
}

function newToken_() {
  return (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '').slice(0, 32);
}

function secret_() {
  const props = PropertiesService.getScriptProperties();
  let s = props.getProperty('SECRET');
  if (!s) { s = newToken_() + newToken_(); props.setProperty('SECRET', s); }
  return s;
}

function pinHash_(pin) {
  return hex_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, secret_() + ':pin:' + pin, Utilities.Charset.UTF_8));
}

/**
 * Users, from the fast script cache when possible (reading the Sheet takes about a second).
 * Changes made in the Users tab show up within USERS_CACHE_SECONDS, or at once after a failed PIN.
 */
function cachedUsers_(refresh) {
  const cache = CacheService.getScriptCache();
  const hit = refresh ? null : cache.get('users:v1');
  if (hit) return JSON.parse(hit);
  const users = readTable_('Users').map(u => ({
    UserID: String(u.UserID), Name: String(u.Name), Role: String(u.Role).toLowerCase(), PinHash: String(u.PinHash || ''), Active: isTrue_(u.Active)
  }));
  cache.put('users:v1', JSON.stringify(users), USERS_CACHE_SECONDS);
  return users;
}

/** Any PIN typed into the PIN column is hashed into PinHash and the plain PIN cleared. */
function hashPendingPins_() {
  const sh = sheet_('Users');
  const pinCol = SHEETS.Users.indexOf('PIN') + 1, hashCol = SHEETS.Users.indexOf('PinHash') + 1;
  let changed = 0;
  readTable_('Users').forEach(u => {
    const pin = String(u.PIN || '').trim();
    if (!pin) return;
    if (/^\d{4,8}$/.test(pin)) {
      sh.getRange(u._row, hashCol).setValue(pinHash_(pin));
      changed++;
    }
    sh.getRange(u._row, pinCol).setValue('');
  });
  if (changed) CacheService.getScriptCache().remove('users:v1');
  return changed;
}

function makeSession_(user) {
  const payload = [user.UserID, Date.now() + SESSION_HOURS * 3600 * 1000].join('|');
  return Utilities.base64EncodeWebSafe(payload) + '.' + sign_(payload);
}

/** Returns the signed-in user, or throws (or returns null when `soft`) if the session is invalid or expired. */
function sessionUser_(token, soft) {
  const fail = msg => { if (soft) return null; throw err_('session', msg); };
  const parts = String(token || '').split('.');
  if (parts.length !== 2) return fail('Please sign in again.');
  let payload;
  try { payload = Utilities.newBlob(Utilities.base64DecodeWebSafe(parts[0])).getDataAsString(); } catch (e) { return fail('Please sign in again.'); }
  if (sign_(payload) !== parts[1]) return fail('Please sign in again.');
  const bits = payload.split('|');
  if (Number(bits[1]) < Date.now()) return fail('Your sign-in has expired. Enter your PIN again.');
  const user = cachedUsers_().find(u => u.UserID === bits[0] && u.Active);
  return user || fail('Your account is no longer active.');
}

function sign_(payload) {
  return Utilities.base64EncodeWebSafe(Utilities.computeHmacSha256Signature(payload, secret_()));
}

// ---------------------------------------------------------------- sheet helpers

function spreadsheet_() {
  const ss = SHEET_ID ? SpreadsheetApp.openById(SHEET_ID) : SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw err_('setup', 'This script is not attached to a Sheet. Paste the Sheet\'s ID into SHEET_ID at the top of Code.gs.');
  return ss;
}

function sheet_(name) {
  const sh = spreadsheet_().getSheetByName(name);
  if (!sh) throw err_('setup', 'The "' + name + '" tab is missing. Run Parts Tracker > Set up sheets.');
  return sh;
}

/** Rows as objects keyed by header, each with its sheet row number in _row. Blank rows are skipped. */
function readTable_(name) {
  const sh = sheet_(name);
  const values = sh.getDataRange().getValues();
  const head = values[0].map(String);
  const out = [];
  for (let i = 1; i < values.length; i++) {
    if (values[i].every(v => v === '' || v === null)) continue;
    const o = { _row: i + 1 };
    head.forEach((h, j) => { o[h] = values[i][j]; });
    out.push(o);
  }
  return out;
}

function appendObjects_(name, objects) {
  if (!objects.length) return;
  const sh = sheet_(name);
  const head = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(String);
  const values = objects.map(o => head.map(h => (o[h] === undefined ? '' : o[h])));
  const start = sh.getLastRow() + 1;
  sh.getRange(start, 1, values.length, head.length).setValues(values);
  objects.forEach((o, i) => { o._row = start + i; });
}

function isTrue_(v) {
  return v === true || /^(true|yes|y|1)$/i.test(String(v).trim());
}

function iso_(v) {
  if (v instanceof Date) return v.toISOString();
  return v ? String(v) : '';
}

function hex_(bytes) {
  return bytes.map(b => ((b + 256) % 256).toString(16).padStart(2, '0')).join('');
}

function err_(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
