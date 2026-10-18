/**
 * Parts Tracker - sheet menu and one-off setup tasks.
 */

/** Runs by itself when the Sheet opens. Running it from the editor does nothing: use runSetup there. */
function onOpen() {
  let ui;
  try { ui = SpreadsheetApp.getUi(); } catch (e) {
    console.log('onOpen only works when the Sheet opens. In the editor, choose runSetup and click Run.');
    return;
  }
  ui.createMenu('Parts Tracker')
    .addItem('Set up sheets', 'menuSetup')
    .addItem('Give sites IDs and QR tokens', 'menuSiteTokens')
    .addItem('Secure new PINs', 'menuHashPins')
    .addToUi();
}

/** Creates any missing tabs with their headers. Safe to run again. */
function menuSetup() {
  setupSheets_();
  secret_();
  SpreadsheetApp.getUi().alert('Sheets are ready.\n\nNext: add sites, printers and users (type a PIN in the Users PIN column), then deploy the web app.');
}

function menuSiteTokens() {
  ensureSiteTokens_();
  SpreadsheetApp.getUi().alert('Every site now has an ID and a QR token.\nPrint the QR codes from the admin page of the app.');
}

function menuHashPins() {
  const n = hashPendingPins_();
  const dupes = duplicatePins_();
  SpreadsheetApp.getUi().alert(n + ' PIN(s) secured.' + (dupes.length ? '\n\nWarning: these people share a PIN and cannot sign in until one is changed: ' + dupes.join(', ') : ''));
}

// ---- The same tasks, for a separate Apps Script project (no menu in the Sheet).
// Pick one in the editor's function list next to Run, click Run, and read the result in the Execution log.

function runSetup() {
  setupSheets_();
  secret_();
  console.log('Sheets are ready in "' + spreadsheet_().getName() + '". Next: add sites, printers and users, then deploy the web app.');
}

/** Turns on the daily Up Time Kit email at the ReportHour on the Settings tab. Run again after changing the hour. */
function installDailyReport() {
  ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'sendDailyKitReport').forEach(t => ScriptApp.deleteTrigger(t));
  const cfg = settings_();
  const hour = reportHour_(cfg.ReportHour);
  ScriptApp.newTrigger('sendDailyKitReport').timeBased().everyDays(1).atHour(hour).create();
  const to = reportEmail_(cfg);
  console.log('Daily Up Time Kit email is on: sent between ' + hour + ':00 and ' + hour + ':59 each day to ' + (to || '(no address: fill in ReportEmail on the Settings tab)') + ', only on days a kit part is used.');
}

/** Sends a test email now with the kit parts used in the last 7 days (marked TEST). Does not affect the daily email. */
function testDailyKitReport() {
  const to = new Date();
  const from = new Date(to.getTime() - 7 * 86400000);
  const n = sendKitReport_(from, to, 'TEST: kit parts used in the last 7 days', true, '[TEST] ');
  console.log('Test email sent to ' + reportEmail_(settings_()) + ' with ' + n + ' site(s).');
}

/** Turns the daily Up Time Kit email off. */
function removeDailyReport() {
  const t = ScriptApp.getProjectTriggers().filter(x => x.getHandlerFunction() === 'sendDailyKitReport');
  t.forEach(x => ScriptApp.deleteTrigger(x));
  console.log(t.length ? 'Daily Up Time Kit email turned off.' : 'The daily email was not on.');
}

/**
 * Lists what fillKitStock would add, without changing anything. Check the Execution log, then run fillKitStock.
 */
function previewKitStock() {
  const plan = kitTopUp_();
  const printers = readTable_('Printers');
  const ticked = printers.filter(noKit_);
  if (!printers.length || !('NoKit' in printers[0])) console.log('No "No kit" column found on the Printers tab. Run runSetup, or add a heading called No kit.');
  else console.log(ticked.length ? 'Ticked No kit (left out): ' + ticked.map(p => p.Model + (p.Serial ? ' ' + p.Serial : '') + ' at ' + p.SiteID).join(', ') : 'No machines are ticked No kit.');
  logKitPlan_(plan, true);
  console.log('Nothing has been changed. Run fillKitStock to do this.');
}

// Rows written by fillKitStock carry this in By, so it can tell its own assumed stock from real deliveries
const KIT_SETUP_BY = 'Kit setup';

