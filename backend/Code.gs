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

// Column headings as people see them in the Sheet -> the name the code uses.
// "Part Number" holds the family code (e.g. P053K0667X); sheets made before the rename still say "Family".
const HEADER_KEYS = { 'Part Number': 'Family', 'No kit': 'NoKit' };
// Headings are matched ignoring case and spaces, so "No Kit" or "No kit " still work
const HEADER_KEYS_LOOSE = {};
Object.keys(HEADER_KEYS).forEach(h => { HEADER_KEYS_LOOSE[h.toLowerCase().replace(/\s+/g, '')] = HEADER_KEYS[h]; });
Object.keys(HEADER_KEYS).forEach(h => { HEADER_KEYS_LOOSE[HEADER_KEYS[h].toLowerCase()] = HEADER_KEYS[h]; });
const key_ = h => { const t = String(h).trim(); return HEADER_KEYS_LOOSE[t.toLowerCase().replace(/\s+/g, '')] || t; };
/** Printers "No kit": anything typed (TRUE, yes, x, a tick) except blank, FALSE, no or 0. */
const noKit_ = p => { const v = String(p.NoKit == null ? '' : p.NoKit).trim(); return v !== '' && !/^(false|no|n|0)$/i.test(v); };

const SHEETS = {
  Sites: ['SiteID', 'Name', 'Address', 'Postcode', 'Token', 'Active', 'LastCount'],   // no customer contact details are kept
  Printers: ['SiteID', 'Model', 'Serial', 'No kit'],   // No kit TRUE: a machine with no Up Time Kit (e.g. a training machine)
  Parts: ['Part Number', 'Name', 'ExactCodes', 'Cost', 'Reviewed', 'AddedBy', 'AddedAt'],
  Users: ['UserID', 'Name', 'Role', 'PIN', 'PinHash', 'Active', 'Email', 'Postcode', 'ByBox'],   // last three fill the van order form
  Movements: ['MovementID', 'Timestamp', 'SiteID', 'Part Number', 'ExactCode', 'Qty', 'Type', 'JobNo', 'By', 'Role', 'Device', 'Note', 'BatchID'],
  Kits: ['Model', 'Part Number', 'Qty', 'Name'],   // Name is a lookup from the Parts tab, filled in by setup
  VanKit: ['Part Number', 'Min', 'Max', 'Name'],   // one van kit for every engineer
  Settings: ['Setting', 'Value', 'Notes']
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
  admin: actionAdmin,
  van: actionVan,
  sites: actionSites,
  reviewPart: actionReviewPart,
  siteSave: actionSiteSave,
  machineAdd: actionMachineAdd,
  machineMove: actionMachineMove,
  machineRemove: actionMachineRemove
};

// ---------------------------------------------------------------- actions

/** Everything the app needs for one site: details, printers, stock, recent activity, and the parts list if it changed. */
function actionBootstrap(req) {
  const site = siteFromToken_(req.site);
  const parts = readTable_('Parts');
  const names = partNames_(parts);
  const moves = movementsAt_(site.SiteID);
  const out = {
    site: { id: site.SiteID, name: site.Name, address: site.Address, postcode: site.Postcode, lastCount: iso_(site.LastCount) },
    printers: readTable_('Printers').filter(p => String(p.SiteID) === String(site.SiteID)).map(p => p.Model),
    stock: stockLines_(sumStock_(moves), names),
    recent: recentMovements_(moves, names, 10),
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
  // A batch is for a site (QR token) or for the signed-in engineer's own van (req.van)
  const site = req.van ? null : siteFromToken_(req.site);
  const user = req.session ? sessionUser_(req.session, false) : null;
  if (req.van && !user) throw err_('forbidden', 'Sign in with your PIN to use your van stock.');
  if (req.van && VAN_TYPES.indexOf(String(req.type)) < 0) throw err_('bad_request', 'That action is not available for van stock.');
  const locId = req.van ? vanId_(user) : site.SiteID;
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
      return { duplicate: true, stock: stockLines_(stockBySite_(locId), partNames_(readTable_('Parts'))) };
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
      MovementID: Utilities.getUuid(), Timestamp: now, SiteID: locId, Family: family, ExactCode: exact,
      Qty: qty, Type: type, JobNo: jobNo, By: by, Role: role, Device: device, Note: rowNote || note, BatchID: batchId
    });

    const before = stockBySite_(locId);
    const current = Object.assign({}, before);
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
      if (site) setSiteField_(site, 'LastCount', now);
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

    // Stock now: what was there plus the rows just written (no second read of the Movements tab)
    const after = Object.assign({}, before);
    rows.forEach(r => { after[r.Family] = (after[r.Family] || 0) + r.Qty; });
    return { recorded: rows.length, newParts: newParts.map(p => p.Family), belowZero: warnings, stock: stockLines_(after, partNames_(parts.concat(newParts))) };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Every active site, for a signed-in engineer to switch site without scanning the QR code again.
 * Each site's token is the same value printed in its QR code.
 */
