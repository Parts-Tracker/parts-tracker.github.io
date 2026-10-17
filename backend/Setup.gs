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
    .addSeparator()
    .addItem('Load sample data (testing only)', 'menuSampleData')
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

function menuSampleData() {
  const ui = SpreadsheetApp.getUi();
  if (ui.alert('Add sample sites, users and parts for testing?', ui.ButtonSet.YES_NO) !== ui.Button.YES) return;
  loadSampleData_();
  ui.alert('Sample data added. Test PINs: engineer 1111, admin 9999.\nDelete the sample rows before going live.');
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
  logKitPlan_(plan, 'Would add');
  console.log('Nothing has been changed. Run fillKitStock to add this stock.');
}

/**
 * Gives every open site a full Up Time Kit for each machine model on the Kits tab (two SC180s = one kit;
 * machines ticked No kit on the Printers tab are left out),
 * assuming it is all there until an engineer counts it on site. Parts already held are topped up, not doubled,
 * so running it again adds nothing. Recorded as BOOK_IN, which the daily kit email ignores.
 */
function fillKitStock() {
  withLock_(() => {
    const plan = kitTopUp_();
    const now = new Date(), batch = Utilities.getUuid();
    const rows = [];
    plan.forEach(p => p.lines.forEach(l => rows.push({
      MovementID: Utilities.getUuid(), Timestamp: now, SiteID: p.site.SiteID, Family: l.family, ExactCode: l.family, Qty: l.qty,
      Type: 'BOOK_IN', JobNo: '', By: 'Kit setup', Role: 'admin', Device: 'Setup', Note: 'Assumed full kit, not yet checked on site', BatchID: batch
    })));
    if (rows.length) appendObjects_('Movements', rows);
    logKitPlan_(plan, 'Added');
  });
}

/** For each open site: the kit parts it should hold and how many to add to reach a full kit. */
function kitTopUp_() {
  const kits = kitsByModel_();
  const models = {};
  readTable_('Printers').forEach(p => {
    if (noKit_(p)) return;   // marked No kit on the Printers tab, e.g. a training machine
    const m = cleanModel_(p.Model), id = String(p.SiteID);
    const list = models[id] = models[id] || [];
    if (m && kits[m] && list.indexOf(m) < 0) list.push(m);
  });
  const held = {};
  movementColumns_().forEach(m => { const h = held[m.site] = held[m.site] || {}; h[m.family] = (h[m.family] || 0) + m.qty; });
  return readTable_('Sites').filter(s => s.SiteID && isTrue_(s.Active) && (models[String(s.SiteID)] || []).length).map(s => {
    const id = String(s.SiteID), want = {};
    models[id].forEach(m => Object.keys(kits[m]).forEach(f => { want[f] = (want[f] || 0) + kits[m][f]; }));
    const have = held[id] || {};
    const lines = Object.keys(want).map(f => ({ family: f, qty: want[f] - (have[f] || 0) })).filter(l => l.qty > 0);
    return { site: s, models: models[id], lines: lines };
  });
}

function logKitPlan_(plan, verb) {
  const busy = plan.filter(p => p.lines.length);
  busy.forEach(p => console.log(verb + ' ' + p.lines.reduce((n, l) => n + l.qty, 0) + ' item(s), ' + p.lines.length + ' part(s): ' +
    p.site.Name + ' (' + p.site.SiteID + ', ' + p.models.join(', ') + ')'));
  const items = busy.reduce((n, p) => n + p.lines.reduce((m, l) => m + l.qty, 0), 0);
  console.log(verb + ' ' + items + ' item(s) at ' + busy.length + ' site(s). ' + (plan.length - busy.length) + ' kit site(s) already had a full kit.');
}