/**
 * Brings the ASSUMED stock at every open site that has never been counted to exactly a full Up Time Kit for each
 * kit machine there (two SC180s = two kits; machines ticked No kit on the Printers tab are left out):
 * - parts below the kit are topped up (recorded as BOOK_IN, "not yet checked on site");
 * - parts above the kit (e.g. after a kit quantity on the Kits tab is lowered) are taken back, but only as far as
 *   this function added them itself (KIT_ADJUST), so real deliveries are never removed.
 * Sites that have been counted are never touched: their stock is real. Running it again changes nothing.
 * The daily kit email ignores both kinds of row.
 */
function fillKitStock() {
  withLock_(() => {
    const plan = kitTopUp_();
    const now = new Date(), batch = Utilities.getUuid();
    const rows = [];
    plan.forEach(p => p.lines.forEach(l => rows.push({
      MovementID: Utilities.getUuid(), Timestamp: now, SiteID: p.site.SiteID, Family: l.family, ExactCode: l.family, Qty: l.qty,
      Type: l.qty > 0 ? 'BOOK_IN' : 'KIT_ADJUST', JobNo: '', By: KIT_SETUP_BY, Role: 'admin', Device: 'Setup',
      Note: l.qty > 0 ? 'Assumed full kit, not yet checked on site' : 'Kit list corrected: assumed stock above the kit taken back', BatchID: batch
    })));
    if (rows.length) appendObjects_('Movements', rows);
    logKitPlan_(plan, false);
  });
}

/**
 * For each open site never counted that has kit machines (or assumed kit stock): what to add or take back so its
 * assumed stock matches the kit. lines: [{ family, qty }], qty > 0 adds, qty < 0 takes back.
 */
function kitTopUp_() {
  const kits = kitsByModel_();
  const machines = {};   // site -> { MODEL: how many kit machines }
  readTable_('Printers').forEach(p => {
    if (noKit_(p)) return;   // marked No kit on the Printers tab, e.g. a training machine
    const m = cleanModel_(p.Model), id = String(p.SiteID);
    if (!m || !kits[m]) return;
    const at = machines[id] = machines[id] || {};
    at[m] = (at[m] || 0) + 1;   // each machine has its own kit
  });
  const moves = movementColumns_();
  const held = stockAll_(moves);
  const assumed = {};   // site -> { family: net qty this function has added there }
  moves.forEach(m => {
    if (String(m.row.By) !== KIT_SETUP_BY) return;
    const a = assumed[m.site] = assumed[m.site] || {};
    a[m.family] = (a[m.family] || 0) + m.qty;
  });
  return readTable_('Sites').filter(s => s.SiteID && isTrue_(s.Active) && !s.LastCount && (machines[String(s.SiteID)] || assumed[String(s.SiteID)])).map(s => {
    const id = String(s.SiteID), want = {}, at = machines[id] || {};
    Object.keys(at).forEach(m => Object.keys(kits[m]).forEach(f => { want[f] = (want[f] || 0) + kits[m][f] * at[m]; }));
    const have = held[id] || {}, mine = assumed[id] || {};
    const lines = [];
    Object.keys(Object.assign({}, want, mine)).forEach(f => {
      const diff = (want[f] || 0) - (have[f] || 0);
      if (diff > 0) lines.push({ family: f, qty: diff });
      else if (diff < 0 && (mine[f] || 0) > 0) lines.push({ family: f, qty: -Math.min(-diff, mine[f]) });
    });
    return { site: s, models: Object.keys(at).map(m => at[m] > 1 ? at[m] + ' x ' + m : m), lines: lines };
  });
}

function logKitPlan_(plan, preview) {
  const busy = plan.filter(p => p.lines.length);
  const sum = (lines, sign) => lines.filter(l => Math.sign(l.qty) === sign).reduce((n, l) => n + Math.abs(l.qty), 0);
  const words = (add, take) => [add ? (preview ? 'add ' : 'added ') + add : '', take ? (preview ? 'take back ' : 'took back ') + take : ''].filter(Boolean).join(', ') + ' item(s)';
  busy.forEach(p => {
    const text = words(sum(p.lines, 1), sum(p.lines, -1));
    console.log((preview ? 'Would ' + text : text.charAt(0).toUpperCase() + text.slice(1)) + ': ' +
      p.site.Name + ' (' + p.site.SiteID + (p.models.length ? ', ' + p.models.join(', ') : '') + ')');
  });
  const all = [].concat.apply([], busy.map(p => p.lines));
  const total = words(sum(all, 1), sum(all, -1));
  console.log((!busy.length ? 'Nothing to change. ' : (preview ? 'Would ' + total : total.charAt(0).toUpperCase() + total.slice(1)) + ' at ' + busy.length + ' site(s). ') +
    (plan.length - busy.length) + ' site(s) not yet counted already match the kit. Sites that have been counted are left as counted.');
}