function actionSites(req) {
  const user = sessionUser_(req.session, false);
  if (['engineer', 'admin'].indexOf(String(user.Role).toLowerCase()) < 0) throw err_('forbidden', 'Engineers only.');
  return {
    sites: readTable_('Sites').filter(s => isTrue_(s.Active) && s.Name && s.Token)
      .map(s => ({ id: s.SiteID, name: s.Name, town: s.Address, postcode: s.Postcode, token: s.Token }))
  };
}

// ---------------------------------------------------------------- vans

const VAN_TYPES = ['BOOK_IN', 'USED', 'COUNT'];

/** Each engineer's van is a stock location named after their UserID. */
function vanId_(user) {
  return 'VAN-' + user.UserID;
}

/** The van kit: one list of parts with minimum and maximum levels, shared by every engineer. */
function vanKit_() {
  let rows;
  try { rows = readTable_('VanKit'); } catch (e) { return []; }   // tab not set up yet
  return rows.map(r => ({ family: normaliseCode(r.Family).family, min: Number(r.Min) || 0, max: Number(r.Max) || 0 }))
    .filter(k => k.family && k.max >= k.min);
}

/** Everything the app needs for the signed-in engineer's van. */
function actionVan(req) {
  const user = sessionUser_(req.session, false);
  if (['engineer', 'admin'].indexOf(String(user.Role).toLowerCase()) < 0) throw err_('forbidden', 'Engineers only.');
  const loc = vanId_(user);
  const parts = readTable_('Parts');
  const names = partNames_(parts);
  const moves = movementsAt_(loc);
  const out = {
    van: { id: loc, name: user.Name },
    orderDetails: { name: user.Name, email: user.Email || '', postcode: user.Postcode || '', byBox: user.ByBox || '' },
    stock: stockLines_(sumStock_(moves), names),
    recent: recentMovements_(moves, names, 10),
    kit: vanKit_(),
    partsVersion: partsVersion_(parts),
    user: { name: user.Name, role: user.Role }
  };
  if (req.partsVersion !== out.partsVersion) out.parts = parts.map(p => [p.Family, p.Name, String(p.ExactCodes || '')]);
  return out;
}

/**
 * Admin dashboard data in one request: every active site (QR token, town, printers, last count,
 * last activity), every non-zero stock line across all sites, and part names for the search.
 * stock rows are [siteIndex, family, qty] to keep the response small.
 */
function actionAdmin(req) {
  const user = sessionUser_(req.session, false);
  if (String(user.Role).toLowerCase() !== 'admin') throw err_('forbidden', 'Admins only.');
  // Closed sites are included (active: false) so they can be reopened
  const sites = ensureSiteTokens_().filter(s => s.Name);
  const moves = movementColumns_();
  const lastActivity = {};
  moves.forEach(m => {
    const t = m.row.Timestamp;
    if (t instanceof Date && (!lastActivity[m.site] || t > lastActivity[m.site])) lastActivity[m.site] = t;
  });
  const printers = readTable_('Printers'), kitRows = readTable_('Kits');
  const machines = {};
  printers.forEach(p => {
    (machines[String(p.SiteID)] = machines[String(p.SiteID)] || []).push({ row: p._row, model: String(p.Model), serial: String(p.Serial || ''), noKit: noKit_(p) });
  });
  const index = {};
  sites.forEach((s, i) => { index[String(s.SiteID)] = i; });
  const stockAt = stockAll_(moves);
  const stock = [];
  const totals = {};
  Object.keys(stockAt).forEach(site => {
    if (index[site] === undefined) return;
    Object.keys(stockAt[site]).forEach(family => {
      const qty = stockAt[site][family];
      if (!qty) return;
      stock.push([index[site], family, qty]);
      if (qty > 0) totals[site] = (totals[site] || 0) + qty;
    });
  });
  const parts = readTable_('Parts');
  return {
    sites: sites.map(s => ({
      id: s.SiteID, name: s.Name, town: s.Address, postcode: s.Postcode, token: s.Token,
      items: totals[s.SiteID] || 0, lastCount: iso_(s.LastCount), lastActivity: iso_(lastActivity[String(s.SiteID)]),
      printers: (machines[String(s.SiteID)] || []).map(m => m.model),
      machines: machines[String(s.SiteID)] || [],
      active: isTrue_(s.Active)
    })),
    models: knownModels_(printers, kitRows),
    kits: kitsByModel_(kitRows),
    stock: stock,
    parts: parts.map(p => [p.Family, p.Name, String(p.ExactCodes || '')]),
    unreviewedParts: parts.filter(p => !isTrue_(p.Reviewed)).length,
    newParts: parts.filter(p => !isTrue_(p.Reviewed)).map(p => ({
      family: p.Family, name: p.Name, codes: String(p.ExactCodes || ''), addedBy: p.AddedBy, addedAt: iso_(p.AddedAt)
    }))
  };
}