function runSampleData() {
  loadSampleData_();
  console.log('Sample data added. Test PINs: engineer 1111, admin 9999. Delete the sample rows before going live.');
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
  Object.keys(SHEETS).forEach(name => {
    let sh = ss.getSheetByName(name);
    if (!sh) sh = ss.insertSheet(name);
    const head = SHEETS[name];
    if (sh.getLastRow() === 0) {
      sh.getRange(1, 1, 1, head.length).setValues([head]).setFontWeight('bold');
      sh.setFrozenRows(1);
    } else {
      // Tabs made by an older version: rename "Family" to "Part Number", then add any new columns
      // at the end, leaving existing data alone
      const first = sh.getRange(1, 1, 1, Math.max(1, sh.getLastColumn())).getValues()[0].map(String);
      first.forEach((h, j) => { if (h === 'Family') sh.getRange(1, j + 1).setValue('Part Number'); });
      const have = sh.getRange(1, 1, 1, Math.max(1, sh.getLastColumn())).getValues()[0].map(h => key_(String(h)));
      head.filter(h => have.indexOf(key_(h)) < 0).forEach(h => {
        sh.getRange(1, sh.getLastColumn() + 1).setValue(h).setFontWeight('bold');
      });
    }
  });
  // Keep codes and PINs as text so leading zeros survive
  // (columns found by heading, so they can be moved)
  [['Users', 'PIN'], ['Parts', 'Part Number'], ['Parts', 'Name'], ['Parts', 'ExactCodes'], ['Movements', 'Part Number'],
   ['Movements', 'ExactCode'], ['VanKit', 'Part Number'], ['Kits', 'Part Number']].forEach(([tab, h]) => {
    const L = colLetter_(col_(tab, h));
    ss.getSheetByName(tab).getRange(L + ':' + L).setNumberFormat('@');
  });
  addMissingSettings_();
  addSmallKits_();
  addNameLookups_();
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

/** Adds any Settings rows that are missing, with their default value and a note. Existing values are kept. */
function addMissingSettings_() {
  const existing = readTable_('Settings');
  const col = col_('Settings', 'Value');
  existing.forEach(r => {
    const k = String(r.Setting).trim();
    if ((SETTINGS_OLD_DEFAULTS[k] || []).indexOf(String(r.Value)) >= 0) {
      sheet_('Settings').getRange(r._row, col).setValue(SETTINGS_DEFAULTS.find(d => d[0] === k)[1]);
    }
  });
  const have = existing.map(r => String(r.Setting).trim());
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

/** Sample rows for trying the app. Real data replaces these. */
function loadSampleData_() {
  setupSheets_();
  appendObjects_('Sites', [
    { Name: 'Sample Print Co', Address: '1 Test Street, Leeds', Postcode: 'LS1 1AA', Active: true },
    { Name: 'Demo Graphics Ltd', Address: '2 Demo Road, Bradford', Postcode: 'BD1 1AA', Active: true }
  ]);
  ensureSiteTokens_();
  const sites = readTable_('Sites');
  const id = name => (sites.find(s => s.Name === name) || {}).SiteID;
  appendObjects_('Printers', [
    { SiteID: id('Sample Print Co'), Model: 'PC1120', Serial: '' },
    { SiteID: id('Demo Graphics Ltd'), Model: 'SC180', Serial: '' }
  ]);
  appendObjects_('Users', [
    { UserID: 'E01', Name: 'Test Engineer', Role: 'engineer', PIN: '1111', Active: true },
    { UserID: 'A01', Name: 'Test Admin', Role: 'admin', PIN: '9999', Active: true }
  ]);
  hashPendingPins_();
  const now = new Date();
  appendObjects_('Parts', [
    ['P059K6158X', 'Tray 1/2 Feed Roll'], ['P059K5813X', 'Tray 1/2 Feed Roll - Nudger'], ['P053K9189X', 'Filter'],
    ['P807E5651X', 'IBT Drive Gear (56T)'], ['P019E7597X', 'Finger Strip PR'], ['P127K5896X', 'Fusing Web Motor'],
    ['P004E1900X', 'Deburr Cushion Tape'], ['P059K5556X', 'Pinch Roll'], ['P023E2950X', 'Decurler Belt']
  ].map(p => ({ Family: p[0], Name: p[1], ExactCodes: '', Reviewed: true, AddedBy: 'Sample', AddedAt: now })));
}