// ---- Archive old movements: keeps the Movements tab small without changing any stock

/** Shows what archiveMovements would do, without changing anything. */
function previewArchive() {
  const plan = archivePlan_();
  logArchivePlan_(plan);
  console.log('Nothing has been changed. Run archiveMovements to do this.');
}

/**
 * Copies movements older than ArchiveKeepDays (Settings tab) to the archive spreadsheet, then replaces them on the
 * Movements tab with one CARRIED_FORWARD line per site/van and part holding their total, so every stock level stays
 * the same. Movements the daily kit email has not reported yet are never archived.
 */
function archiveMovements() {
  withLock_(() => {
    const plan = archivePlan_();
    logArchivePlan_(plan);
    if (!plan.old.length) return;
    const main = sheet_('Movements');
    const stockBefore = stockTotals_();

    // 1. Copy to the archive, and check it all arrived before touching the Movements tab
    const book = archiveBook_();
    const arch = book.getSheetByName('Movements') || book.getSheets()[0].setName('Movements');
    let aHead = arch.getLastRow() ? arch.getRange(1, 1, 1, arch.getLastColumn()).getValues()[0].map(String) : [];
    plan.head.forEach(h => { if (aHead.map(key_).indexOf(key_(h)) < 0) aHead.push(h); });
    arch.getRange(1, 1, 1, aHead.length).setValues([aHead]).setFontWeight('bold');
    const from = plan.head.map(key_);
    const aRows = plan.originals.map(r => aHead.map(h => { const j = from.indexOf(key_(h)); return j < 0 ? '' : r[j]; }));
    const start = arch.getLastRow() + 1;
    arch.getRange(start, 1, aRows.length, aHead.length).setValues(aRows);
    if (arch.getLastRow() !== start + aRows.length - 1) throw new Error('The archive copy did not complete, so nothing was removed from Movements. Try again.');

    // 2. Rewrite the Movements tab: carried-forward lines first, then the recent movements unchanged
    const body = plan.carried.concat(plan.keep);
    if (body.length) main.getRange(2, 1, body.length, plan.head.length).setValues(body);
    const spare = plan.total - body.length;
    if (spare > 0) main.deleteRows(body.length + 2, spare);

    // 3. Check every stock level is unchanged
    const stockAfter = stockTotals_();
    const keys = Object.keys(Object.assign({}, stockBefore, stockAfter)).filter(k => (stockBefore[k] || 0) !== (stockAfter[k] || 0));
    if (keys.length) throw new Error('Stock changed for ' + keys.slice(0, 5).join(', ') + '. Restore the Sheet from File > Version history and tell Claude.');
    console.log('Done. ' + plan.originals.length + ' movement(s) are in the archive: ' + book.getUrl() + '. Every stock level is unchanged.');
  });
}

function archivePlan_() {
  const cfg = settings_();
  const n = Number(cfg.ArchiveKeepDays);
  const keepDays = isNaN(n) ? 365 : Math.max(1, n);
  let cutoff = new Date(Date.now() - keepDays * 86400000);
  // Keep anything the daily kit email has not reported yet
  const reportOn = ScriptApp.getProjectTriggers().some(t => t.getHandlerFunction() === 'sendDailyKitReport');
  const reported = Number(PropertiesService.getScriptProperties().getProperty('kitReportUpTo')) || 0;
  if (reportOn && reported && reported < cutoff.getTime()) cutoff = new Date(reported);

  const main = sheet_('Movements');
  const head = main.getRange(1, 1, 1, main.getLastColumn()).getValues()[0].map(String);
  const total = Math.max(0, main.getLastRow() - 1);
  const raw = total ? main.getRange(2, 1, total, head.length).getValues() : [];
  const k = head.map(key_);
  const at = name => k.indexOf(name);
  const iT = at('Timestamp'), iS = at('SiteID'), iF = at('Family'), iQ = at('Qty');
  const iY = at('Type');
  const old = [], keep = [];
  raw.forEach(r => ((r[iT] instanceof Date && r[iT] < cutoff) ? old : keep).push(r));
  // Earlier carried-forward lines are folded into the new totals but not archived (the archive holds only real movements)
  const originals = old.filter(r => String(r[iY]) !== 'CARRIED_FORWARD');

  const sums = {};
  old.forEach(r => {
    const key = String(r[iS]) + '|' + String(r[iF]);
    const s = sums[key] = sums[key] || { site: String(r[iS]), family: String(r[iF]), qty: 0, n: 0, last: r[iT] };
    s.qty += Number(r[iQ]) || 0;
    if (String(r[iY]) !== 'CARRIED_FORWARD') s.n++;
    if (r[iT] > s.last) s.last = r[iT];
  });
  const batch = Utilities.getUuid();
  const carried = Object.keys(sums).map(key => sums[key]).filter(s => s.qty !== 0).map(s => {
    const o = {
      MovementID: Utilities.getUuid(), Timestamp: s.last, SiteID: s.site, Family: s.family, ExactCode: s.family, Qty: s.qty,
      Type: 'CARRIED_FORWARD', JobNo: '', By: 'Archive', Role: 'admin', Device: 'Archive',
      Note: 'Carried forward: older movements are in the archive spreadsheet (' + s.n + ' more this time)', BatchID: batch
    };
    return k.map(h => (o[h] === undefined ? '' : o[h]));
  });
  return { keepDays: keepDays, cutoff: cutoff, head: head, total: total, old: originals.length ? old : [], originals: originals, keep: originals.length ? keep : raw, carried: originals.length ? carried : [] };
}