// ---------------------------------------------------------------- sites and machines (admin)

function requireAdmin_(req) {
  const user = sessionUser_(req.session, false);
  if (String(user.Role).toLowerCase() !== 'admin') throw err_('forbidden', 'Admins only.');
  return user;
}

const cleanText_ = (v, max) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max);
/** Model names are matched exactly against the Kits tab, so they are stored one way: capitals, single spaces. */
const cleanModel_ = v => cleanText_(v, 40).toUpperCase();

/** Every model in use or with a kit, for the admin's pick list. Pass the tabs if they have already been read. */
function knownModels_(printers, kitRows) {
  const set = {};
  (printers || readTable_('Printers')).forEach(p => { const m = cleanModel_(p.Model); if (m) set[m] = true; });
  (kitRows || readTable_('Kits')).forEach(k => { const m = cleanModel_(k.Model); if (m) set[m] = true; });
  return Object.keys(set).sort();
}

/** { MODEL: { family: qty } } from the Kits tab (pass its rows if already read). */
function kitsByModel_(kitRows) {
  const out = {};
  (kitRows || readTable_('Kits')).forEach(k => {
    const m = cleanModel_(k.Model), f = normaliseCode(k.Family).family;
    if (m && f) (out[m] = out[m] || {})[f] = Number(k.Qty) || 0;
  });
  return out;
}

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try { return fn(); } finally { lock.releaseLock(); }
}

function siteById_(id, mustBeOpen) {
  const site = readTable_('Sites').find(s => String(s.SiteID) === String(id || ''));
  if (!site) throw err_('bad_request', 'That site was not found.');
  if (mustBeOpen && !isTrue_(site.Active)) throw err_('bad_request', site.Name + ' is closed. Reopen it first.');
  return site;
}

/**
 * Add a site (no id) or edit one (id). req: { session, id?, name, town, postcode, active? }
 * A new site gets the next SiteID and a QR token. Closing a site (active: false) keeps its history.
 * Returns the refreshed admin data and the site's id.
 */
function actionSiteSave(req) {
  requireAdmin_(req);
  const name = cleanText_(req.name, 120), town = cleanText_(req.town, 80), postcode = cleanText_(req.postcode, 10).toUpperCase();
  if (!name) throw err_('bad_request', 'Type the site name.');
  const id = withLock_(() => {
    const sites = readTable_('Sites');
    const same = s => String(s.Name).trim().toLowerCase() === name.toLowerCase() && String(s.Postcode).replace(/\s/g, '').toUpperCase() === postcode.replace(/\s/g, '');
    if (req.id) {
      const site = siteById_(req.id, false);
      if (sites.some(s => s !== site && String(s.SiteID) !== String(site.SiteID) && isTrue_(s.Active) && same(s))) throw err_('bad_request', 'Another site already has that name and postcode.');
      setSiteField_(site, 'Name', name);
      setSiteField_(site, 'Address', town);
      setSiteField_(site, 'Postcode', postcode);
      if (req.active !== undefined) setSiteField_(site, 'Active', !!req.active);
      return site.SiteID;
    }
    if (sites.some(s => isTrue_(s.Active) && same(s))) throw err_('bad_request', 'That site is already on the list.');
    const next = sites.reduce((n, s) => { const m = String(s.SiteID).match(/^S(\d+)$/); return m ? Math.max(n, Number(m[1])) : n; }, 1000) + 1;
    const newId = 'S' + String(next).padStart(4, '0');
    appendObjects_('Sites', [{ SiteID: newId, Name: name, Address: town, Postcode: postcode, Token: newToken_(), Active: true }]);
    return newId;
  });
  return { id: id, admin: actionAdmin(req) };
}

