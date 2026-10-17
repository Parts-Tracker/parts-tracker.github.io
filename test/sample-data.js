/* Sample rows for the tests and the guide screenshots. Kept out of the backend on purpose: the live Sheet
   must never get these users, whose PINs (1111, 9999) are public in this repo. Uses the backend's own helpers. */
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