function logArchivePlan_(p) {
  const tz = Session.getScriptTimeZone();
  console.log('Movements tab: ' + p.total + ' row(s). Keeping everything from ' + Utilities.formatDate(p.cutoff, tz, 'd MMM yyyy HH:mm') +
    ' (' + p.keepDays + ' day(s), ArchiveKeepDays on the Settings tab) in full.');
  if (!p.old.length) { console.log('Nothing older than that to archive.'); return; }
  console.log(p.originals.length + ' older movement(s) go to the archive spreadsheet; with any earlier carried-forward lines they become ' + p.carried.length +
    ' carried-forward line(s). The Movements tab goes from ' + p.total + ' to ' + (p.carried.length + p.keep.length) + ' row(s). Stock stays the same.');
}

/** Every non-zero stock level, keyed "site|part", for checking nothing changed. */
function stockTotals_() {
  const all = stockAll_(), out = {};
  Object.keys(all).forEach(site => Object.keys(all[site]).forEach(f => { if (all[site][f]) out[site + '|' + f] = all[site][f]; }));
  return out;
}

/** The archive spreadsheet named on the Settings tab, or a new one (its link is then saved there). */
function archiveBook_() {
  const row = readTable_('Settings').find(r => String(r.Setting).trim() === 'ArchiveSheet');
  const url = row ? String(row.Value || '').trim() : '';
  if (url) return SpreadsheetApp.openByUrl(url);
  const book = SpreadsheetApp.create(spreadsheet_().getName() + ' - archive');
  if (row) sheet_('Settings').getRange(row._row, col_('Settings', 'Value')).setValue(book.getUrl());
  else appendObjects_('Settings', [{ Setting: 'ArchiveSheet', Value: book.getUrl(), Notes: 'The archive spreadsheet.' }]);
  return book;
}

function runSiteTokens() {
  ensureSiteTokens_();
  console.log('Every site now has an ID and a QR token.');
}

function runHashPins() {
  const n = hashPendingPins_();
  const dupes = duplicatePins_();
  console.log(n + ' PIN(s) secured.' + (dupes.length ? ' Warning: these people share a PIN: ' + dupes.join(', ') : ''));
}

function setupSheets_() {
  const ss = spreadsheet_();
  // A missing Movements tab means all stock history is gone: never quietly replace it with an empty one
  const sites = ss.getSheetByName('Sites');
  if (!ss.getSheetByName('Movements') && sites && sites.getLastRow() > 1) {
    throw new Error('The Movements tab is missing but there are sites. An empty one would set all stock to zero, so setup has stopped. ' +
      'Restore it first: Edit > Undo, or File > Version history > See version history, pick a version from before it went, and Restore.');
  }
  Object.keys(SHEETS).forEach(name => {
    let sh = ss.getSheetByName(name);
    if (!sh) sh = ss.insertSheet(name);
    const head = SHEETS[name];
    if (sh.getLastRow() === 0) {
      sh.getRange(1, 1, 1, head.length).setValues([head]).setFontWeight('bold');
      sh.setFrozenRows(1);
    } else {
      // Add any new columns at the end, leaving existing data alone
      const have = sh.getRange(1, 1, 1, Math.max(1, sh.getLastColumn())).getValues()[0].map(h => key_(String(h)));
      head.filter(h => have.indexOf(key_(h)) < 0).forEach(h => {
        sh.getRange(1, sh.getLastColumn() + 1).setValue(h).setFontWeight('bold');
      });
    }
  });
  // Keep codes and PINs as text so leading zeros survive
  // (columns found by heading, so they can be moved)
  [['Users', 'PIN'], ['Parts', 'Part Number'], ['Parts', 'Name'], ['Parts', 'ExactCodes'], ['Movements', 'Part Number'],
   ['Movements', 'ExactCode'], ['VanKit', 'Part Number'], ['Kits', 'Part Number'], ['OnItsWay', 'Part Number']].forEach(([tab, h]) => {
    const L = colLetter_(col_(tab, h));
    ss.getSheetByName(tab).getRange(L + ':' + L).setNumberFormat('@');
  });
  addMissingSettings_();
  addSmallKits_();
  addNameLookups_();
  protectMovements_();
}