/** Finds a Printers row and checks it is still the machine the admin was looking at. */
function machineAt_(req) {
  const m = readTable_('Printers').find(p => p._row === Number(req.row));
  if (!m || cleanModel_(m.Model) !== cleanModel_(req.model) || String(m.Serial || '') !== String(req.serial || '')) {
    throw err_('bad_request', 'That machine has changed in the Sheet. Refresh and try again.');
  }
  return m;
}

/** Add a machine to a site. req: { session, siteId, model, serial } */
function actionMachineAdd(req) {
  requireAdmin_(req);
  const model = cleanModel_(req.model), serial = cleanText_(req.serial, 40);
  if (!model) throw err_('bad_request', 'Choose the model.');
  withLock_(() => {
    const site = siteById_(req.siteId, true);
    if (serial) {
      const dup = readTable_('Printers').find(p => String(p.Serial || '').trim().toLowerCase() === serial.toLowerCase());
      if (dup) {
        const at = readTable_('Sites').find(s => String(s.SiteID) === String(dup.SiteID));
        throw err_('bad_request', 'Serial ' + serial + ' is already listed at ' + (at ? at.Name : dup.SiteID) + '. Use Move instead.');
      }
    }
    appendObjects_('Printers', [{ SiteID: site.SiteID, Model: model, Serial: serial }]);
  });
  return { admin: actionAdmin(req) };
}

/**
 * Move a machine to another site. With moveKit, one kit's worth of the model's kit parts held at the old site
 * (up to each part's kit quantity) moves with it, recorded as MOVED_OUT / MOVED_IN.
 * req: { session, row, model, serial, toSiteId, moveKit }
 */
function actionMachineMove(req) {
  const user = requireAdmin_(req);
  let moved = [];
  withLock_(() => {
    const m = machineAt_(req);
    const from = siteById_(m.SiteID, false), to = siteById_(req.toSiteId, true);
    if (String(from.SiteID) === String(to.SiteID)) throw err_('bad_request', 'The machine is already at ' + to.Name + '.');
    sheet_('Printers').getRange(m._row, col_('Printers', 'SiteID')).setValue(to.SiteID);
    if (req.moveKit) moved = moveKitStock_(user, m, from, to);
  });
  return { moved: moved, admin: actionAdmin(req) };
}

function moveKitStock_(user, machine, from, to) {
  const model = cleanModel_(machine.Model);
  const kit = noKit_(machine) ? {} : kitsByModel_()[model] || {};
  const held = stockBySite_(from.SiteID);
  const names = partNames_(readTable_('Parts'));
  const lines = Object.keys(kit).map(f => ({ family: f, qty: Math.min(held[f] || 0, kit[f] || held[f] || 0) })).filter(l => l.qty > 0);
  if (!lines.length) return [];
  const now = new Date(), batch = Utilities.getUuid();
  const what = model + (machine.Serial ? ' ' + machine.Serial : '');
  const row = (site, qty, type, note, l) => ({
    MovementID: Utilities.getUuid(), Timestamp: now, SiteID: site, Family: l.family, ExactCode: l.family, Qty: qty, Type: type,
    JobNo: '', By: user.Name, Role: 'admin', Device: 'Admin panel', Note: note, BatchID: batch
  });
  appendObjects_('Movements', lines.map(l => row(from.SiteID, -l.qty, 'MOVED_OUT', 'Kit moved with ' + what + ' to ' + to.Name, l))
    .concat(lines.map(l => row(to.SiteID, l.qty, 'MOVED_IN', 'Kit moved with ' + what + ' from ' + from.Name, l))));
  return lines.map(l => ({ family: l.family, name: names[l.family] || '', qty: l.qty }));
}

/** Take a machine off the list (out of service). req: { session, row, model, serial } */
function actionMachineRemove(req) {
  requireAdmin_(req);
  withLock_(() => { const m = machineAt_(req); sheet_('Printers').deleteRow(m._row); });
  return { admin: actionAdmin(req) };
}

