/* Paste the Apps Script web app URL (ends in /exec) from Deploy > Manage deployments. */
window.PT_CONFIG = {
  apiUrl: 'https://script.google.com/macros/s/AKfycbxpjHmI0yJ_LkOI2Ye4EAPqnYFGcijBzH-jwM1PRg8pKd9Dv2Ik11I1E_xO4s2bRcYN/exec',

  // Van kit "Order parts" button: the Smartsheet order form, pre-filled with what the van is short of.
  // Left empty until the form's link and field names are known; the app offers "Copy order list" meanwhile.
  orderFormUrl: '',
  orderFormFields: {},   // e.g. { 'Engineer Name': '{engineer}' }
  orderFormParts: {}     // family code -> form field, e.g. { 'P053K0667X': 'P053K06670 Main Filter' }
};