/**
 * The Kits and VanKit tabs show each part's name, looked up from the Parts tab by one formula in the
 * Name heading cell, so names follow any rename and new rows fill in by themselves.
 */
/** Column number to letters: 1 -> A, 27 -> AA. */
function colLetter_(n) {
  let s = '';
  for (; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + (n - 1) % 26) + s;
  return s;
}

function addNameLookups_() {
  const pCode = colLetter_(col_('Parts', 'Part Number')), pName = colLetter_(col_('Parts', 'Name'));
  ['Kits', 'VanKit'].forEach(tab => {
    const sh = sheet_(tab);
    const code = colLetter_(col_(tab, 'Part Number')), name = col_(tab, 'Name');
    // XLOOKUP needs both ranges the same shape, so look up in the Parts code column and return its Name column
    sh.getRange(1, name).setFormula('={"Name";ARRAYFORMULA(IF(' + code + '2:' + code + '="",,IFERROR(XLOOKUP(' + code + '2:' + code +
      ',Parts!' + pCode + '2:' + pCode + ',Parts!' + pName + '2:' + pName + '),"Not in Parts tab")))}');
    sh.getRange(1, name).setFontWeight('bold');
  });
}

/**
 * Puts a warning on the Movements tab: editing or deleting it asks "are you sure?" first. Stock is worked out from
 * these rows, so losing them would reset every site. The app is not affected (it runs as the Sheet's owner).
 */
function protectMovements_() {
  const sh = sheet_('Movements');
  if (sh.getProtections(SpreadsheetApp.ProtectionType.SHEET).length) return;
  sh.protect().setDescription('Stock history: Parts Tracker works out all stock from these rows. Do not edit or delete.').setWarningOnly(true);
}

/** Adds any Settings rows that are missing, with their default value and a note. Existing values are kept. */
function addMissingSettings_() {
  const have = readTable_('Settings').map(r => String(r.Setting).trim());
  const rows = SETTINGS_DEFAULTS.filter(d => have.indexOf(d[0]) < 0).map(d => ({ Setting: d[0], Value: d[1], Notes: d[2] }));
  appendObjects_('Settings', rows);
}

// SC180, SC170 and EC1100 sites keep a small kit: one 2nd BTR Assembly and one Suction Filter
const SMALL_KIT = [['P859K4874X', '2nd BTR Assembly', 1], ['P053K0668X', 'Suction Filter', 1]];
const SMALL_KIT_MODELS = ['SC180', 'SC170', 'EC1100'];

/** Adds the small kit for each of those models that has no Kits rows yet, and its parts to the parts list. */
function addSmallKits_() {
  const kits = readTable_('Kits');
  const rows = [];
  SMALL_KIT_MODELS.forEach(m => {
    if (kits.some(k => String(k.Model).trim().toUpperCase() === m)) return;
    SMALL_KIT.forEach(p => rows.push({ Model: m, Family: p[0], Qty: p[2] }));
  });
  appendObjects_('Kits', rows);
  const parts = readTable_('Parts').map(p => p.Family);
  appendObjects_('Parts', SMALL_KIT.filter(p => parts.indexOf(p[0]) < 0)
    .map(p => ({ Family: p[0], Name: p[1], ExactCodes: '', Reviewed: true, AddedBy: 'Setup', AddedAt: new Date() })));
}

function duplicatePins_() {
  const seen = {};
  const dupes = [];
  readTable_('Users').filter(u => isTrue_(u.Active) && u.PinHash).forEach(u => {
    if (seen[u.PinHash]) dupes.push(seen[u.PinHash] + ' / ' + u.Name);
    else seen[u.PinHash] = u.Name;
  });
  return dupes;
}