/** Admin approves a part added from a scan, optionally correcting its name. req: { session, family, name? } */
function actionReviewPart(req) {
  const user = sessionUser_(req.session, false);
  if (String(user.Role).toLowerCase() !== 'admin') throw err_('forbidden', 'Admins only.');
  const part = readTable_('Parts').find(p => p.Family === String(req.family || ''));
  if (!part) throw err_('bad_request', 'That part is not in the parts list.');
  const sh = sheet_('Parts');
  const name = String(req.name || '').trim().slice(0, 120);
  if (name) sh.getRange(part._row, col_('Parts', 'Name')).setValue(name);
  sh.getRange(part._row, col_('Parts', 'Reviewed')).setValue(true);
  return { family: part.Family, name: name || part.Name };
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
  // Columns found by heading, so they can be moved; row holds the whole line keyed by heading
  const head = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(h => key_(String(h)));
  return sh.getRange(2, 1, last - 1, head.length).getValues().map(r => {
    const row = {};
    head.forEach((h, j) => { if (h) row[h] = r[j]; });
    return { site: String(row.SiteID), family: String(row.Family), qty: Number(row.Qty) || 0, row: row };
  });
}

// Stock is never stored: it is the sum of a site's (or van's) Movements rows. Each request reads the
// Movements tab once and works everything out from that.

/** One site's or van's movements, oldest first. */
function movementsAt_(siteId) {
  return movementColumns_().filter(m => m.site === String(siteId));
}

/** { family: qty } from a list of movements. */
function sumStock_(moves) {
  const out = {};
  moves.forEach(m => { out[m.family] = (out[m.family] || 0) + m.qty; });
  return out;
}

/** Stock at every site and van: { siteId: { family: qty } }. */
function stockAll_(moves) {
  const out = {};
  (moves || movementColumns_()).forEach(m => {
    const s = out[m.site] = out[m.site] || {};
    s[m.family] = (s[m.family] || 0) + m.qty;
  });
  return out;
}

function stockBySite_(siteId) {
  return sumStock_(movementsAt_(siteId));
}

/** The non-zero lines of a { family: qty } stock, with part names, for the app. */
function stockLines_(stock, names) {
  return Object.keys(stock).filter(f => stock[f] !== 0)
    .map(f => ({ family: f, name: names[f] || '', qty: stock[f] }))
    .sort((a, b) => (a.name || a.family).localeCompare(b.name || b.family));
}

/** The latest of a site's movements, newest first. */
function recentMovements_(moves, names, limit) {
  return moves.slice(-limit).reverse().map(m => ({
    at: iso_(m.row.Timestamp), family: m.family, name: names[m.family] || '', qty: m.qty,
    type: m.row.Type, by: m.row.By, jobNo: m.row.JobNo
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
  sheet_('Parts').getRange(part._row, col_('Parts', 'ExactCodes')).setValue(part.ExactCodes);
}

// ---------------------------------------------------------------- batches (offline retries)

function batchSeen_(batchId) {
  if (CacheService.getScriptCache().get('batch:' + batchId)) return true;
  const sh = sheet_('Movements');
  const last = sh.getLastRow();
  if (last < 2) return false;
  const col = col_('Movements', 'BatchID');
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
  sheet_('Sites').getRange(site._row, col_('Sites', field)).setValue(value);
}

/** 1-based column of a heading in a tab. Found by name, so columns can be moved or unused ones deleted. */
function col_(tab, heading) {
  const sh = sheet_(tab);
  const head = sh.getRange(1, 1, 1, Math.max(1, sh.getLastColumn())).getValues()[0].map(h => key_(String(h).trim()));
  const i = head.indexOf(key_(heading));
  if (i < 0) throw err_('setup', 'The "' + tab + '" tab has no "' + heading + '" column. Run setup to add it back.');
  return i + 1;
}

/** Gives every named site an ID, a QR token and Active=true where missing. Returns the Sites rows, filled in. */
function ensureSiteTokens_() {
  const sh = sheet_('Sites');
  const sites = readTable_('Sites');
  const fill = (s, field, value) => { s[field] = value; sh.getRange(s._row, col_('Sites', field)).setValue(value); };
  sites.forEach(s => {
    if (!s.Name) return;
    if (!s.SiteID) fill(s, 'SiteID', 'S' + String(s._row - 1).padStart(4, '0'));
    if (!s.Token) fill(s, 'Token', newToken_());
    if (s.Active === '' || s.Active === null) fill(s, 'Active', true);
  });
  return sites;
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
    UserID: String(u.UserID), Name: String(u.Name), Role: String(u.Role).toLowerCase(), PinHash: String(u.PinHash || ''), Active: isTrue_(u.Active),
    Email: String(u.Email || ''), Postcode: String(u.Postcode || ''), ByBox: String(u.ByBox || '')
  }));
  cache.put('users:v1', JSON.stringify(users), USERS_CACHE_SECONDS);
  return users;
}

