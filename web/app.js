/* Parts Tracker phone app. Talks to the Apps Script backend (see config.js). */
(function () {
  'use strict';
  const CFG = window.PT_CONFIG || {};
  const C = window.PTCodes;
  const $ = id => document.getElementById(id);

  const MODES = {
    BOOK_IN: { title: 'Book in a delivery', hint: 'Scan each part that arrived.', engineer: false, done: 'Booked in' },
    USED: { title: 'Parts used on a job', hint: 'Scan each part you fitted.', engineer: true, done: 'Recorded as used' },
    CUSTOMER_FITTED: { title: 'Parts we fitted ourselves', hint: 'Scan each part you fitted.', engineer: false, done: 'Recorded as fitted' },
    COUNT: { title: 'Stock count', hint: 'Scan every part here. Use + when there is more than one.', engineer: true, done: 'Count saved' }
  };
  const TYPE_LABEL = { BOOK_IN: 'Booked in', USED: 'Used', CUSTOMER_FITTED: 'Customer fitted', COUNT: 'Count' };
  // Each action has its own brand colour (see the tone-* classes in app.css)
  const TONES = { BOOK_IN: 'green', USED: 'pink', CUSTOMER_FITTED: 'purple', COUNT: 'blue' };
  const PILL = { BOOK_IN: 'Book in', USED: 'Used on a job', CUSTOMER_FITTED: 'Fitted by site', COUNT: 'Stock count' };
  function setPill(id, mode) {
    $(id).textContent = PILL[mode] || '';
    $(id).className = 'mode-pill tone-' + (TONES[mode] || 'green');
  }

  // ---------- Storage (this phone only; the app still works if it is unavailable) ----------
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
    del(k) { try { localStorage.removeItem(k); } catch (e) {} }
  };

  const state = {
    site: null,
    session: store.get('pt_session', null),
    user: store.get('pt_user', null),
    data: null,
    parts: new Map(),
    partsVersion: '',
    mode: null,
    basket: [],
    queue: store.get('pt_queue', []),
    sending: false,
    scanner: null,
    where: 'site',                    // 'site' or 'van': which stock the scan screens work on
    van: store.get('pt_van', null),
    view: null
  };

  // ---------- Small helpers ----------
  function el(tag, attrs, ...children) {
    const n = document.createElement(tag);
    Object.entries(attrs || {}).forEach(([k, v]) => {
      if (v == null || v === false) return;
      if (k === 'class') n.className = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v === true ? '' : v);
    });
    children.flat().forEach(c => { if (c != null && c !== false) n.append(c.nodeType ? c : String(c)); });
    return n;
  }
  function uuid() {
    if (crypto.randomUUID) return crypto.randomUUID();
    const b = crypto.getRandomValues(new Uint8Array(16));
    return Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
  }
  function deviceLabel() {
    const ua = navigator.userAgent;
    const ios = ua.match(/(?:iPhone|CPU) OS ([\d_]+)/);
    if (ios) return 'iOS ' + ios[1].replace(/_/g, '.');
    const a = ua.match(/Android ([\d.]+)/);
    return a ? 'Android ' + a[1] : (navigator.platform || 'browser');
  }
  function when(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d)) return '';
    const today = new Date();
    const sameDay = d.toDateString() === today.toDateString();
    return sameDay ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString([], { day: 'numeric', month: 'short' });
  }
  const isEngineer = () => !!state.user && /^(engineer|admin)$/i.test(state.user.role);
  const partName = family => (state.parts.get(family) || {}).name || '';

  let toastTimer = null;
  function toast(msg, action) {
    const t = $('toast');
    t.textContent = '';
    t.append(el('span', {}, msg));
    if (action) t.append(el('button', { onclick: () => { hideToast(); action.fn(); } }, action.label));
    t.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(hideToast, action ? 5000 : 3000);
  }
  function hideToast() { $('toast').classList.add('hidden'); }

  // ---------- Scan feedback: beep and vibrate ----------
  // Phones only allow sound after a tap, so the audio is unlocked on the first touch.
  // iPhones do not vibrate from web pages, and the silent switch mutes the beep.
  let audioCtx = null;
  function unlockAudio() {
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!audioCtx && AC) audioCtx = new AC();
      if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
    } catch (e) {}
  }
  function tone(freq, start, length) {
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    const t = audioCtx.currentTime + start;
    o.frequency.value = freq; o.connect(g); g.connect(audioCtx.destination);
    g.gain.setValueAtTime(0.25, t); g.gain.exponentialRampToValueAtTime(0.001, t + length);
    o.start(t); o.stop(t + length + 0.02);
  }
  /** 'good' = part added (one high beep); 'attention' = needs a look (two low beeps). */
  function feedback(kind) {
    try { if (navigator.vibrate) navigator.vibrate(kind === 'good' ? 90 : [70, 60, 70]); } catch (e) {}
    try {
      if (!audioCtx) return;
      if (kind === 'good') tone(1500, 0, 0.12);
      else { tone(520, 0, 0.12); tone(520, 0.18, 0.12); }
    } catch (e) {}
  }

  // ---------- Backend ----------
  async function api(req) {
    if (window.PT_MOCK_API) return window.PT_MOCK_API(JSON.parse(JSON.stringify(req)));
    if (!CFG.apiUrl || /PASTE/.test(CFG.apiUrl)) {
      const e = new Error('The app is not connected to its Google Sheet yet. Set apiUrl in config.js.');
      e.code = 'config'; throw e;
    }
    let res;
    try {
      res = await fetch(CFG.apiUrl, { method: 'POST', body: JSON.stringify(req), redirect: 'follow' });
    } catch (e) {
      const err = new Error('No connection.'); err.code = 'offline'; throw err;
    }
    if (!res.ok) { const e = new Error('Server error ' + res.status); e.code = 'offline'; throw e; }
    return res.json();
  }

  // ---------- Parts list (cached on the phone for offline lookups) ----------
  function setParts(version, list) {
    state.partsVersion = version || '';
    state.parts = new Map();
    (list || []).forEach(([family, name, codes]) => state.parts.set(family, { family, name, codes: String(codes || '') }));
  }
  function loadPartsCache() {
    const c = store.get('pt_parts', null);
    if (c) setParts(c.version, c.list);
  }
  function saveParts(version, list) {
    setParts(version, list);
    store.set('pt_parts', { version, list });
  }

  // ---------- Views ----------
  function show(id) {
    document.querySelectorAll('.view').forEach(v => { v.hidden = v.id !== id; });
    if (state.view === 'view-scan' && id !== 'view-scan' && state.scanner) state.scanner.stop();
    if (state.view !== id) hideToast();
    state.view = id;
    renderWhereSwitch(id);
    window.scrollTo(0, 0);
  }

  function renderBanner() {
    const b = $('banner');
    b.textContent = '';
    const failed = state.queue.filter(q => q.error);
    const waiting = state.queue.length;
    if (!waiting && !state.offline) { b.classList.add('hidden'); return; }
    let msg = state.offline ? 'Offline: showing saved data.' : '';
    if (waiting) msg += (msg ? ' ' : '') + waiting + (waiting === 1 ? ' record is' : ' records are') + ' waiting to send.';
    if (failed.length) msg += ' Problem: ' + failed[0].error;
    b.append(el('span', {}, msg));
    if (waiting) {
      b.append(el('button', { class: 'small', onclick: () => syncQueue(true) }, 'Send now'));
      if (failed.length) b.append(el('button', { class: 'small', onclick: discardFailed }, 'Discard'));
    }
    b.classList.remove('hidden');
  }

  function renderUserChip() {
    const chip = $('userChip');
    chip.hidden = false;
    chip.textContent = state.user ? state.user.name.split(' ')[0] + ' · Sign out' : 'Engineer sign in';
    chip.setAttribute('aria-label', state.user ? 'Signed in as ' + state.user.name + '. Sign out' : 'Engineer sign in');
  }

  function renderHome() {
    const d = state.data;
    if (!d) return;
    $('siteName').textContent = d.site.name;
    $('siteAddress').textContent = [d.site.address, d.site.postcode].filter(Boolean).join(', ');
    const pl = $('printerList'); pl.textContent = '';
    (d.printers || []).forEach(m => pl.append(el('span', {}, m)));
    // Customers only see what they can do; engineers see everything once signed in
    $('changeSite').hidden = !isEngineer();
    document.querySelectorAll('.action[data-engineer]').forEach(b => { b.hidden = !isEngineer(); });
    const parts = (d.stock || []).filter(s => s.qty > 0);
    const total = parts.reduce((n, s) => n + s.qty, 0);
    $('stockSummary').textContent = parts.length ? total + ' items, ' + parts.length + ' different parts' : 'Nothing recorded yet';
    renderRecent($('recentList'), d.recent);
    renderBanner();
  }

  function renderRecent(rl, recent) {
    rl.textContent = '';
    if (!(recent || []).length) rl.append(el('li', { class: 'muted' }, 'No activity yet.'));
    (recent || []).forEach(r => rl.append(el('li', {},
      activityIcon(r),
      el('div', { class: 'item-main' },
        el('div', { class: 'item-name' }, r.name || r.family),
        el('div', { class: 'item-sub' }, [TYPE_LABEL[r.type] || r.type, r.by, r.jobNo ? 'job ' + r.jobNo : '', r.pending ? 'waiting to send' : when(r.at)].filter(Boolean).join(' · '))),
      el('div', { class: 'qty' + (r.qty < 0 ? ' neg' : '') }, (r.qty > 0 ? '+' : '') + r.qty))));
  }

  const ARROW_IN = '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M6 13l6 6 6-6"/></svg>';
  const ARROW_OUT = '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M6 11l6-6 6 6"/></svg>';
  const TICK = '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
  /** Round icon for a recent-activity row: in (green), out (grey) or count. */
  function activityIcon(r) {
    const kind = r.type === 'COUNT' ? 'count' : r.qty > 0 ? 'in' : 'out';
    const span = el('span', { class: 'ricon ' + kind + ' tone-' + (TONES[r.type] || 'green'), 'aria-hidden': 'true' });
    span.innerHTML = kind === 'count' ? TICK : kind === 'in' ? ARROW_IN : ARROW_OUT;
    return span;
  }

  // ---------- Start-up ----------
  async function init() {
    const params = new URLSearchParams(location.search);
    const fromQr = params.get('s');
    if (fromQr) store.set('pt_site', fromQr);
    loadPartsCache();
    renderUserChip();
    bindEvents();
    registerServiceWorker();
    window.addEventListener('online', () => { state.offline = false; syncQueue(); if (state.site) loadSite(); });
    setInterval(() => syncQueue(), 60000);
    if (params.has('admin')) return openAdmin();
    state.site = fromQr || store.get('pt_site', null);
    if (!state.site) { if (isEngineer()) openVan(); else show('view-nosite'); return; }
    await loadSite();
    syncQueue();
  }

  async function loadSite() {
    const cached = store.get('pt_boot_' + state.site, null);
    if (cached && !state.data) {
      state.data = cached;
      renderHome();
      if (!state.view || state.view === 'view-nosite') show('view-home');
    }
    try {
      const r = await api({ action: 'bootstrap', site: state.site, partsVersion: state.partsVersion, session: state.session });
      if (!r.ok) {
        if (r.code === 'bad_site') {
          store.del('pt_site');
          show('view-nosite');
          $('view-nosite').querySelector('p').textContent = r.error;
          return;
        }
        throw Object.assign(new Error(r.error), { code: r.code });
      }
      if (r.parts) saveParts(r.partsVersion, r.parts);
      delete r.parts;
      if (state.session && !r.user) signOut(true);
      if (r.user) { state.user = r.user; store.set('pt_user', r.user); }
      state.data = r;
      state.offline = false;
      // Records still waiting to send are not on the server yet, so keep them in the picture
      state.queue.filter(q => q.site === state.site).forEach(applyLocally);
      store.set('pt_boot_' + state.site, state.data);
      renderUserChip();
      renderHome();
      if (!state.view || state.view === 'view-nosite') show('view-home');
    } catch (e) {
      state.offline = e.code === 'offline';
      if (!state.data) {
        show('view-nosite');
        $('view-nosite').querySelector('h1').textContent = state.offline ? 'No connection' : 'Could not load this site';
        $('view-nosite').querySelector('p').textContent = state.offline ? 'Connect to the internet once to load this site. After that it works offline.' : e.message;
      }
      renderBanner();
    }
  }

  // ---------- Sign in ----------
  function signOut(quiet) {
    state.session = null; state.user = null;
    store.del('pt_session'); store.del('pt_user');
    renderUserChip(); renderHome();
    if (state.where === 'van') { state.where = 'site'; goHome(); }
    else renderWhereSwitch(state.view);
    if (!quiet) toast('Signed out');
  }

  function askPin(then, title) {
    let pin = '';
    const display = el('div', { class: 'pin-display', 'aria-live': 'polite' }, '');
    const err = el('div', { class: 'error', hidden: true });
    const update = () => { display.textContent = '•'.repeat(pin.length); };
    let checking = false;
    const setChecking = on => {
      checking = on;
      display.textContent = on ? 'Checking…' : '•'.repeat(pin.length);
      display.classList.toggle('checking', on);
    };
    const submit = async () => {
      if (pin.length < 4 || checking) return;
      err.hidden = true;
      setChecking(true);
      try {
        const r = await api({ action: 'login', pin, site: state.site || 'admin' });
        setChecking(false);
        if (!r.ok) { err.textContent = r.error; err.hidden = false; pin = ''; update(); return; }
        state.session = r.session; state.user = r.user;
        store.set('pt_session', r.session); store.set('pt_user', r.user);
        closeSheet(); renderUserChip(); renderHome();
        toast('Signed in as ' + r.user.name);
        state.queue.forEach(q => { if (q.error && /sign in/i.test(q.error)) q.error = ''; });
        saveQueue(); syncQueue();
        if (then) then();
      } catch (e) {
        setChecking(false);
        err.textContent = e.code === 'offline' ? 'No connection. Signing in needs signal.' : e.message; err.hidden = false;
      }
    };
    const key = k => el('button', { onclick: () => {
      if (checking) return;
      if (k === 'del') pin = pin.slice(0, -1);
      else if (k === 'ok') return submit();
      else if (pin.length < 8) pin += k;
      update();
    } }, k === 'del' ? '⌫' : k === 'ok' ? 'OK' : k);
    openSheet(title || 'Engineer sign in', [
      el('p', { class: 'muted' }, 'Enter your PIN.'),
      display, err,
      el('div', { class: 'keypad' }, ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'del', '0', 'ok'].map(key)),
      el('div', { class: 'buttons' }, el('button', { onclick: closeSheet }, 'Cancel'))
    ]);
    warmUp();
  }

  /** Wakes the server while the PIN is typed, so the sign-in itself is quicker. */
  function warmUp() {
    if (window.PT_MOCK_API || !CFG.apiUrl || /PASTE/.test(CFG.apiUrl)) return;
    fetch(CFG.apiUrl, { mode: 'no-cors' }).catch(() => {});
  }

  // ---------- Bottom sheet ----------
  let sheetOnClose = null;
  function openSheet(title, content, onClose) {
    $('sheetTitle').textContent = title;
    const body = $('sheetBody'); body.textContent = '';
    [].concat(content).flat().forEach(c => { if (c != null && c !== '') body.append(c); });
    hideToast();
    $('sheet').classList.remove('hidden');
    $('sheetBackdrop').classList.remove('hidden');
    sheetOnClose = onClose || null;
    if (state.scanner) state.scanner.pause();
  }
  function closeSheet() {
    $('sheet').classList.add('hidden');
    $('sheetBackdrop').classList.add('hidden');
    const fn = sheetOnClose; sheetOnClose = null;
    if (fn) fn();
    resumeScan();
  }
  function resumeScan() {
    if (state.view === 'view-scan' && state.scanner && $('sheet').classList.contains('hidden')) state.scanner.resume();
  }

  // ---------- Scanning ----------
  function startMode(mode) {
    if (MODES[mode].engineer && !isEngineer()) {
      askPin(() => startMode(mode), 'Engineers only: sign in');
      return;
    }
    state.mode = mode;
    state.basket = [];
    const words = state.where === 'van' ? VAN_MODES[mode] : MODES[mode];
    $('scanTitle').textContent = words.title;
    setPill('scanPill', mode);
    $('view-scan').className = 'view tone-' + TONES[mode];
    $('scanHint').textContent = words.hint;
    $('basketTitle').textContent = mode === 'COUNT' ? 'Counted' : 'Scanned';
    renderBasket();
    show('view-scan');
    startCamera();
  }

  async function startCamera(deviceId) {
    if (!state.scanner) {
      state.scanner = PTScanner.startLive({
        video: $('video'), guide: $('guide'), viewport: $('viewport'),
        onRead: r => handleCode(r.text, 'barcode'),
        onStatus: t => { $('vpStatus').textContent = t; }
      });
    }
    $('vpStatus').textContent = 'Starting camera…';
    const info = await state.scanner.start(deviceId);
    if (!info) return;
    const z = $('zoom');
    z.min = info.zoom.min; z.max = info.zoom.max; z.step = info.zoom.step; z.value = info.zoom.value;
    $('torchBtn').classList.toggle('hidden', !info.torch);
    const sel = $('cameraSelect'); sel.textContent = '';
    info.cameras.forEach(c => sel.append(el('option', { value: c.id, selected: c.id === info.deviceId }, c.label)));
    sel.classList.toggle('hidden', info.cameras.length < 2);
    $('vpStatus').textContent = 'Point at a barcode';
  }

  /** A code from a barcode, photo, text reading or search. Known parts are added; unknown ones need a name. */
  function handleCode(raw, source) {
    const n = C.normalise(raw);
    if (!n.family) { resumeScan(); return; }
    const part = state.parts.get(n.family);
    if (part) {
      feedback('good');
      addToBasket(n, part.name, false);
      toast('Added: ' + part.name, { label: 'Undo', fn: () => changeQty(n.family, -1) });
      setTimeout(resumeScan, 600);
    } else {
      feedback('attention');
      confirmNewPart(n, source);
    }
  }

  function confirmNewPart(n, source) {
    const name = el('input', { class: 'input', placeholder: 'Part name from the box', maxlength: '120', autocomplete: 'off' });
    const err = el('div', { class: 'error', hidden: true }, 'Enter the part name from the box.');
    openSheet('Not in the parts list', [
      el('p', { class: 'muted' }, source === 'text' ? 'Read from the label text. Check every character against the box:' : 'Check every character against the box:'),
      el('div', { class: 'big-code' }, n.exact),
      n.warning ? el('div', { class: 'warn' }, 'This does not look like a normal part code. Only add it if it matches the box exactly.') : null,
      el('label', { class: 'muted' }, 'Part name', name),
      err,
      el('div', { class: 'buttons' },
        el('button', { class: 'primary', onclick: () => {
          if (!name.value.trim()) { err.hidden = false; return; }
          addToBasket(n, name.value.trim(), true);
          closeSheet();
          toast('Added new part: ' + name.value.trim());
        } }, 'Add new part'),
        el('button', { onclick: closeSheet }, 'Cancel'))
    ]);
    setTimeout(() => name.focus(), 50);
  }

  function addToBasket(n, name, isNew) {
    const existing = state.basket.find(b => b.family === n.family);
    if (existing) existing.qty++;
    else state.basket.push({ family: n.family, exact: n.exact, name, qty: 1, isNew, odd: !!n.warning });
    renderBasket();
  }
  function changeQty(family, delta) {
    const b = state.basket.find(x => x.family === family);
    if (!b) return;
    b.qty += delta;
    if (b.qty <= 0) state.basket = state.basket.filter(x => x !== b);
    renderBasket();
  }
  function renderBasket() {
    const list = $('basketList'); list.textContent = '';
    state.basket.forEach(b => list.append(el('li', {},
      el('div', { class: 'item-main' },
        el('div', { class: 'item-name' }, b.name, b.isNew ? el('span', { class: 'tag' }, 'new part') : null),
        el('div', { class: 'item-sub mono' }, b.family)),
      el('div', { class: 'stepper' },
        el('button', { 'aria-label': 'One less', onclick: () => changeQty(b.family, -1) }, '−'),
        el('span', { class: 'qty' }, b.qty),
        el('button', { 'aria-label': 'One more', onclick: () => changeQty(b.family, 1) }, '+')))));
    $('basketEmpty').hidden = state.basket.length > 0;
    const n = state.basket.reduce((s, b) => s + b.qty, 0);
    $('scanNext').disabled = !state.basket.length && state.mode !== 'COUNT';
    $('scanNext').textContent = n ? 'Review (' + n + ')' : 'Review';
  }

  async function onPhoto(file) {
    state.scanner && state.scanner.pause();
    toast('Reading photo…');
    try {
      const r = await PTScanner.decodePhoto(file);
      if (r && r.text) return handleCode(r.text, 'photo');
      feedback('attention');
      toast(r && r.suspect ? 'Barcode looks damaged (read as ' + r.suspect + '). Try Read text or Search.' : 'No barcode found. Try again closer, or use Search.');
    } catch (e) { toast(e.message); }
    resumeScan();
  }

  async function onTextPhoto(file) {
    const status = el('p', { class: 'muted' }, 'Reading text…');
    openSheet('Reading the label', [status, el('div', { class: 'buttons' }, el('button', { onclick: closeSheet }, 'Cancel'))]);
    try {
      const res = await PTScanner.readText(file, t => { status.textContent = t; });
      if ($('sheet').classList.contains('hidden')) return;
      showTextResults(res);
    } catch (e) { status.textContent = e.message; }
  }

  function showTextResults(res) {
    const items = res.candidates.map(fam => {
      const part = state.parts.get(fam);
      return el('button', { class: 'pick', onclick: () => {
        closeSheet();
        if (part) handleCode(fam, 'text'); else confirmNewPart(C.normalise(fam), 'text');
      } },
        el('span', {}, el('span', { class: 'item-name' }, part ? part.name : 'Not in parts list'), el('span', { class: 'item-sub mono' }, fam)),
        part ? '' : el('span', { class: 'tag' }, 'check'));
    });
    const frags = (res.fragments || []).slice(0, 3).map(f => el('button', { class: 'pick', onclick: () => { closeSheet(); openSearch(f); } },
      el('span', {}, el('span', { class: 'item-name' }, 'Search for ' + f), el('span', { class: 'item-sub' }, 'Part of a code was readable'))));
    openSheet(items.length ? 'Which part is it?' : 'No part code found', [
      el('p', { class: 'muted' }, items.length ? 'Pick the one that matches the box. Check the name.' : 'The text could not be read clearly.'),
      items, frags,
      el('div', { class: 'buttons' },
        el('button', { onclick: () => { closeSheet(); openSearch(''); } }, 'Search instead'),
        el('button', { onclick: closeSheet }, 'Cancel'))
    ]);
  }

  // ---------- Search ----------
  function searchParts(q) {
    const raw = String(q || '').toUpperCase().replace(/\s+/g, '');
    const core = raw.replace(/^(PFFB|PFB|FFB|FB|P)(?=\d)/, '');
    const words = String(q || '').toLowerCase().split(/\s+/).filter(Boolean);
    if (!raw) return [];
    const out = [];
    for (const p of state.parts.values()) {
      const codeHit = core && (p.family.slice(1).startsWith(core.slice(0, 9)) || p.codes.toUpperCase().replace(/[\s,]/g, ' ').includes(core));
      const nameHit = words.length && words.every(w => p.name.toLowerCase().includes(w));
      if (codeHit || nameHit) out.push(p);
      if (out.length >= 30) break;
    }
    return out;
  }
  function openSearch(initial) {
    const input = el('input', { class: 'input', placeholder: 'Part code or name', autocomplete: 'off', value: initial || '' });
    const results = el('div', {});
    const render = () => {
      results.textContent = '';
      const q = input.value.trim();
      const hits = searchParts(q);
      hits.forEach(p => results.append(el('button', { class: 'pick', onclick: () => { closeSheet(); handleCode(p.family, 'search'); } },
        el('span', {}, el('span', { class: 'item-name' }, p.name), el('span', { class: 'item-sub mono' }, p.family)))));
      const n = C.normalise(q);
      if (q && !n.warning && !state.parts.get(n.family)) {
        results.append(el('button', { class: 'pick', onclick: () => { closeSheet(); confirmNewPart(n, 'search'); } },
          el('span', {}, el('span', { class: 'item-name' }, 'Add ' + n.family + ' as a new part'), el('span', { class: 'item-sub' }, 'Not in the parts list'))));
      }
      if (q && !results.children.length) results.append(el('p', { class: 'muted' }, 'No matching parts.'));
    };
    input.addEventListener('input', render);
    openSheet('Search parts', [input, results, el('div', { class: 'buttons' }, el('button', { onclick: closeSheet }, 'Close'))]);
    render();
    setTimeout(() => input.focus(), 50);
  }

  // ---------- Review and send ----------
  function openReview() {
    const mode = state.mode;
    $('reviewTitle').textContent = (state.where === 'van' ? VAN_MODES[mode] : MODES[mode]).title;
    setPill('reviewPill', mode);
    const stock = {};
    (cur() && cur().stock || []).forEach(s => { stock[s.family] = s.qty; });
    const list = $('reviewList'); list.textContent = '';
    if (!state.basket.length) list.append(el('li', { class: 'muted' }, 'Nothing scanned.'));
    state.basket.forEach(b => list.append(el('li', {},
      el('div', { class: 'item-main' },
        el('div', { class: 'item-name' }, b.name, b.isNew ? el('span', { class: 'tag' }, 'new part') : null),
        el('div', { class: 'item-sub mono' }, b.family + (mode === 'COUNT' ? ' · on record: ' + (stock[b.family] || 0) : ''))),
      el('div', { class: 'qty' }, b.qty))));
    const zl = $('zeroList'); zl.textContent = '';
    const missing = mode === 'COUNT' ? Object.keys(stock).filter(f => stock[f] > 0 && !state.basket.some(b => b.family === f)) : [];
    missing.forEach(f => zl.append(el('li', {},
      el('input', { type: 'checkbox', checked: true, value: f, id: 'z-' + f, 'aria-label': 'Set ' + f + ' to 0' }),
      el('label', { class: 'item-main', for: 'z-' + f },
        el('div', { class: 'item-name' }, partName(f) || 'Unknown part'),
        el('div', { class: 'item-sub mono' }, f + ' · on record: ' + stock[f])))));
    $('zeroCard').hidden = !missing.length;
    $('jobCard').hidden = mode !== 'USED';
    $('reviewError').hidden = true;
    $('reviewSend').disabled = false;
    show('view-review');
  }

  async function sendReview() {
    const mode = state.mode;
    const jobNo = $('jobNo').value.trim();
    const err = $('reviewError');
    if (mode === 'USED' && !jobNo) { err.textContent = 'Enter the job or ticket number.'; err.hidden = false; return; }
    const zero = Array.from($('zeroList').querySelectorAll('input:checked')).map(i => i.value);
    if (!state.basket.length && !zero.length) { err.textContent = 'Nothing to send.'; err.hidden = false; return; }
    $('reviewSend').disabled = true;
    const batch = {
      batchId: uuid(), van: state.where === 'van' || undefined, site: state.where === 'van' ? null : state.site,
      siteName: state.where === 'van' ? 'your van' : (state.data ? state.data.site.name : ''), type: mode, jobNo,
      note: $('note').value.trim(), device: deviceLabel(), createdAt: new Date().toISOString(),
      by: state.user ? state.user.name : 'Customer',
      items: state.basket.map(b => ({ code: b.exact || b.family, qty: b.qty, name: b.isNew ? b.name : undefined })),
      zero, count: state.basket.reduce((s, b) => s + b.qty, 0)
    };
    // Saved on the phone first, shown as done straight away, then sent in the background
    // (the server takes a few seconds, and the phone may have no signal)
    if (batch.van && mode === 'BOOK_IN') clearOrdered(state.basket.map(b => b.family));
    state.queue.push(batch);
    saveQueue();
    applyLocally(batch);
    $('jobNo').value = ''; $('note').value = '';
    state.basket = [];
    showDone(batch);
    sendBatch(batch).then(result => showSendResult(batch, result));
  }

  /** Updates the site's stock and recent activity on the phone before the server confirms. */
  function applyLocally(batch) {
    const target = batch.van ? state.van : (state.data && batch.site === state.site ? state.data : null);
    if (!target) return;
    const stock = {};
    (target.stock || []).forEach(s => { stock[s.family] = Object.assign({}, s); });
    const sign = { BOOK_IN: 1, USED: -1, CUSTOMER_FITTED: -1 }[batch.type];
    const recent = [];
    const add = (family, name, qty) => {
      if (!stock[family]) stock[family] = { family, name: name || partName(family), qty: 0 };
      const was = stock[family].qty;
      stock[family].qty = sign ? was + sign * qty : qty;
      const delta = stock[family].qty - was;
      if (delta) recent.push({ at: batch.createdAt, family, name: stock[family].name, qty: delta, type: batch.type, by: batch.by, jobNo: batch.jobNo, pending: true });
    };
    batch.items.forEach(it => add(C.normalise(it.code).family, it.name, it.qty));
    if (batch.type === 'COUNT') (batch.zero || []).forEach(f => { if (!batch.items.some(it => C.normalise(it.code).family === f)) add(f, '', 0); });
    target.stock = Object.values(stock).filter(s => s.qty !== 0).sort((a, b) => (a.name || a.family).localeCompare(b.name || b.family));
    target.recent = recent.concat(target.recent || []).slice(0, 10);
    if (batch.van) { store.set('pt_van', state.van); renderVan(); }
    else { store.set('pt_boot_' + state.site, state.data); renderHome(); }
  }

  function showDone(batch) {
    state.doneBatch = batch.batchId;
    $('doneTitle').textContent = MODES[batch.type].done;
    $('doneText').textContent = batch.type === 'COUNT'
      ? 'Stock updated for ' + batch.siteName + '.'
      : batch.count + (batch.count === 1 ? ' part' : ' parts') + ' recorded at ' + batch.siteName + '.';
    $('doneHome').textContent = batch.van ? 'Back to my van' : 'Back to site';
    $('doneStatus').textContent = 'Sending…';
    $('doneStatus').className = 'send-status';
    $('doneWarn').hidden = true;
    show('view-done');
  }

  function belowZeroText(families) {
    return 'Stock went below zero for: ' + families.map(f => partName(f) || f).join(', ') + (state.where === 'van' ? '. Your van probably needs a stock count.' : '. This site probably needs a stock count.');
  }

  /** Shows how the background send went: on the done screen if it is still open, otherwise as a message. */
  function showSendResult(batch, result) {
    const onScreen = state.view === 'view-done' && state.doneBatch === batch.batchId;
    if (result.busy) return;
    if (!onScreen) {
      if (result.ok && result.belowZero.length) toast(belowZeroText(result.belowZero));
      return;
    }
    const status = $('doneStatus');
    if (result.ok) {
      status.textContent = 'Saved';
      status.className = 'send-status ok';
      if (result.belowZero.length) { $('doneWarn').textContent = belowZeroText(result.belowZero); $('doneWarn').hidden = false; }
    } else if (result.queued) {
      status.textContent = 'No signal. Saved on this phone; it will send automatically.';
      status.className = 'send-status wait';
    } else {
      status.textContent = 'Not sent: ' + result.error;
      status.className = 'send-status bad';
    }
  }

  function saveQueue() { store.set('pt_queue', state.queue); renderBanner(); }

  /** Sends one queued batch. Keeps it queued if offline or if sign-in is needed. */
  const inFlight = new Set();
  async function sendBatch(batch) {
    if (inFlight.has(batch.batchId)) return { ok: false, busy: true };
    inFlight.add(batch.batchId);
    try {
      return await sendBatchNow(batch);
    } finally {
      inFlight.delete(batch.batchId);
    }
  }
  async function sendBatchNow(batch) {
    try {
      const r = await api(Object.assign({ action: 'submit', session: state.session }, batch));
      if (r.ok) {
        state.queue = state.queue.filter(q => q.batchId !== batch.batchId);
        if (batch.van && state.van) {
          state.van.stock = r.stock;
          store.set('pt_van', state.van);
          loadVan();
        } else if (state.data && batch.site === state.site) {
          state.data.stock = r.stock;
          store.set('pt_boot_' + state.site, state.data);
          loadSite();
        }
        saveQueue();
        return { ok: true, belowZero: r.belowZero || [] };
      }
      batch.error = (r.code === 'session' || r.code === 'forbidden') ? r.error + ' Sign in to send it.' : r.error;
      saveQueue();
      return { ok: false, error: batch.error };
    } catch (e) {
      if (e.code === 'offline') { state.offline = true; renderBanner(); return { ok: false, queued: true }; }
      batch.error = e.message; saveQueue();
      return { ok: false, error: e.message };
    }
  }

  async function syncQueue(manual) {
    if (state.sending || !state.queue.length) return;
    state.sending = true;
    try {
      for (const batch of state.queue.slice()) {
        if (batch.error && !manual) continue;
        batch.error = '';
        const r = await sendBatch(batch);
        if (r.queued) break;
      }
      if (manual && !state.queue.length) toast('All records sent');
    } finally { state.sending = false; renderBanner(); }
  }

  function discardFailed() {
    if (!confirm('Discard the records that could not be sent? They will not be recorded.')) return;
    state.queue = state.queue.filter(q => !q.error);
    saveQueue();
  }

  // ---------- My van ----------
  // Each signed-in engineer has their own van stock (no QR code). The van kit (min/max per part) is shared by everyone.
  const VAN_MODES = {
    BOOK_IN: { title: 'Book in to my van', hint: 'Scan each part from your ByBox delivery.' },
    USED: { title: 'Used on a job', hint: 'Scan each part you fitted from your van.' },
    COUNT: { title: 'Van stock count', hint: 'Scan everything in the van. Use + when there is more than one.' }
  };
  const cur = () => (state.where === 'van' ? state.van : state.data);

  async function openVan() {
    if (!isEngineer()) { askPin(openVan, 'Engineer sign in'); return; }
    state.where = 'van';
    if (state.van) renderVan();
    show('view-van');
    await loadVan();
  }

  async function loadVan() {
    try {
      const r = await api({ action: 'van', session: state.session, partsVersion: state.partsVersion });
      if (!r.ok) {
        if (r.code === 'session') { signOut(true); askPin(openVan, 'Engineer sign in'); }
        else toast(r.error);
        return;
      }
      if (r.parts) saveParts(r.partsVersion, r.parts);
      delete r.parts;
      state.van = r;
      state.offline = false;
      // Van records still waiting to send are not on the server yet
      state.queue.filter(q => q.van).forEach(applyLocally);
      store.set('pt_van', state.van);
      renderVan();
    } catch (e) {
      state.offline = e.code === 'offline';
      if (!state.van) toast(state.offline ? 'No connection. Your van loads once you have signal.' : e.message);
      renderBanner();
    }
  }

  /**
   * Van kit parts to reorder, using the old Van Kit Manager's rule: a part with a minimum above 0 is short when
   * stock is at or below that minimum, and the order tops it back up to maximum (at least 1).
   * Parts already ordered (and not yet booked in) are flagged so they are not ordered twice.
   */
  function vanShortfall() {
    const have = {};
    (state.van && state.van.stock || []).forEach(s => { have[s.family] = s.qty; });
    const ordered = orderedParts();
    return (state.van && state.van.kit || []).map(k => Object.assign({ have: have[k.family] || 0 }, k))
      .filter(k => k.min > 0 && k.have <= k.min)
      .map(k => Object.assign({ order: Math.max(1, Math.ceil(k.max - k.have)), ordered: ordered.includes(k.family) }, k))
      .sort((a, b) => (partName(a.family) || a.family).localeCompare(partName(b.family) || b.family));
  }
  const toOrder = () => vanShortfall().filter(k => !k.ordered);

  // Parts sent to the order form are remembered on this phone until they are booked in to the van
  const orderedKey = () => 'pt_ordered_' + (state.van ? state.van.van.id : '');
  function orderedParts() { return store.get(orderedKey(), []); }
  function markOrdered(families) { store.set(orderedKey(), [...new Set(orderedParts().concat(families))]); }
  function clearOrdered(families) { store.set(orderedKey(), orderedParts().filter(f => !families.includes(f))); }

  function renderVan() {
    const v = state.van;
    if (!v) return;
    $('vanName').textContent = v.van.name;
    const items = (v.stock || []).filter(s => s.qty > 0);
    $('vanSummary').textContent = items.length ? items.reduce((n, s) => n + s.qty, 0) + ' items, ' + items.length + ' different parts' : 'Nothing booked in yet';
    const kit = v.kit || [];
    const short = vanShortfall();
    const waiting = short.filter(k => k.ordered).length;
    const status = $('vanKitStatus');
    const list = $('vanKitList'); list.textContent = '';
    if (!kit.length) {
      status.textContent = 'No van kit set up yet. Add parts with Min and Max to the VanKit tab in the Sheet.';
      status.className = 'kit-status muted';
    } else if (!short.length) {
      status.textContent = 'All ' + kit.length + ' van kit parts are above minimum.';
      status.className = 'kit-status ok';
    } else {
      status.textContent = short.length + ' of ' + kit.length + ' van kit parts need ordering' + (waiting ? ' (' + waiting + ' already ordered)' : '');
      status.className = 'kit-status low';
      short.forEach(k => list.append(el('li', {},
        el('div', { class: 'item-main' },
          el('div', { class: 'item-name' }, partName(k.family) || 'Unknown part'),
          el('div', { class: 'item-sub' }, k.family + ' · have ' + k.have + ' · min ' + k.min + ' · max ' + k.max)),
        k.ordered
          // Tapping the badge undoes it, for when the form was opened but the order was not submitted
          ? el('button', { class: 'ordered-badge', 'aria-label': 'Ordered. Tap to mark as not ordered', onclick: () => {
              if (confirm('Mark ' + (partName(k.family) || k.family) + ' as not ordered?')) { clearOrdered([k.family]); renderVan(); }
            } }, '✓ Ordered')
          : el('div', { class: 'order-qty' }, 'Order ' + k.order))));
    }
    $('vanKitActions').hidden = !short.length;
    renderRecent($('vanRecentList'), v.recent);
    renderBanner();
  }

  function orderLines() {
    return toOrder().map(k => k.family + '  ' + (partName(k.family) || '') + '  x' + k.order);
  }
  async function copyOrder() {
    const text = orderLines().join('\n') || 'Nothing to order: everything short is already ordered.';
    try { await navigator.clipboard.writeText(text); toast('Order list copied'); }
    catch (e) { openSheet('Order list', [el('pre', { class: 'order-text' }, text), el('div', { class: 'buttons' }, el('button', { onclick: closeSheet }, 'Close'))]); }
  }

  // --- Order review, then the Smartsheet parts order form, filled in as the old Van Kit Manager did ---
  const FORM_MAX_PARTS = 9;
  // The form's part fields are not named consistently, so each row's names are listed exactly (including the space after "5 Part Description ")
  const FORM_PART_FIELDS = [
    ['1 Part No.', '1 Qty', '1 Description'], ['2 Part No.', '2 Qty', '2 Description'], ['3 Part No.', '3 Qty', '3 Description'],
    ['4 Part No.', '4 Qty', '4 Description'], ['5 Part code', '5 qty', '5 Part Description '], ['6 part number', '6 Qty', '6 part description'],
    ['7 part code', '7 qty', '7 part description'], ['8 part code', '8 qty', '8 part description'], ['9 part code', '9 qty', '9 description']
  ];
  function smartsheetUrl(lines) {
    const p = new URLSearchParams();
    p.append('Parts Reason', 'CAR STOCK');
    p.append('Urgency', 'Med - As soon as possible');
    p.append('Pre 10:30', 'No');
    p.append('ByBox/Collection', 'Yes');
    p.append('SD CALL No.', 'Van Kit');
    p.append('Notes', 'Van Kit Replenishment');
    const tomorrow = new Date(Date.now() + 86400000);
    p.append('Date Required Onsite', tomorrow.toLocaleDateString('en-GB'));
    const me = (state.van && state.van.orderDetails) || { name: state.user ? state.user.name : '' };
    p.append('Customer Name', me.name);
    p.append('Engineer Name Attending', me.name);
    p.append('Part Requested By', me.name);
    if (me.email) { p.append('Engineer Email', me.email); p.append('Email', me.email); p.append('Send me a copy of my responses', 'true'); }
    if (me.postcode) p.append('Post Code', me.postcode);
    if (me.byBox) p.append('ByBox Location / Collection Point', me.byBox.replace(/My ByBox location is\s*/i, '').trim());
    lines.slice(0, FORM_MAX_PARTS).forEach((l, i) => {
      const [part, qty, desc] = FORM_PART_FIELDS[i];
      p.append(part, l.family);
      p.append(qty, String(l.qty));
      p.append(desc, partName(l.family) || '');
    });
    if (lines.length > 4) p.append('Order Additional Parts', 'true');
    return CFG.orderFormUrl + (CFG.orderFormUrl.includes('?') ? '&' : '?') + p.toString();
  }

  /** "Order parts": review what is short (change quantities, remove lines), then open the order form. */
  function orderParts() {
    const lines = toOrder().map(k => ({ family: k.family, qty: k.order }));
    if (!lines.length) { toast(vanShortfall().length ? 'Everything short is already ordered.' : 'Nothing needs ordering.'); return; }
    const list = el('ul', { class: 'list' });
    const note = el('p', { class: 'muted' });
    const render = () => {
      list.textContent = '';
      lines.forEach((l, i) => list.append(el('li', {},
        el('div', { class: 'item-main' }, el('div', { class: 'item-name' }, partName(l.family) || 'Unknown part'), el('div', { class: 'item-sub mono' }, l.family)),
        el('div', { class: 'stepper' },
          el('button', { 'aria-label': 'One less', onclick: () => { if (l.qty > 1) l.qty--; else lines.splice(i, 1); render(); } }, '−'),
          el('span', { class: 'qty' }, l.qty),
          el('button', { 'aria-label': 'One more', onclick: () => { l.qty++; render(); } }, '+')))));
      note.textContent = lines.length > FORM_MAX_PARTS
        ? 'The order form takes ' + FORM_MAX_PARTS + ' parts. The first ' + FORM_MAX_PARTS + ' go on this order; order the rest afterwards.'
        : lines.length + (lines.length === 1 ? ' part' : ' parts') + ' will be filled in on the order form.';
      send.disabled = !lines.length;
    };
    const send = el('button', { class: 'primary', onclick: () => {
      const sent = lines.slice(0, FORM_MAX_PARTS);
      if (!CFG.orderFormUrl) { toast('The order form link is missing from config.js.'); return; }
      window.open(smartsheetUrl(sent), '_blank');
      markOrdered(sent.map(l => l.family));
      closeSheet();
      renderVan();
      toast('Order form opened. Check it and press Submit in Smartsheet.');
    } }, 'Open order form');
    openSheet('Order van stock', [note, list, el('div', { class: 'buttons' }, send, el('button', { onclick: closeSheet }, 'Cancel'))]);
    render();
  }

  /** Site / My van switch, shown to signed-in engineers on the two home screens. */
  function renderWhereSwitch(id) {
    const sw = $('whereSwitch');
    sw.hidden = !(isEngineer() && (id === 'view-home' || id === 'view-van'));
    sw.querySelectorAll('button').forEach(b => b.setAttribute('aria-selected', String((b.dataset.where === 'van') === (id === 'view-van'))));
    sw.querySelector('[data-where=site]').disabled = !state.data;
  }
  function goHome() {
    if (state.where === 'van' && isEngineer()) { renderVan(); show('view-van'); }
    else if (state.data) { state.where = 'site'; renderHome(); show('view-home'); }
    else show('view-nosite');
  }

  // ---------- Change site (engineers) ----------
  // Lets a signed-in engineer move to another site in the same tab, instead of scanning its QR code
  // (each scan opens a new browser tab). The list is kept on the phone for poor signal.
  async function chooseSite() {
    if (!isEngineer()) { askPin(chooseSite, 'Engineer sign in'); return; }
    let sites = store.get('pt_sites', []);
    const input = el('input', { class: 'input', placeholder: 'Site name, town or postcode', autocomplete: 'off' });
    const status = el('p', { class: 'muted' }, sites.length ? '' : 'Loading sites…');
    const results = el('div', {});
    const recentIds = () => store.get('pt_recent_sites', []);
    const render = () => {
      results.textContent = '';
      const q = input.value.trim().toLowerCase().replace(/\s+/g, ' ');
      let list;
      if (q) {
        list = sites.filter(s => [s.name, s.town, s.postcode, String(s.postcode || '').replace(/\s/g, '')].join(' ').toLowerCase().includes(q));
      } else {
        const recent = recentIds().map(id => sites.find(s => s.id === id)).filter(Boolean);
        list = recent.concat(sites.filter(s => !recent.includes(s)));
        if (recent.length) results.append(el('p', { class: 'section-title' }, 'Recent sites first'));
      }
      list.slice(0, 40).forEach(s => results.append(el('button', { class: 'pick', onclick: () => { closeSheet(); switchSite(s); } },
        el('span', {}, el('span', { class: 'item-name' }, s.name), el('span', { class: 'item-sub' }, [s.town, s.postcode].filter(Boolean).join(' · '))),
        s.token === state.site ? el('span', { class: 'tag current' }, 'current') : null)));
      if (q && !list.length) results.append(el('p', { class: 'muted' }, 'No sites match.'));
      if (list.length > 40) results.append(el('p', { class: 'muted' }, 'Showing 40 of ' + list.length + '. Type to narrow the list.'));
    };
    input.addEventListener('input', render);
    openSheet('Change site', [input, status, results, el('div', { class: 'buttons' }, el('button', { onclick: closeSheet }, 'Cancel'))]);
    render();
    try {
      const r = await api({ action: 'sites', session: state.session });
      if (!r.ok) { status.textContent = r.error; return; }
      sites = r.sites.sort((a, b) => a.name.localeCompare(b.name));
      store.set('pt_sites', sites);
      status.textContent = '';
      render();
    } catch (e) {
      status.textContent = sites.length ? 'No connection: showing the saved list.' : 'No connection. The site list needs signal the first time.';
    }
  }

  function switchSite(s) {
    state.site = s.token;
    store.set('pt_site', s.token);
    store.set('pt_recent_sites', [s.id].concat(store.get('pt_recent_sites', []).filter(id => id !== s.id)).slice(0, 5));
    history.replaceState(null, '', location.pathname);   // a reload keeps the chosen site, not the last QR code
    state.where = 'site';
    state.data = store.get('pt_boot_' + s.token, null);
    if (state.data) { renderHome(); show('view-home'); }
    toast('Now at ' + s.name);
    loadSite().then(() => { if (state.data && state.view !== 'view-home' && state.site === s.token) { renderHome(); show('view-home'); } });
  }

  // ---------- Stock view ----------
  function renderStock() {
    const q = $('stockFilter').value.trim().toLowerCase();
    const list = $('stockList'); list.textContent = '';
    const inVan = state.where === 'van';
    $('stockTitle').textContent = inVan ? 'Stock in my van' : 'Stock at this site';
    const kit = {};
    if (inVan) (state.van && state.van.kit || []).forEach(k => { kit[k.family] = k; });
    const rows = (cur() && cur().stock || []).filter(s => !q || (s.name || '').toLowerCase().includes(q) || s.family.toLowerCase().includes(q.replace(/\s/g, '')));
    rows.forEach(s => list.append(el('li', {},
      el('div', { class: 'item-main' }, el('div', { class: 'item-name' }, s.name || partName(s.family) || 'Unknown part'),
        el('div', { class: 'item-sub mono' }, s.family + (kit[s.family] ? ' · min ' + kit[s.family].min + ' · max ' + kit[s.family].max : ''))),
      el('div', { class: 'qty' + (s.qty < 0 || (kit[s.family] && s.qty < kit[s.family].min) ? ' neg' : '') }, s.qty))));
    $('stockEmpty').hidden = rows.length > 0;
  }

  // ---------- Admin dashboard ----------
  // One request loads every site, all stock lines and the parts list; everything else is worked out on the phone.
  const admin = { data: null, parts: new Map(), byFamily: new Map(), bySite: [], qrBuilt: false, tab: 'find' };

  async function openAdmin() {
    $('siteName').textContent = 'Admin';
    show('view-admin');
    if (!state.user || !/admin/i.test(state.user.role)) { askPin(loadAdmin, 'Admin sign in'); return; }
    loadAdmin();
  }

  async function loadAdmin() {
    $('adminSummary').textContent = 'Loading…';
    try {
      const r = await api({ action: 'admin', session: state.session });
      if (!r.ok) { $('adminSummary').textContent = r.error; if (r.code === 'session' || r.code === 'forbidden') askPin(loadAdmin, 'Admin sign in'); return; }
      // Older backends send fewer details per site; fill the gaps so the dashboard still works
      r.sites = (r.sites || []).map(s => Object.assign({ town: '', postcode: '', printers: [], lastActivity: '', items: 0 }, s));
      admin.data = r;
      admin.parts = new Map((r.parts || []).map(([family, name, codes]) => [family, { family, name, codes: String(codes || '') }]));
      admin.byFamily = new Map();
      admin.bySite = r.sites.map(() => []);
      (r.stock || []).forEach(([si, family, qty]) => {
        if (!admin.byFamily.has(family)) admin.byFamily.set(family, []);
        admin.byFamily.get(family).push({ site: si, qty });
        admin.bySite[si].push({ family, qty });
      });
      admin.qrBuilt = false;
      $('adminSummary').textContent = r.stock ? '' : 'The Apps Script backend needs updating to show stock here (paste the new Code.gs and deploy a new version).';
      renderAdminStats();
      renderPartResults();
      renderSites();
      if (admin.tab === 'qr') renderQr();
    } catch (e) { $('adminSummary').textContent = e.code === 'offline' ? 'No connection. The dashboard needs signal.' : e.message; }
  }

  const adminPartName = f => (admin.parts.get(f) || {}).name || 'Unknown part';
  const siteLine = s => [s.town, s.postcode].filter(Boolean).join(' · ');

  function renderAdminStats() {
    const d = admin.data;
    const items = d.sites.reduce((n, s) => n + s.items, 0);
    const holding = d.sites.filter(s => s.items > 0).length;
    const never = d.sites.filter(s => !s.lastCount).length;
    const stat = (value, label, tone) => el('div', { class: 'stat' + (tone ? ' tone-' + tone : '') }, el('div', { class: 'stat-value' }, value), el('div', { class: 'stat-label' }, label));
    const box = $('adminStats'); box.textContent = '';
    box.append(
      stat(d.sites.length, 'sites', 'green'),
      stat(items, 'items at ' + holding + (holding === 1 ? ' site' : ' sites'), 'lime'),
      stat(never, 'never counted', never ? 'pink' : 'blue'),
      stat(d.unreviewedParts, 'new parts to check', d.unreviewedParts ? 'purple' : 'blue'));
  }

  function showAdminTab(tab) {
    admin.tab = tab;
    document.querySelectorAll('[data-admin-tab]').forEach(b => b.setAttribute('aria-selected', String(b.dataset.adminTab === tab)));
    ['find', 'sites', 'site', 'qr'].forEach(t => { $('admin-' + t).hidden = t !== tab; });
    if (tab === 'qr') renderQr();
  }

  // --- Find a part: which sites hold it ---
  function matchAdminParts(q) {
    const raw = q.toUpperCase().replace(/\s+/g, '');
    const core = raw.replace(/^(PFFB|PFB|FFB|FB|P)(?=\d)/, '');
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    const out = [];
    for (const p of admin.parts.values()) {
      const codeHit = core.length >= 3 && /\d/.test(core) && (p.family.slice(1).startsWith(core.slice(0, 9)) || p.codes.toUpperCase().replace(/[\s,]+/g, ' ').includes(core));
      const nameHit = words.length && words.every(w => p.name.toLowerCase().includes(w));
      if (codeHit || nameHit) out.push(p);
    }
    return out;
  }
  function holdersOf(family) {
    return (admin.byFamily.get(family) || []).filter(h => h.qty !== 0).sort((a, b) => b.qty - a.qty);
  }
  function renderPartResults() {
    const out = $('partResults'); out.textContent = '';
    if (!admin.data) return;
    const q = $('partQuery').value.trim();
    let parts, heading;
    if (q) {
      parts = matchAdminParts(q);
      heading = parts.length ? parts.length + (parts.length === 1 ? ' matching part' : ' matching parts') : 'No matching parts';
    } else {
      // Nothing typed: show the parts held at the most sites
      parts = [...admin.byFamily.keys()].map(f => admin.parts.get(f) || { family: f, name: 'Unknown part', codes: '' })
        .sort((a, b) => holdersOf(b.family).length - holdersOf(a.family).length).slice(0, 10);
      heading = parts.length ? 'Most widely held parts' : 'No stock recorded at any site yet';
    }
    const total = f => holdersOf(f).reduce((n, h) => n + Math.max(0, h.qty), 0);
    parts.sort((a, b) => total(b.family) - total(a.family));
    out.append(el('p', { class: 'muted' }, heading));
    parts.slice(0, 25).forEach(p => {
      const holders = holdersOf(p.family);
      const held = holders.filter(h => h.qty > 0).length, below = holders.filter(h => h.qty < 0).length;
      // Below-zero records mean more were used than booked in: the site needs a count, not a "0 held"
      const summary = held ? total(p.family) + ' at ' + held + (held === 1 ? ' site' : ' sites')
        : below ? 'Below zero at ' + below + (below === 1 ? ' site' : ' sites') + ': needs a count' : 'Not at any site';
      const card = el('div', { class: 'card part-card' },
        el('div', { class: 'part-head' },
          el('div', { class: 'item-main' }, el('div', { class: 'item-name' }, p.name), el('div', { class: 'item-sub mono' }, p.family)),
          el('div', { class: 'part-total' + (held ? '' : below ? ' below' : ' none') }, summary)));
      if (holders.length) {
        const ul = el('ul', { class: 'list' });
        holders.forEach(h => {
          const s = admin.data.sites[h.site];
          ul.append(el('li', { class: 'clickable', onclick: () => showSiteDetail(h.site) },
            el('div', { class: 'item-main' }, el('div', { class: 'item-name' }, s.name), el('div', { class: 'item-sub' }, siteLine(s))),
            el('div', { class: 'qty' + (h.qty < 0 ? ' neg' : '') }, h.qty)));
        });
        card.append(ul);
      }
      out.append(card);
    });
  }

  // --- Sites list ---
  function filteredSites() {
    const q = $('siteQuery').value.trim().toLowerCase();
    return admin.data.sites.map((s, i) => Object.assign({ i }, s)).filter(s => !q ||
      [s.name, s.town, s.postcode, s.postcode.replace(/\s/g, ''), s.printers.join(' ')].join(' ').toLowerCase().includes(q));
  }
  function renderSites() {
    if (!admin.data) return;
    const sort = $('siteSort').value;
    const rows = filteredSites().sort((a, b) =>
      sort === 'items' ? b.items - a.items || a.name.localeCompare(b.name)
        : sort === 'count' ? (a.lastCount || '').localeCompare(b.lastCount || '') || a.name.localeCompare(b.name)
          : a.name.localeCompare(b.name));
    $('siteCount').textContent = rows.length + ' of ' + admin.data.sites.length + ' sites';
    const ul = $('siteList'); ul.textContent = '';
    rows.forEach(s => ul.append(el('li', { class: 'clickable', onclick: () => showSiteDetail(s.i) },
      el('div', { class: 'item-main' },
        el('div', { class: 'item-name' }, s.name),
        el('div', { class: 'item-sub' }, [siteLine(s), s.printers.join(', ')].filter(Boolean).join(' · ')),
        el('div', { class: 'item-sub' + (s.lastCount ? '' : ' warn-text') }, s.lastCount ? 'Counted ' + when(s.lastCount) : 'Never counted')),
      el('div', { class: 'qty' }, s.items))));
    if (!rows.length) ul.append(el('li', { class: 'muted' }, 'No sites match.'));
  }

  // --- One site ---
  function showSiteDetail(i) {
    const s = admin.data.sites[i];
    const head = $('siteDetailHead'); head.textContent = '';
    head.append(
      el('div', { class: 'hero-label' }, 'Site ' + s.id),
      el('h1', { class: 'site-name' }, s.name),
      el('div', { class: 'hero-address' }, siteLine(s)),
      el('div', { class: 'chips' }, s.printers.map(m => el('span', {}, m))),
      el('div', { class: 'hero-address hero-meta' }, [s.lastCount ? 'Counted ' + when(s.lastCount) : 'Never counted', s.lastActivity ? 'last activity ' + when(s.lastActivity) : 'no activity yet'].join(' · ')));
    const ul = $('siteDetailStock'); ul.textContent = '';
    const lines = admin.bySite[i].filter(l => l.qty !== 0).sort((a, b) => adminPartName(a.family).localeCompare(adminPartName(b.family)));
    lines.forEach(l => ul.append(el('li', {},
      el('div', { class: 'item-main' }, el('div', { class: 'item-name' }, adminPartName(l.family)), el('div', { class: 'item-sub mono' }, l.family)),
      el('div', { class: 'qty' + (l.qty < 0 ? ' neg' : '') }, l.qty))));
    if (!lines.length) ul.append(el('li', { class: 'muted' }, 'No stock recorded.'));
    $('siteDetailOpen').href = siteUrl(s.token);
    ['find', 'sites', 'qr'].forEach(t => { $('admin-' + t).hidden = true; });
    $('admin-site').hidden = false;
    window.scrollTo(0, 0);
  }

  // --- QR codes: built when the tab is opened; untick a card to leave it out of the print ---
  function siteUrl(token) {
    return location.origin + location.pathname.replace(/index\.html$/, '') + '?s=' + encodeURIComponent(token);
  }
  /**
   * Prints just one QR card, whatever is ticked. The other cards stay hidden until the print screen
   * closes ('afterprint'): iPhones open the print screen after print() returns, so no timer is used.
   */
  function printOne(card) {
    clearSolo();
    document.body.classList.add('print-solo');
    card.classList.add('solo');
    window.addEventListener('afterprint', clearSolo, { once: true });
    window.print();
  }
  function clearSolo() {
    document.body.classList.remove('print-solo');
    document.querySelectorAll('.qr-card.solo').forEach(c => c.classList.remove('solo'));
  }

  function renderQr() {
    if (admin.qrBuilt || !admin.data) return;
    const grid = $('qrGrid'); grid.textContent = '';
    grid.append(el('div', { class: 'row3 no-print qr-select' },
      el('button', { class: 'small', onclick: () => grid.querySelectorAll('.qr-card input').forEach(c => { c.checked = true; c.dispatchEvent(new Event('change')); }) }, 'Select all'),
      el('button', { class: 'small', onclick: () => grid.querySelectorAll('.qr-card input').forEach(c => { c.checked = false; c.dispatchEvent(new Event('change')); }) }, 'Select none')));
    admin.data.sites.map((s, i) => Object.assign({ i }, s)).sort((a, b) => a.name.localeCompare(b.name)).forEach(s => {
      const url = siteUrl(s.token);
      const card = el('div', { class: 'qr-card' });
      const tick = el('input', { type: 'checkbox', checked: true, 'aria-label': 'Print ' + s.name });
      tick.addEventListener('change', () => card.classList.toggle('skip', !tick.checked));
      card.append(el('div', { class: 'qr-actions no-print' },
        el('label', { class: 'qr-tick' }, tick, 'Include in Print selected'),
        el('button', { class: 'small', onclick: () => printOne(card) }, 'Print this one')));
      if (window.qrcode) {
        const qr = qrcode(0, 'M'); qr.addData(url); qr.make();
        const holder = el('div', {}); holder.innerHTML = qr.createSvgTag(4, 2);
        card.append(holder);
      }
      card.append(
        el('div', { class: 'qr-site' }, s.name),
        el('div', { class: 'qr-hint' }, 'Scan to book parts in and out'),
        el('div', { class: 'qr-meta' }, siteLine(s)),
        el('a', { href: url }, 'Open site'));
      grid.append(card);
    });
    admin.qrBuilt = true;
  }

  // ---------- Events ----------
  function bindEvents() {
    document.addEventListener('pointerdown', unlockAudio, true);
    $('themeBtn').addEventListener('click', toggleTheme);
    if (darkQuery && darkQuery.addEventListener) darkQuery.addEventListener('change', renderThemeButton);
    renderThemeButton();
    $('userChip').addEventListener('click', () => state.user ? signOut() : askPin(null));
    document.querySelectorAll('.action[data-mode]').forEach(b => b.addEventListener('click', () => { state.where = 'site'; startMode(b.dataset.mode); }));
    document.querySelectorAll('.action[data-van-mode]').forEach(b => b.addEventListener('click', () => { state.where = 'van'; startMode(b.dataset.vanMode); }));
    document.querySelectorAll('#whereSwitch button').forEach(b => b.addEventListener('click', () => {
      if (b.dataset.where === 'van') openVan(); else { state.where = 'site'; goHome(); }
    }));
    $('nositeVan').addEventListener('click', openVan);
    $('nositeChoose').addEventListener('click', chooseSite);
    $('changeSite').addEventListener('click', chooseSite);
    $('vanStockBtn').addEventListener('click', () => { $('stockFilter').value = ''; renderStock(); show('view-stock'); });
    $('orderParts').addEventListener('click', orderParts);
    $('copyOrder').addEventListener('click', copyOrder);
    $('viewStockBtn').addEventListener('click', () => { state.where = 'site'; $('stockFilter').value = ''; renderStock(); show('view-stock'); });
    $('stockFilter').addEventListener('input', renderStock);
    $('stockBack').addEventListener('click', goHome);
    $('zoom').addEventListener('input', e => state.scanner && state.scanner.applyZoom(Number(e.target.value)));
    $('torchBtn').addEventListener('click', () => state.scanner && state.scanner.torch());
    $('cameraSelect').addEventListener('change', e => startCamera(e.target.value));
    $('photoInput').addEventListener('change', e => { const f = e.target.files[0]; e.target.value = ''; if (f) onPhoto(f); });
    $('textInput').addEventListener('change', e => { const f = e.target.files[0]; e.target.value = ''; if (f) onTextPhoto(f); });
    $('searchBtn').addEventListener('click', () => openSearch(''));
    $('scanCancel').addEventListener('click', () => {
      if (state.basket.length && !confirm('Discard the parts scanned so far?')) return;
      state.basket = []; show('view-home');
    });
    $('scanNext').addEventListener('click', openReview);
    $('reviewBack').addEventListener('click', () => { show('view-scan'); startCamera(); });
    $('reviewSend').addEventListener('click', sendReview);
    $('doneHome').addEventListener('click', goHome);
    $('sheetBackdrop').addEventListener('click', closeSheet);
    $('printQr').addEventListener('click', () => window.print());
    $('adminRefresh').addEventListener('click', loadAdmin);
    document.querySelectorAll('[data-admin-tab]').forEach(b => b.addEventListener('click', () => showAdminTab(b.dataset.adminTab)));
    $('partQuery').addEventListener('input', renderPartResults);
    $('siteQuery').addEventListener('input', renderSites);
    $('siteSort').addEventListener('change', renderSites);
    $('siteBack').addEventListener('click', () => showAdminTab('sites'));
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && state.scanner) state.scanner.stop();
      else if (!document.hidden && state.view === 'view-scan') startCamera();
    });
  }

  // ---------- Light / dark mode ----------
  // Follows the phone's setting until the button is used; the choice is then remembered on this phone.
  const darkQuery = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  function currentTheme() {
    const t = document.documentElement.dataset.theme;
    return t === 'light' || t === 'dark' ? t : (darkQuery && darkQuery.matches ? 'dark' : 'light');
  }
  function renderThemeButton() {
    const dark = currentTheme() === 'dark';
    const btn = $('themeBtn');
    btn.classList.toggle('is-dark', dark);
    btn.setAttribute('aria-label', dark ? 'Switch to light mode' : 'Switch to dark mode');
    const meta = document.querySelector('meta[name=theme-color]');
    if (meta) meta.setAttribute('content', dark ? '#1F1F1F' : '#FFFFFF');
  }
  function toggleTheme() {
    const next = currentTheme() === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    store.set('pt_theme', next);
    renderThemeButton();
  }

  function registerServiceWorker() {
    if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
  }

  // Exposed for automated tests
  window.PTApp = { state, feedback, handleCode, openSearch, searchParts, openReview, sendReview, startMode, syncQueue, loadSite, openAdmin, showAdminTab, showSiteDetail, admin, openVan, vanShortfall, orderLines, orderParts, smartsheetUrl, chooseSite };

  init();
})();
