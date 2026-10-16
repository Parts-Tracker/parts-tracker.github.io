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
  const hour = Math.min(23, Math.max(0, Math.floor(Number(cfg.ReportHour)) || 18));
  ScriptApp.newTrigger('sendDailyKitReport').timeBased().everyDays(1).atHour(hour).create();
  const to = reportEmail_(cfg);
  console.log('Daily Up Time Kit email is on: sent around ' + hour + ':00 each day to ' + (to || '(no address: fill in ReportEmail on the Settings tab)') + ', only on days a kit part is used.');
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
      const have = sh.getRange(1, 1, 1, Math.max(1, sh.getLastColumn())).getValues()[0].map(String);
      head.filter(h => have.indexOf(h) < 0).forEach(h => {
        sh.getRange(1, sh.getLastColumn() + 1).setValue(h).setFontWeight('bold');
      });
    }
  });
  // Keep codes and PINs as text so leading zeros survive
  ss.getSheetByName('Users').getRange('D:D').setNumberFormat('@');
  ss.getSheetByName('Parts').getRange('A:C').setNumberFormat('@');
  ss.getSheetByName('Movements').getRange('D:E').setNumberFormat('@');
  ss.getSheetByName('VanKit').getRange('A:A').setNumberFormat('@');
  ss.getSheetByName('Kits').getRange('B:B').setNumberFormat('@');
  addMissingSettings_();
  addSmallKits_();
}

/** Adds any Settings rows that are missing, with their default value and a note. Existing values are kept. */
function addMissingSettings_() {
  const existing = readTable_('Settings');
  const col = SHEETS.Settings.indexOf('Value') + 1;
  existing.forEach(r => {
    const k = String(r.Setting).trim();
    if (SETTINGS_OLD_DEFAULTS[k] !== undefined && String(r.Value) === SETTINGS_OLD_DEFAULTS[k]) {
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
    { Name: 'Sample Print Co', Address: '1 Test Street, Leeds', Postcode: 'LS1 1AA', Contact: 'Sam Sample', Phone: '', Active: true },
    { Name: 'Demo Graphics Ltd', Address: '2 Demo Road, Bradford', Postcode: 'BD1 1AA', Contact: 'Dee Demo', Phone: '', Active: true }
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