/** Any PIN typed into the PIN column is hashed into PinHash and the plain PIN cleared. */
function hashPendingPins_() {
  const sh = sheet_('Users');
  const pinCol = col_('Users', 'PIN'), hashCol = col_('Users', 'PinHash');
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
  if (!sh && name === 'Movements') throw err_('setup', 'The Movements tab is missing, so stock cannot be worked out. Restore it: Undo, or File > Version history in the Sheet.');
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
    head.forEach((h, j) => { o[key_(h)] = values[i][j]; });
    out.push(o);
  }
  return out;
}

function appendObjects_(name, objects) {
  if (!objects.length) return;
  const sh = sheet_(name);
  const head = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(String);
  const start = sh.getLastRow() + 1;
  // Write only the columns given a value, in runs of neighbouring columns, so a lookup column
  // (Kits/VanKit Name, wherever it has been moved to) is left to its formula
  const used = head.map(h => objects.some(o => o[key_(h)] !== undefined));
  for (let c = 0; c < head.length; c++) {
    if (!used[c]) continue;
    let end = c;
    while (end + 1 < head.length && used[end + 1]) end++;
    const cols = head.slice(c, end + 1);
    sh.getRange(start, c + 1, objects.length, cols.length).setValues(objects.map(o => cols.map(h => (o[key_(h)] === undefined ? '' : o[key_(h)]))));
    c = end;
  }
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

// ---------------------------------------------------------------- daily Up Time Kit report

/** Settings tab rows: [Setting, default Value, Notes]. Setup adds any that are missing. */
const SETTINGS_DEFAULTS = [
  ['ReportEmail', '', 'Where the daily Up Time Kit email goes. Blank: the Email of the first active admin on the Users tab.'],
  ['ReportHour', 18, 'Hour (0-23, UK time) the daily email is sent. After changing it, run installDailyReport again.'],
  ['OrderFormUrl', 'https://app.smartsheet.com/b/form/397ec25e0b1c44e3a4b4dcc952edba69', 'Smartsheet parts order form opened by the email buttons.'],
  ['PartsReason', 'UPTIME KIT', 'Parts Reason on the order form. Must match one of the form\'s choices exactly.'],
  ['Urgency', 'Low - Will Wait - But Not Long', 'Urgency on the order form. Must match one of the form\'s choices exactly.'],
  ['SDCallNo', 'Uptime Kit', 'SD CALL No. on the order form.'],
  ['DaysNeeded', 7, 'Date Required Onsite = the day the order button is pressed + this many days.'],
  ['AppUrl', 'https://parts-tracker.github.io/', 'Parts Tracker web address. The order buttons go through its order.html page, which fills in the date.'],
  ['ArchiveKeepDays', 365, 'archiveMovements keeps this many days of movements in full (at least 1). Older ones go to the archive spreadsheet, replaced by one carried-forward line per part.'],
  ['ArchiveSheet', '', 'The archive spreadsheet. Filled in by archiveMovements the first time it runs.']
];

// Kit parts taken out of a customer's Up Time Kit: fitted by the customer or used by an engineer at the site
const KIT_USE_TYPES = ['CUSTOMER_FITTED', 'USED'];

// The order form's part fields are not named consistently (keep in step with web/app.js)
const FORM_PART_FIELDS = [
  ['1 Part No.', '1 Qty', '1 Description'], ['2 Part No.', '2 Qty', '2 Description'], ['3 Part No.', '3 Qty', '3 Description'],
  ['4 Part No.', '4 Qty', '4 Description'], ['5 Part code', '5 qty', '5 Part Description '], ['6 part number', '6 Qty', '6 part description'],
  ['7 part code', '7 qty', '7 part description'], ['8 part code', '8 qty', '8 part description'], ['9 part code', '9 qty', '9 description']
];

function settings_() {
  const out = {};
  SETTINGS_DEFAULTS.forEach(d => { out[d[0]] = d[1]; });
  let rows = [];
  try { rows = readTable_('Settings'); } catch (e) { /* tab not set up yet: defaults */ }
  rows.forEach(r => { const k = String(r.Setting || '').trim(); if (k && r.Value !== '' && r.Value !== null) out[k] = r.Value; });
  return out;
}

/**
 * The ReportHour setting as a whole hour 0-23. Accepts 20, "20", "20:00", or a Sheets time cell: Sheets turns "20:00"
 * into a time-of-day date in 1899, whose old London offset can make it read 19:58:45, so round to the nearest hour.
 */
function reportHour_(v) {
  let h;
  if (v instanceof Date) h = Math.round(v.getHours() + v.getMinutes() / 60 + v.getSeconds() / 3600) % 24;
  else h = parseInt(String(v).trim(), 10);
  return isNaN(h) ? 18 : Math.min(23, Math.max(0, h));
}

/** Where the daily email goes. */
function reportEmail_(cfg) {
  const admin = readTable_('Users').find(u => isTrue_(u.Active) && String(u.Role).toLowerCase() === 'admin' && u.Email) || {};
  return String(cfg.ReportEmail || admin.Email || '').trim();
}

/**
 * Kit parts used at customer sites between two times, grouped by site. A site's kit is every Kits row
 * whose Model matches one of its printers. Van stock and parts outside the site's kit are left out.
 */
function kitUsage_(from, to) {
  const sites = {};
  readTable_('Sites').forEach(s => { sites[String(s.SiteID)] = s; });
  const models = {};
  readTable_('Printers').forEach(p => {
    if (noKit_(p)) return;   // e.g. a training machine
    const list = models[String(p.SiteID)] = models[String(p.SiteID)] || [];
    const m = cleanModel_(p.Model);
    if (m && list.indexOf(m) < 0) list.push(m);   // a site with two SC180s lists SC180 once
  });
  const kits = kitsByModel_();
  const names = partNames_(readTable_('Parts'));
  const bySite = {};
  movementColumns_().forEach(m => {
    if (KIT_USE_TYPES.indexOf(String(m.row.Type)) < 0 || !sites[m.site] || m.qty >= 0) return;
    const t = m.row.Timestamp;
    if (!(t instanceof Date) || t <= from || t > to) return;   // after the last report, up to now
    const siteModels = models[m.site] || [];
    if (!siteModels.some(mod => kits[mod] && m.family in kits[mod])) return;
    const s = bySite[m.site] = bySite[m.site] || { site: sites[m.site], models: siteModels, parts: {} };
    s.parts[m.family] = s.parts[m.family] || { family: m.family, name: names[m.family] || '', qty: 0 };
    s.parts[m.family].qty += -m.qty;
  });
  return Object.keys(bySite).map(k => {
    const s = bySite[k];
    return { site: s.site, models: s.models, parts: Object.keys(s.parts).map(f => s.parts[f]).sort((a, b) => a.family.localeCompare(b.family)) };
  }).sort((a, b) => String(a.site.Name).localeCompare(String(b.site.Name)));
}

/**
 * Order button link for one site's used kit parts (at most 9 lines, the form's limit). Parts go straight to
 * the customer. The link opens the app's order.html, which adds Date Required Onsite (the day the button is
 * pressed + DaysNeeded) and then opens the Smartsheet form with everything else filled in.
 */
function kitOrderUrl_(cfg, site, models, parts) {
  const p = [];
  const add = (k, v) => { if (v !== '' && v != null) p.push(encodeURIComponent(k) + '=' + encodeURIComponent(String(v))); };
  add('f', (String(cfg.OrderFormUrl).match(/[0-9a-f]{32}/) || [''])[0]);
  add('days', cfg.DaysNeeded);
  add('Parts Reason', cfg.PartsReason);
  add('Urgency', cfg.Urgency);
  add('Pre 10:30', 'No');
  add('ByBox/Collection', 'No');
  add('SD CALL No.', cfg.SDCallNo);
  add('Notes', 'Uptime Kit Replenishment - ' + site.Name);
  add('Customer Name', site.Name);
  // The form labels this field "Equipment:"; its column name may differ by the colon or a hidden space
  // ("5 Part Description " has one), so send each spelling: names that match no field are ignored
  ['Equipment:', 'Equipment: ', 'Equipment', 'Equipment '].forEach(k => add(k, models.join(', ')));
  add('Post Code', site.Postcode);
  add('Engineer Name Attending', site.Name);
  add('Part Requested By', site.Name);
  parts.slice(0, FORM_PART_FIELDS.length).forEach((l, i) => {
    add(FORM_PART_FIELDS[i][0], l.family);
    add(FORM_PART_FIELDS[i][1], l.qty);
    add(FORM_PART_FIELDS[i][2], l.name);
  });
  if (parts.length > 4) add('Order Additional Parts', 'true');
  const app = String(cfg.AppUrl || 'https://parts-tracker.github.io/');
  return app.replace(/\/?$/, '/') + 'order.html?' + p.join('&');
}

function esc_(v) {
  return String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** The email: one block per site with its used kit parts and an order button (more than 9 parts: one button per 9). */
function kitReportHtml_(usage, cfg, title) {
  let html = '<div style="font-family:Arial,sans-serif;color:#333;max-width:680px">' +
    '<h2 style="color:#01916D;margin:0 0 4px">Up Time Kit replenishment</h2>' +
    '<p style="margin:0 0 16px;color:#666">' + esc_(title) + '</p>';
  usage.forEach(u => {
    const s = u.site;
    html += '<div style="border:2px solid #01916D;border-radius:10px;margin:0 0 16px;overflow:hidden">' +
      '<div style="background:#E6F4F0;padding:10px 14px">' +
      '<div style="font-weight:bold;font-size:16px">' + esc_(s.Name) + '</div>' +
      '<div style="font-size:13px;color:#555">' + esc_([s.Address, s.Postcode].filter(Boolean).join(', ')) +
      (u.models.length ? ' &middot; ' + esc_(u.models.join(', ')) : '') + '</div></div>' +
      '<table style="width:100%;border-collapse:collapse;font-size:14px">' +
      '<tr style="text-align:left;color:#666"><th style="padding:6px 14px">Part</th><th style="padding:6px 14px">Part number</th><th style="padding:6px 14px">Used</th></tr>';
    u.parts.forEach(l => {
      html += '<tr style="border-top:1px solid #eee"><td style="padding:6px 14px">' + esc_(l.name || 'Unknown part') + '</td>' +
        '<td style="padding:6px 14px;font-family:monospace">' + esc_(l.family) + '</td>' +
        '<td style="padding:6px 14px;font-weight:bold;color:#E0356C">' + l.qty + '</td></tr>';
    });
    html += '</table><div style="padding:10px 14px">';
    for (let i = 0; i < u.parts.length; i += FORM_PART_FIELDS.length) {
      const chunk = u.parts.slice(i, i + FORM_PART_FIELDS.length);
      const label = u.parts.length > FORM_PART_FIELDS.length ? 'Order parts ' + (i + 1) + '-' + (i + chunk.length) + ' &rarr;' : 'Order replacements &rarr;';
      html += '<a href="' + esc_(kitOrderUrl_(cfg, s, u.models, chunk)) + '" style="display:inline-block;margin:0 8px 6px 0;background:#01916D;color:#fff;text-decoration:none;padding:9px 14px;border-radius:8px;font-weight:bold">' + label + '</a>';
    }
    html += '</div></div>';
  });
  return html + '<p style="font-size:12px;color:#888">Sent by Parts Tracker. Check the form before pressing Submit in Smartsheet.</p></div>';
}

/**
 * Sends the kit report for everything used since the last report (first run: the last 24 hours).
 * Run daily by the trigger that installDailyReport sets up. Sends nothing on a day with no kit use.
 */
function sendDailyKitReport() {
  const props = PropertiesService.getScriptProperties();
  const now = new Date();
  const tz = Session.getScriptTimeZone();
  const last = Number(props.getProperty('kitReportUpTo')) || 0;
  const from = new Date(last || now.getTime() - 86400000);
  const sent = sendKitReport_(from, now, 'Kit parts used ' + Utilities.formatDate(from, tz, 'EEE d MMM HH:mm') + ' to ' + Utilities.formatDate(now, tz, 'EEE d MMM HH:mm'), false);
  props.setProperty('kitReportUpTo', String(now.getTime()));
  return sent;
}

/** Builds and sends one report. Returns how many sites were in it (0: nothing sent unless always is true). */
function sendKitReport_(from, to, title, always, subjectPrefix) {
  const cfg = settings_();
  const email = reportEmail_(cfg);
  if (!email) throw new Error('No email address for the kit report. Fill in ReportEmail on the Settings tab.');
  const usage = kitUsage_(from, to);
  if (!usage.length && !always) return 0;
  const tz = Session.getScriptTimeZone();
  const subject = (subjectPrefix || '') + 'Up Time Kit replenishment - ' + Utilities.formatDate(to, tz, 'EEE d MMM yyyy') +
    (usage.length ? ' (' + usage.length + (usage.length === 1 ? ' site)' : ' sites)') : '');
  const html = usage.length ? kitReportHtml_(usage, cfg, title)
    : '<p style="font-family:Arial,sans-serif">No Up Time Kit parts were used. (' + esc_(title) + ')</p>';
  MailApp.sendEmail({ to: email, subject: subject, htmlBody: html, name: 'Parts Tracker' });
  return usage.length;
}
