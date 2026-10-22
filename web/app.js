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
    COUNT: { title: 'Stock count', hint: 'Scan every part here. Use + when there is more than one.', engineer: true, done: 'Count saved' },
    TO_VAN: { title: 'Take to my van', hint: 'Scan each unused part you are taking with you.', engineer: true, done: 'Taken to your van' },
    FROM_VAN: { title: 'Book in from my van', engineer: true, done: 'Left at the site' }   // Book in, "From my van"
  };
  const TYPE_LABEL = { BOOK_IN: 'Booked in', USED: 'Used', CUSTOMER_FITTED: 'Customer fitted', COUNT: 'Count', MOVED_IN: 'Moved in with a machine', MOVED_OUT: 'Moved out with a machine', CARRIED_FORWARD: 'Carried forward (older history archived)', KIT_ADJUST: 'Assumed kit corrected', TO_VAN: 'Taken to a van', FROM_SITE: 'From a site', RETURNED: 'Returned to Ceva', FROM_VAN: 'From a van', TO_SITE: 'Left at a site', POSTED: 'Transferred to a site', WRONG_CODE: 'Wrong part code corrected' };
  // Each action has its own brand colour (see the tone-* classes in app.css)
  const TONES = { BOOK_IN: 'green', USED: 'pink', CUSTOMER_FITTED: 'purple', COUNT: 'blue', TO_VAN: 'orange', FROM_SITE: 'orange', RETURNED: 'orange', FROM_VAN: 'green', TO_SITE: 'orange', POSTED: 'orange' };
  const PILL = { BOOK_IN: 'Book in', USED: 'Used on a job', CUSTOMER_FITTED: 'Fitted by site', COUNT: 'Stock count', TO_VAN: 'Take to my van', RETURNED: 'Return to Ceva', POSTED: 'Transfer', FROM_VAN: 'Book in' };
  // Parts that leave only if they are on record where they are (as the server does it)
  const HELD_ONLY = ['TO_VAN', 'RETURNED', 'POSTED', 'FROM_VAN'];
  // Records that change a site and a van at once
  const TWO_SIDED = ['TO_VAN', 'FROM_VAN'];
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
  /** The kit part a part counts as (the Parts tab's Counts as), or the part itself. */
  const asKit = family => (state.parts.get(family) || {}).countsAs || family;

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
    try { if (navigator.vibrate) navigator.vibrate(kind === 'good' ? 90 : kind === 'extra' ? [220, 90, 220] : [70, 60, 70]); } catch (e) {}
    try {
      if (!audioCtx) return;
      if (kind === 'good') tone(1500, 0, 0.12);
      else if (kind === 'extra') { tone(330, 0, 0.22); tone(330, 0.3, 0.22); }
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
    (list || []).forEach(([family, name, codes, countsAs]) => state.parts.set(family, { family, name, codes: String(codes || ''), countsAs: countsAs || '' }));
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
    $('findPart').hidden = !isEngineer();
    document.querySelectorAll('.action[data-engineer]').forEach(b => { b.hidden = !isEngineer(); });
    $('viewStockBtn').classList.toggle('full', !isEngineer());   // customers see three tiles: no gap next to View stock
    const need = isEngineer() && recountNeed(d);
    $('recountCard').hidden = !need;
    if (need) {
      $('recountCard').className = 'recount-card tone-' + need.tone;
      $('recountTitle').textContent = need.title;
      $('recountWhy').textContent = need.why;
    }
    const parts = (d.stock || []).filter(s => s.qty > 0);
    const total = parts.reduce((n, s) => n + s.qty, 0);
    $('stockSummary').textContent = parts.length ? total + ' items, ' + parts.length + ' different parts' : 'Nothing recorded yet';
    const coming = d.onItsWay || [];
    $('onItsWayCard').hidden = !coming.length;
    const ow = $('onItsWayList'); ow.textContent = '';
    coming.forEach(w => ow.append(el('li', {},
      el('div', { class: 'item-main' },
        el('div', { class: 'item-name' }, w.name || partName(w.family) || w.family),
        el('div', { class: 'item-sub' }, ['sent by ' + w.by, w.jobNo ? 'call ' + w.jobNo : '', when(w.at)].filter(Boolean).join(' · '))),
      el('div', { class: 'qty' }, '×' + w.qty))));
    renderRecent($('recentList'), d.recent);
    renderBanner();
  }

  /**
   * Whether this site needs a stock count: stock below zero (the figures are wrong), never counted
   * (stock is assumed until someone counts it), or the last count was RecountDays or more ago.
   */
  function recountNeed(d) {
    const below = (d.stock || []).filter(s => s.qty < 0).length;
    if (below) return { tone: 'pink', title: 'Stock count needed', why: 'Stock went below zero for ' + below + (below === 1 ? ' part' : ' parts') + ' here, so the figures are wrong.' };
    if (!d.site.lastCount) {
      return { tone: 'blue', title: 'Never counted', why: (d.stock || []).some(s => s.qty > 0)
        ? 'The stock on record here is assumed until someone counts it.' : 'Count it once, even if nothing is here.' };
    }
    const days = Math.floor((Date.now() - Date.parse(d.site.lastCount)) / 86400000);
    if (days >= (d.recountDays || 90)) return { tone: 'blue', title: 'Recount due', why: 'Last counted ' + days + ' days ago.' };
    return null;
  }

  function renderRecent(rl, recent) {
    rl.textContent = '';
    if (!(recent || []).length) rl.append(el('li', { class: 'muted' }, 'No activity yet.'));
    (recent || []).forEach(r => rl.append(el('li', {},
      activityIcon(r),
      el('div', { class: 'item-main' },
        el('div', { class: 'item-name' }, r.name || r.family),
        el('div', { class: 'item-sub' }, [r.place || TYPE_LABEL[r.type] || r.type, r.failed ? 'failed on fit' : '', r.by, r.jobNo ? 'job ' + r.jobNo : '', r.pending ? 'waiting to send' : when(r.at)].filter(Boolean).join(' · '))),
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
    await route(params);
    syncQueue();
  }

  /** Where the app opens: ?admin, ?van (link or home-screen shortcut), a site's QR code, or the last site used. */
  async function route(params) {
    const fromQr = params.get('s');
    if (params.has('admin')) return openAdmin();
    state.site = fromQr || store.get('pt_site', null);
    if (params.has('van') && !fromQr) {
      // Straight to My van; the last site still loads behind it so the Site tab works as usual
      if (!isEngineer()) show('view-nosite');   // under the PIN pad, in case they cancel
      openVan();
      if (state.site) await loadSite();
      return;
    }
    if (!state.site) { if (isEngineer()) openVan(); else show('view-nosite'); return; }
    await loadSite();
  }

  // Views that give way to the site's home page once it has loaded
  const WAITING_VIEWS = [null, 'view-nosite', 'view-loading'];
  async function loadSite() {
    const cached = store.get('pt_boot_' + state.site, null);
    if (cached && !state.data) {
      state.data = cached;
      renderHome();
      if (WAITING_VIEWS.includes(state.view)) show('view-home');
    }
    if (!state.data && WAITING_VIEWS.includes(state.view)) show('view-loading');
    $('siteUpdating').hidden = !state.data;   // a saved copy is showing: say it is being brought up to date
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
      state.queue.filter(q => q.site === state.site).forEach(q => applyLocally(q, 'site'));
      store.set('pt_boot_' + state.site, state.data);
      renderUserChip();
      renderHome();
      if (WAITING_VIEWS.includes(state.view)) show('view-home');
    } catch (e) {
      state.offline = e.code === 'offline';
      if (!state.data) {
        show('view-nosite');
        $('view-nosite').querySelector('h1').textContent = state.offline ? 'No connection' : 'Could not load this site';
        $('view-nosite').querySelector('p').textContent = state.offline ? 'Connect to the internet once to load this site. After that it works offline.' : e.message;
      }
      renderBanner();
    }
    finally { $('siteUpdating').hidden = true; }
  }

  // ---------- Sign in ----------
  function signOut(quiet) {
    state.session = null; state.user = null;
    store.del('pt_session'); store.del('pt_user'); store.del('pt_admin'); store.del('pt_where');
    state.van = null; store.del('pt_van');   // the next engineer must not see this one's van
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
        if (state.van && !(state.van.user && state.van.user.name === r.user.name)) { state.van = null; store.del('pt_van'); }   // another engineer's van
        state.session = r.session; state.user = r.user;
        store.set('pt_session', r.session); store.set('pt_user', r.user);
        closeSheet(); renderUserChip(); renderHome(); renderWhereSwitch(state.view);
        toast('Signed in as ' + r.user.name);
        state.queue.forEach(q => { if (q.error && /sign in/i.test(q.error)) q.error = ''; });
        saveQueue(); syncQueue();
        if (state.site) loadSite();   // engineers also get the site's Up Time Kit (kit warnings, where a used part came from)
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
  // Phone keyboards cover the page without shrinking it, so keep the sheet sitting just above the keyboard
  // (--kb) and no taller than the space left (--vvh); otherwise search results end up hidden behind it.
  function fitToKeyboard() {
    const vv = window.visualViewport; if (!vv) return;
    const root = document.documentElement.style;
    const kb = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop));
    // With the keyboard open, leave a gap above it so the last button is never clipped by its edge
    const gap = kb > 0 ? 32 : 0;
    root.setProperty('--kb', (kb + gap) + 'px');
    root.setProperty('--vvh', Math.round(vv.height - gap) + 'px');
  }
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', fitToKeyboard);
    window.visualViewport.addEventListener('scroll', fitToKeyboard);
  }
  let sheetOnClose = null;
  function openSheet(title, content, onClose) {
    $('sheetTitle').textContent = title;
    const body = $('sheetBody'); body.textContent = '';
    [].concat(content).flat().forEach(c => { if (c != null && c !== '') body.append(c); });
    hideToast();
    $('sheet').classList.remove('hidden');
    $('sheetBackdrop').classList.remove('hidden');
    sheetOnClose = onClose || null;
    fitToKeyboard();
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
    if ((MODES[mode] || {}).engineer && !isEngineer()) {
      askPin(() => startMode(mode), 'Engineers only: sign in');
      return;
    }
    prepareMode(mode);
    show('view-scan');
    startCamera();
  }
  function prepareMode(mode) {
    state.mode = mode;
    state.basket = [];
    const words = state.where === 'van' ? VAN_MODES[mode] : MODES[mode];
    $('scanTitle').textContent = mode === 'POSTED' ? 'Transfer to ' + state.postTo.name : words.title;
    setPill('scanPill', mode);
    $('view-scan').className = 'view tone-' + TONES[mode];
    $('scanHint').textContent = words.hint;
    $('basketTitle').textContent = mode === 'COUNT' ? 'Counted' : 'Scanned';
    renderBasket();
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
      addToBasket(n, part.name, false);
      const x = extraInfo(n.family);
      if (x && x.over) { feedback('extra'); flashExtra(); }
      else feedback('good');
      toast((x && x.extra ? 'Extra, take back: ' : x && x.over ? 'Over the kit: ' : 'Added: ') + part.name, { label: 'Undo', fn: () => changeQty(n.family, -1) });
      setTimeout(resumeScan, 600);
    } else {
      feedback('attention');
      confirmNewPart(n, source);
    }
  }

  function confirmNewPart(n, source) {
    const name = el('input', { class: 'input', placeholder: 'Part name from the box', maxlength: '120', autocomplete: 'off' });
    const err = el('div', { class: 'error', hidden: true }, 'Enter the part name from the box.');
    // A barcode read one character wrong looks like a new part: offer the known parts it nearly matches
    const near = C.oneOff(n.family, state.parts.keys()).map(f => state.parts.get(f));
    openSheet('Not in the parts list', [
      el('p', { class: 'muted' }, source === 'text' ? 'Read from the label text. Check every character against the box:' : 'Check every character against the box:'),
      el('div', { class: 'big-code' }, n.exact),
      n.warning ? el('div', { class: 'warn' }, 'This does not look like a normal part code. Only add it if it matches the box exactly.') : null,
      near.length ? el('div', { class: 'near-parts' }, el('p', { class: 'muted' }, 'Did you mean:'),
        near.map(p => el('button', { class: 'pick', onclick: () => { closeSheet(); handleCode(p.family, source); } },
          el('span', {}, el('span', { class: 'item-name' }, p.name), el('span', { class: 'item-sub mono' }, p.family))))) : null,
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

  /** The part just scanned goes to the top of the list (a repeat moves up too), so its + button is at hand. */
  function addToBasket(n, name, isNew) {
    const existing = state.basket.find(b => b.family === n.family);
    if (existing) existing.qty++;
    state.basket = [existing || { family: n.family, exact: n.exact, name, qty: 1, isNew, odd: !!n.warning }]
      .concat(state.basket.filter(b => b !== existing));
    renderBasket();
  }
  function changeQty(family, delta) {
    const b = state.basket.find(x => x.family === family);
    if (!b) return;
    b.qty += delta;
    if (b.qty <= 0) state.basket = state.basket.filter(x => x !== b);
    renderBasket();
  }
  /**
   * While counting at a site (engineers): is this part extra? A kit part above the site's kit, or a part not in the
   * kit with no delivery or use here for SurplusDays (the Surplus list's rules). A recent non-kit part is probably
   * waiting for a job: noted, not extra. Returns { extra, text } or null.
   */
  function extraInfo(family) {
    if (state.mode !== 'COUNT' || state.where !== 'site') return null;
    const qtyOf = f => (state.basket.find(x => x.family === f) || {}).qty || 0;
    return surplusFor(family, qtyOf(family), qtyOf);
  }
  /**
   * The same check for n of a part at this site (a count, or the stock on record); qtyOf gives the other parts' numbers
   * there. Parts that count as the same kit part share the kit, the kit's own code first. Engineers only (they get
   * lastSeen). Returns { extra, over (the kit part is over its kit: flash), text } or null.
   */
  function surplusFor(family, n, qtyOf) {
    if (!state.data || !state.data.lastSeen || n <= 0) return null;
    const kitCode = asKit(family), kit = (state.data.kit || {})[kitCode] || 0;
    if (kit > 0) {
      const group = [kitCode].concat([...state.parts.values()].filter(p => p.countsAs === kitCode).map(p => p.family).sort());
      if (!group.includes(family)) group.push(family);
      let left = kit, total = 0, extra = 0;
      group.forEach(f => {
        const q = f === family ? n : Math.max(0, qtyOf(f) || 0), keep = Math.min(q, left);
        left -= keep; total += q;
        if (f === family) extra = q - keep;
      });
      const as = kitCode !== family ? ', counts as ' + kitCode : '';
      if (extra > 0) return { extra, over: true, text: extra + ' extra: take back (kit ' + kit + as + ')' };
      return as || total > kit ? { extra: 0, over: total > kit, text: as ? 'Counts as kit part ' + kitCode + ' (kit ' + kit + ')' : '' } : null;
    }
    const days = state.data.surplusDays || 60, seen = state.data.lastSeen[family];
    const idle = seen ? Math.max(0, Math.floor((Date.now() - new Date(seen)) / 86400000)) : null;
    if (idle !== null && idle < days) {
      return { extra: 0, over: false, text: 'Not kit · delivered or used here ' + (idle ? idle + (idle === 1 ? ' day' : ' days') + ' ago' : 'today') + ': probably for a job' };
    }
    return { extra: n, over: true, text: 'Not kit: take back' + (idle === null ? ' (nothing on record here)' : ' (nothing here for ' + idle + ' days)') };
  }
  function extraNote(family, x) {
    if (x === undefined) x = extraInfo(family);
    return x && x.text ? el('div', { class: 'extra-note' + (x.extra ? ' take' : '') }, x.text) : null;
  }
  function flashExtra() {
    const v = $('view-scan');
    v.classList.remove('flash-extra'); void v.offsetWidth; v.classList.add('flash-extra');
    setTimeout(() => v.classList.remove('flash-extra'), 900);
  }

  function renderBasket() {
    const list = $('basketList'); list.textContent = '';
    state.basket.forEach(b => list.append(el('li', { class: (extraInfo(b.family) || {}).extra ? 'is-extra' : '' },
      el('div', { class: 'item-main' },
        el('div', { class: 'item-name' }, b.name, b.isNew ? el('span', { class: 'tag' }, 'new part') : null),
        el('div', { class: 'item-sub mono' }, b.family), extraNote(b.family)),
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
    $('reviewTitle').textContent = mode === 'POSTED' ? 'Transfer to ' + state.postTo.name : (state.where === 'van' ? VAN_MODES[mode] : MODES[mode]).title;
    setPill('reviewPill', mode);
    // Engineers booking in at a site: a delivery, or parts from their own van
    $('sourceCard').hidden = !(mode === 'BOOK_IN' && state.where === 'site' && isEngineer());
    document.querySelector('input[name=source][value=delivery]').checked = true;
    const stock = {};
    (cur() && cur().stock || []).forEach(s => { stock[s.family] = s.qty; });
    const list = $('reviewList'); list.textContent = '';
    if (!state.basket.length) list.append(el('li', { class: 'muted' }, 'Nothing scanned.' + (mode === 'COUNT' ? ' Send to record that nothing is here.' : '')));
    state.basket.forEach(b => {
      const li = el('li', {},
        el('div', { class: 'item-main' },
          el('div', { class: 'item-name' }, b.name, b.isNew ? el('span', { class: 'tag' }, 'new part') : null),
          el('div', { class: 'item-sub mono' }, b.family + (mode === 'COUNT' ? ' · on record: ' + (stock[b.family] || 0) : '')), extraNote(b.family)),
        el('div', { class: 'qty' }, b.qty));
      if (mode === 'USED') {
        // Still recorded as used (a kit site gets it reordered), but marked for the warranty claim
        const tick = el('input', { type: 'checkbox', checked: !!b.failed, onchange: () => { b.failed = tick.checked ? 1 : 0; } });
        li.classList.add('with-tick');
        li.append(el('label', { class: 'fail-tick' }, tick, (b.qty > 1 ? 'One of these failed on fit' : 'Failed on fit') + ' (keeping it for warranty)'));
        // Where it came from, for closing the call in SAP: a guess the engineer can change
        if (!b.source) b.source = guessSource(b.family);
        const pick = el('select', { class: 'source-pick', 'aria-label': 'Where ' + b.name + ' came from', onchange: () => { b.source = pick.value; } },
          SOURCES.map(x => el('option', { value: x, selected: x === b.source }, x)));
        li.append(el('label', { class: 'source-line' }, 'From', pick));
      }
      list.append(li);
    });
    reviewWarnings(sendType(), stock);
    const zl = $('zeroList'); zl.textContent = '';
    // Parts on record that weren't scanned, including any below zero (a count is how those get put right)
    const missing = mode === 'COUNT' ? Object.keys(stock).filter(f => stock[f] !== 0 && !state.basket.some(b => b.family === f)) : [];
    missing.forEach(f => zl.append(el('li', {},
      el('input', { type: 'checkbox', checked: true, value: f, id: 'z-' + f, 'aria-label': 'Set ' + f + ' to 0' }),
      el('label', { class: 'item-main', for: 'z-' + f },
        el('div', { class: 'item-name' }, partName(f) || 'Unknown part'),
        el('div', { class: 'item-sub mono' }, f + ' · on record: ' + stock[f])))));
    $('zeroCard').hidden = !missing.length;
    // Used needs a job number; parts taken to the van or returned to Ceva can have the breakdown call number
    $('jobCard').hidden = mode !== 'USED' && !HELD_ONLY.includes(mode);
    $('jobLabel').textContent = mode === 'USED' ? 'Job or ticket number' : 'Call or job number (optional)';
    $('reviewError').hidden = true;
    $('reviewSend').disabled = false;
    show('view-review');
  }

  const SOURCES = ['Uptime Kit', 'Van Kit', 'Ordered for job'];
  /** Van: Van Kit if it's on the van kit (or there is none yet). Site: Uptime Kit if it's in the site's kit. Otherwise Ordered for job. */
  function guessSource(family) {
    if (state.where === 'van') {
      const kit = state.van && state.van.kit || [];
      return !kit.length || kit.some(k => k.family === family) ? 'Van Kit' : 'Ordered for job';
    }
    return (state.data && state.data.kit || {})[family] ? 'Uptime Kit' : 'Ordered for job';
  }
  /** Parts used, one line each, in the style the call is closed with in SAP: "1X - P053K0668X - Suction Filter - Uptime Kit". */
  function sapText(lines) {
    return lines.map(l => l.qty + 'X - ' + l.family + ' - ' + (l.name || 'Unknown part') + ' - ' + l.source).join('\n');
  }
  /** Copies text to the clipboard; if the browser won't, shows it selected so it can be copied by hand. */
  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      toast('Copied. Paste it into SAP.');
    } catch (e) {
      const box = el('textarea', { class: 'input sap-text', readonly: true, rows: Math.min(12, text.split('\n').length + 1) });
      box.value = text;
      openSheet('Copy for SAP', [el('p', { class: 'muted' }, 'Copying is blocked here: press and hold the text, Select all, then Copy.'), box,
        el('div', { class: 'buttons' }, el('button', { onclick: closeSheet }, 'Close'))]);
      setTimeout(() => { box.focus(); box.select(); }, 50);
    }
  }

  /** My jobs: the engineer's parts used on jobs in the last month, by job number, each with Copy for SAP. */
  async function openJobs() {
    const status = el('p', { class: 'muted' }, 'Loading your jobs…');
    const list = el('div', { class: 'job-list' });
    openSheet('My jobs', [status, list, el('div', { class: 'buttons' }, el('button', { onclick: closeSheet }, 'Close'))]);
    let r;
    try {
      r = await api({ action: 'myJobs', session: state.session });
      if (!r.ok) throw Object.assign(new Error(r.error), { code: r.code });
    } catch (e) {
      status.textContent = e.code === 'offline' ? 'No connection. My jobs needs signal.' : e.message;
      return;
    }
    status.textContent = r.jobs.length ? 'Parts you used on jobs in the last ' + r.days + ' days, newest first.' : 'No parts used on a job in the last ' + r.days + ' days.';
    r.jobs.forEach(j => {
      const text = sapText(j.lines);
      list.append(el('div', { class: 'card job' },
        el('div', { class: 'item-name' }, j.jobNo ? 'Job ' + j.jobNo : 'No job number'),
        el('div', { class: 'item-sub' }, j.places.concat(when(j.at)).join(' · ')),
        el('pre', { class: 'order-text' }, text),
        el('button', { class: 'btn primary', onclick: () => copyText(text) }, 'Copy for SAP')));
    });
  }

  /**
   * Before sending parts to the van or back to Ceva: which ones are not on record where they are leaving from
   * (nothing is taken off for those), and which would leave the site's Up Time Kit short.
   */
  function reviewWarnings(mode, stock) {
    const box = $('reviewWarn'); box.textContent = '';
    const notHeld = [], kitShort = [];
    if (mode === 'FROM_VAN') {   // the parts leave the van, not the site
      stock = {};
      (state.van && state.van.stock || []).forEach(s => { stock[s.family] = s.qty; });
    }
    if (HELD_ONLY.includes(mode) && cur() && (mode !== 'FROM_VAN' || state.van)) {
      const kit = mode === 'TO_VAN' && state.data.kit || {};
      state.basket.forEach(b => {
        const held = Math.max(0, stock[b.family] || 0), left = held - Math.min(held, b.qty);
        if (held < b.qty) notHeld.push(b.name + (held ? ' (only ' + held + ' on record)' : ''));
        if (kit[b.family] && left < held && left < kit[b.family]) kitShort.push(b.name + ' (kit ' + kit[b.family] + ', would leave ' + left + ')');
      });
    }
    if (notHeld.length) box.append(el('p', {}, {
      TO_VAN: 'Not on record at this site. They still go into your van, and the site\'s stock is not changed:',
      RETURNED: 'Not in your van stock, so nothing is taken off for:',
      POSTED: 'Not in your van stock. They are still sent, and your van\'s stock is not changed:',
      FROM_VAN: 'Not in your van stock. They still go on the site, and your van\'s stock is not changed:'
    }[mode]), el('ul', {}, notHeld.map(t => el('li', {}, t))));
    if (kitShort.length) box.append(el('p', {}, 'This leaves the site\'s Up Time Kit short:'), el('ul', {}, kitShort.map(t => el('li', {}, t))),
      el('p', {}, 'If a part came for a breakdown and was never booked in here, go back and book it in first, then take it.'));
    box.hidden = !box.children.length;
  }

  /** What the review will record: Book in "From my van" is a FROM_VAN. */
  function sendType() {
    const fromVan = state.mode === 'BOOK_IN' && !$('sourceCard').hidden && document.querySelector('input[name=source]:checked').value === 'van';
    return fromVan ? 'FROM_VAN' : state.mode;
  }

  async function sendReview() {
    const mode = sendType();
    const jobNo = $('jobNo').value.trim();
    const err = $('reviewError');
    if (mode === 'USED' && !jobNo) { err.textContent = 'Enter the job or ticket number.'; err.hidden = false; return; }
    const zero = Array.from($('zeroList').querySelectorAll('input:checked')).map(i => i.value);
    // A count that found nothing, where nothing is on record, still records that the site was counted
    const emptyCount = mode === 'COUNT' && !$('zeroList').children.length;
    if (!state.basket.length && !zero.length && !emptyCount) { err.textContent = 'Nothing to send.'; err.hidden = false; return; }
    $('reviewSend').disabled = true;
    const batch = {
      batchId: uuid(), van: state.where === 'van' || undefined, site: state.where === 'van' ? null : state.site,
      siteName: state.where === 'van' ? 'your van' : (state.data ? state.data.site.name : ''), type: mode, jobNo,
      note: $('note').value.trim(), device: deviceLabel(), createdAt: new Date().toISOString(),
      by: state.user ? state.user.name : 'Customer',
      items: state.basket.map(b => ({ code: b.exact || b.family, qty: b.qty, name: b.isNew ? b.name : undefined, failed: mode === 'USED' && b.failed ? b.failed : undefined, source: mode === 'USED' ? b.source : undefined })),
      zero, count: state.basket.reduce((s, b) => s + b.qty, 0)
    };
    if (mode === 'POSTED') { batch.toSite = state.postTo.token; batch.toSiteName = state.postTo.name; }
    // Saved on the phone first, shown as done straight away, then sent in the background
    // (the server takes a few seconds, and the phone may have no signal)
    if (batch.van && mode === 'BOOK_IN') clearOrdered(state.basket.map(b => b.family));
    state.doneSap = mode === 'USED' ? sapText(state.basket) : '';
    state.doneExtras = state.basket.map(b => Object.assign({}, b, { qty: (extraInfo(b.family) || {}).extra || 0, failed: 0 })).filter(b => b.qty > 0);
    state.queue.push(batch);
    saveQueue();
    applyLocally(batch);
    $('jobNo').value = ''; $('note').value = '';
    state.basket = [];
    showDone(batch);
    sendBatch(batch).then(result => showSendResult(batch, result));
  }

  /**
   * Updates stock and recent activity on the phone before the server confirms. A take-to-van batch changes
   * the site and the van; `side` ('site' or 'van') applies just one of them.
   */
  function applyLocally(batch, side) {
    const site = state.data && batch.site === state.site ? state.data : null;
    const sides = TWO_SIDED.includes(batch.type) ? [['site', site], ['van', state.van]] : [batch.van ? ['van', state.van] : ['site', site]];
    sides.forEach(([where, target]) => { if (target && (!side || side === where)) applyTo(target, batch, where); });
  }
  /** How a record changes one place: [sign (0 = a count sets it), only what is on record leaves, type shown, where it went]. */
  function effect(batch, where) {
    const t = batch.type;
    if (t === 'TO_VAN') return where === 'van' ? [1, false, 'FROM_SITE', 'From ' + batch.siteName] : [-1, true, t];
    if (t === 'FROM_VAN') return where === 'van' ? [-1, true, 'TO_SITE', 'To ' + batch.siteName] : [1, false, t];
    if (t === 'POSTED') return [-1, true, t, 'Transferred to ' + batch.toSiteName];
    return [{ BOOK_IN: 1, USED: -1, CUSTOMER_FITTED: -1, RETURNED: -1 }[t] || 0, t === 'RETURNED', t];
  }
  function applyTo(target, batch, where) {
    const stock = {};
    (target.stock || []).forEach(s => { stock[s.family] = Object.assign({}, s); });
    const [sign, heldOnly, type, place] = effect(batch, where);
    const recent = [];
    const add = (family, name, qty, failed) => {
      if (!stock[family]) stock[family] = { family, name: name || partName(family), qty: 0 };
      const was = stock[family].qty;
      if (heldOnly) qty = Math.min(qty, Math.max(0, was));   // only what is on record leaves
      stock[family].qty = sign ? was + sign * qty : qty;
      const delta = stock[family].qty - was;
      if (delta) recent.push({ at: batch.createdAt, family, name: stock[family].name, qty: delta, type, by: batch.by, jobNo: batch.jobNo,
        place, failed: failed ? true : undefined, pending: true });
    };
    batch.items.forEach(it => add(C.normalise(it.code).family, it.name, it.qty, it.failed));
    if (batch.type === 'COUNT') (batch.zero || []).forEach(f => { if (!batch.items.some(it => C.normalise(it.code).family === f)) add(f, '', 0); });
    target.stock = Object.values(stock).filter(s => s.qty !== 0).sort((a, b) => (a.name || a.family).localeCompare(b.name || b.family));
    target.recent = recent.concat(target.recent || []).slice(0, 10);
    if (batch.type === 'COUNT' && !batch.van && target.site) target.site.lastCount = batch.createdAt;
    if (where === 'van') { store.set('pt_van', state.van); renderVan(); }
    else { store.set('pt_boot_' + state.site, state.data); renderHome(); }
  }

  function showDone(batch) {
    state.doneBatch = batch.batchId;
    $('doneTitle').textContent = (batch.van && VAN_MODES[batch.type].done) || MODES[batch.type].done;
    const parts = batch.count + (batch.count === 1 ? ' part' : ' parts');
    $('doneText').textContent = batch.type === 'COUNT' ? 'Stock updated for ' + batch.siteName + '.'
      : batch.type === 'TO_VAN' ? parts + ' taken from ' + batch.siteName + ' into your van.'
      : batch.type === 'RETURNED' ? parts + ' sent back to Ceva from your van.'
      : batch.type === 'FROM_VAN' ? parts + ' moved from your van to ' + batch.siteName + '.'
      : batch.type === 'POSTED' ? parts + ' transferred to ' + batch.toSiteName + '. They show there as on their way until booked in.'
      : parts + ' recorded at ' + batch.siteName + '.';
    $('doneHome').textContent = batch.van ? 'Back to my van' : 'Back to site';
    $('doneCopy').hidden = batch.type !== 'USED' || !state.doneSap;
    const extras = batch.type === 'COUNT' && state.doneExtras || [], nExtra = extras.reduce((n, b) => n + b.qty, 0);
    $('doneExtras').hidden = !nExtra;
    $('doneExtras').textContent = 'Take the ' + (nExtra === 1 ? 'extra part' : nExtra + ' extra parts') + ' to my van';
    $('doneStatus').textContent = 'Sending…';
    $('doneStatus').className = 'send-status';
    $('doneWarn').hidden = true;
    show('view-done');
  }

  /** The extras a count found go straight to the Take to my van review (the count is sent first). */
  function takeExtras() {
    const extras = state.doneExtras || [];
    if (!extras.length || !state.data) return;
    state.where = 'site';
    prepareMode('TO_VAN');
    state.basket = extras;
    state.doneExtras = [];
    renderBasket();
    openReview();
  }

  function belowZeroText(families) {
    return 'Stock went below zero for: ' + families.map(f => partName(f) || f).join(', ') + (state.where === 'van' ? '. Your van probably needs a stock count.' : '. This site probably needs a stock count.');
  }

  /** Shows how the background send went: on the done screen if it is still open, otherwise as a message. */
  function showSendResult(batch, result) {
    const onScreen = state.view === 'view-done' && state.doneBatch === batch.batchId;
    if (result.busy) return;
    // Parts sent back to Ceva that were not in the van's stock had nothing taken off
    const warning = result.ok && [result.belowZero.length ? belowZeroText(result.belowZero) : '',
      batch.type === 'RETURNED' && result.notHeld.length ? 'Not in your van stock, so nothing was taken off for: ' + result.notHeld.map(f => partName(f) || f).join(', ') + '.' : ''].filter(Boolean).join(' ');
    if (!onScreen) {
      if (warning) toast(warning);
      return;
    }
    const status = $('doneStatus');
    if (result.ok) {
      status.textContent = 'Saved';
      status.className = 'send-status ok';
      if (warning) { $('doneWarn').textContent = warning; $('doneWarn').hidden = false; }
    } else if (result.queued) {
      status.textContent = 'No signal. Saved on this phone; it will send automatically.';
      status.className = 'send-status wait';
    } else {
      status.textContent = 'Not sent: ' + result.error;
      status.className = 'send-status bad';
    }
  }

  function saveQueue() { store.set('pt_queue', state.queue); renderBanner(); mirrorOutbox(); }

  /**
   * Copies the records waiting to send to the outbox the service worker can read, and asks Chrome (Android)
   * to send them in the background when signal returns, even if the app is closed. Records that need the
   * engineer (sign in, an error) stay with the app.
   */
  let outboxWrite = Promise.resolve();
  function mirrorOutbox() {
    if (!window.PTOutbox || !window.indexedDB) return;
    const waiting = state.queue.filter(q => !q.error).map(b => Object.assign({ action: 'submit', session: state.session }, b));
    outboxWrite = outboxWrite.then(() => PTOutbox.save(CFG.apiUrl, waiting)).catch(() => {});
    if (waiting.length && 'serviceWorker' in navigator && navigator.serviceWorker.controller) {
      navigator.serviceWorker.ready.then(reg => reg.sync && reg.sync.register(PTOutbox.TAG)).catch(() => {});
    }
  }

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
        if (r.vanStock && state.van) { state.van.stock = r.vanStock; store.set('pt_van', state.van); loadVan(); }
        saveQueue();
        return { ok: true, belowZero: r.belowZero || [], notHeld: r.notHeld || [] };
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
    COUNT: { title: 'Van stock count', hint: 'Scan everything in the van. Use + when there is more than one.' },
    RETURNED: { title: 'Return to Ceva', hint: 'Scan each unused part as you drop it at the ByBox.', done: 'Returned to Ceva' },
    POSTED: { title: 'Transfer to a site', hint: 'Scan each part you are sending.', done: 'Transferred' }
  };
  const cur = () => (state.where === 'van' ? state.van : state.data);

  async function openVan() {
    if (!isEngineer()) { askPin(openVan, 'Engineer sign in'); return; }
    state.where = 'van';
    if (state.van) renderVan();
    else { $('vanName').textContent = state.user ? state.user.name : ''; $('vanSummary').textContent = 'Loading your van…'; $('vanKitStatus').textContent = ''; $('vanKitList').textContent = ''; $('vanRecentList').textContent = ''; $('vanKitActions').hidden = true; }
    show('view-van');
    await loadVan();
  }

  async function loadVan() {
    $('vanUpdating').hidden = !state.van;
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
      state.queue.filter(q => q.van || TWO_SIDED.includes(q.type)).forEach(q => applyLocally(q, 'van'));
      store.set('pt_van', state.van);
      renderVan();
    } catch (e) {
      state.offline = e.code === 'offline';
      if (!state.van) toast(state.offline ? 'No connection. Your van loads once you have signal.' : e.message);
      renderBanner();
    } finally { $('vanUpdating').hidden = true; }
  }

  /**
   * Van kit parts to reorder, using the old Van Kit Manager's rule: a part with a minimum above 0 is short when
   * stock is at or below that minimum, and the order tops it back up to maximum (at least 1).
   * Parts already ordered (and not yet booked in) are flagged so they are not ordered twice.
   */
  function vanShortfall() {
    const have = {};
    (state.van && state.van.stock || []).forEach(s => { const f = asKit(s.family); have[f] = (have[f] || 0) + s.qty; });
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

  // ---------- Easter egg: "Do not press" at the bottom of My van ----------
  // Every letter and number falls off the screen, the cards swing off their hinges, a message, then it is all put
  // back exactly as it was (only text nodes are wrapped and unwrapped, so nothing else on the page is touched).
  const EGG_LINES = [
    ['Well… you were told.', 'Putting everything back…'],
    ['Again? Really?', 'The parts are fine. Your pride may not be.'],
    ['This is a parts tracker, not a toy.', 'Fine. One more go.'],
    ['OK, that one was quite good.', 'Back to work now.']
  ];
  let eggPresses = 0;
  function doNotPress() {
    if (document.body.classList.contains('falling')) return;
    const line = EGG_LINES[Math.min(eggPresses, EGG_LINES.length - 1)];
    eggPresses++;
    try { if (navigator.vibrate) navigator.vibrate([60, 40, 60, 40, 200]); } catch (e) {}
    const done = () => { $('doNotPress').textContent = eggPresses === 1 ? 'I said do NOT press' : 'Do not press. Seriously.'; };
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      $('doNotPress').classList.add('egg-shake');
      setTimeout(() => $('doNotPress').classList.remove('egg-shake'), 600);
      toast(line[0]); done(); return;
    }
    const speed = window.PT_EGG_SPEED || 1;   // tests run it faster
    const ms = n => Math.round(n * speed);
    const roots = [document.querySelector('.topbar'), $('banner'), $('whereSwitch'), $('view-van')].filter(Boolean);
    const rand = (a, b) => a + Math.random() * (b - a);
    // 1. Wrap every visible letter in its own span, words kept whole so nothing reflows
    const wrapped = [];
    roots.forEach(root => {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode: n => n.nodeValue.trim() && !n.parentElement.closest('svg, script, style, [hidden]') ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT
      });
      const nodes = [];
      while (walker.nextNode()) nodes.push(walker.currentNode);
      nodes.forEach(node => {
        const holder = document.createElement('span');
        node.nodeValue.split(/(\s+)/).forEach(part => {
          if (!part) return;
          if (/^\s+$/.test(part)) { holder.append(part); return; }
          const word = el('span', { class: 'fall-word' });
          [...part].forEach(ch => word.append(el('span', { class: 'fall-char' }, ch)));
          holder.append(word);
        });
        node.replaceWith(holder);
        wrapped.push([holder, node]);
      });
    });
    // Everything falls exactly far enough to leave the bottom of the screen, wherever it starts: the page is
    // often scrolled to the bottom, so things above the screen fall down through it and out
    const vh = window.innerHeight;
    const fallTime = (base, dist) => base * Math.min(1.8, Math.max(0.8, Math.sqrt(dist / vh)));   // further = a little longer
    let lastGone = 0;
    const chars = roots.flatMap(r => [...r.querySelectorAll('.fall-char')]);
    const charTops = chars.map(c => c.getBoundingClientRect().top);   // all read first: one layout pass
    chars.forEach((c, i) => {
      const dist = Math.max(60, vh - charTops[i] + 40);
      const t = ms(fallTime(rand(900, 1500), dist)), d = ms(rand(0, 1400));
      c.style.setProperty('--fall', Math.round(dist) + 'px');
      c.style.setProperty('--t', t + 'ms');
      c.style.setProperty('--d', d + 'ms');
      c.style.setProperty('--x', Math.round(rand(-60, 60)) + 'px');
      c.style.setProperty('--r', Math.round(rand(-540, 540)) + 'deg');
      lastGone = Math.max(lastGone, d + t);
    });
    // 2. Then the cards and buttons come off their hinges. Tall ones tilt less, or they swing across the screen.
    const boxes = [...document.querySelectorAll('#view-van .hero, #view-van .action, #view-van .card, #whereSwitch, .do-not-press-row')];
    const hingeAt = ms(1600);
    const boxPlan = boxes.map(b => {
      const r = b.getBoundingClientRect();
      const tilt = (Math.random() < 0.5 ? -1 : 1) * Math.max(3, Math.min(rand(12, 28), 28 * 240 / Math.max(240, r.height)));
      const dist = Math.max(80, vh - r.top + r.width * Math.sin(Math.abs(tilt) * 1.6 * Math.PI / 180) + 60);
      const t = ms(fallTime(rand(1100, 1500), dist)), d = ms(rand(0, 400));
      lastGone = Math.max(lastGone, hingeAt + d + t);
      return { b, tilt, dist, t, d };
    });
    document.body.classList.add('falling');
    document.documentElement.classList.add('egg');
    const hinge = setTimeout(() => boxPlan.forEach(({ b, tilt, dist, t, d }) => {
      b.style.setProperty('--fall', Math.round(dist) + 'px');
      b.style.setProperty('--t', t + 'ms');
      b.style.setProperty('--d', d + 'ms');
      b.style.setProperty('--r', tilt.toFixed(1) + 'deg');
      b.classList.add('fall-box');
    }), hingeAt);
    // 3. Once the last piece has gone, the message; then put it all back
    const message = el('div', { class: 'egg-message' }, el('strong', {}, line[0]), el('span', {}, line[1]));
    const showAt = lastGone + ms(250);
    const show = setTimeout(() => document.body.append(message), showAt);
    setTimeout(() => {
      clearTimeout(hinge); clearTimeout(show);
      message.remove();
      boxes.forEach(b => { b.classList.remove('fall-box'); ['--t', '--d', '--r', '--fall'].forEach(p => b.style.removeProperty(p)); if (!b.getAttribute('style')) b.removeAttribute('style'); });
      wrapped.forEach(([holder, node]) => holder.replaceWith(node));
      document.body.classList.remove('falling');
      document.documentElement.classList.remove('egg');
      window.scrollTo(0, 0);
      done();
      toast('Phew. All put back.');
    }, showAt + ms(5300));   // the message stays up for about 5 seconds before everything comes back
  }

  // ---------- Find a part (engineers): which engineers' vans and which sites hold it ----------
  // The answer is saved on the phone, so it opens straight away and works with no signal (marked with its age).
  async function openFind() {
    if (!isEngineer()) { askPin(openFind, 'Engineer sign in'); return; }
    let where = store.get('pt_where', null);
    const input = el('input', { class: 'input', placeholder: 'Part code or name, e.g. 059K6158 or feed roll', autocomplete: 'off' });
    const status = el('p', { class: 'muted' });
    const results = el('div', {});
    const render = () => {
      results.textContent = '';
      if (!where) return;
      const q = input.value.trim();
      if (!q) { results.append(el('p', { class: 'muted' }, "Type a part code or name. Engineers' vans are listed first, then sites.")); return; }
      const parts = matchParts(state.parts, q).slice(0, 8);
      if (!parts.length) { results.append(el('p', { class: 'muted' }, 'No matching parts.')); return; }
      parts.forEach(p => {
        const vans = where.vanStock.filter(l => l[1] === p.family).map(l => ({ v: where.vans[l[0]], qty: l[2] })).sort((a, b) => b.qty - a.qty);
        const sites = where.siteStock.filter(l => l[1] === p.family).map(l => ({ s: where.sites[l[0]], qty: l[2] })).sort((a, b) => b.qty - a.qty);
        const card = el('div', { class: 'card part-card' }, el('div', { class: 'part-head' },
          el('div', { class: 'item-main' }, el('div', { class: 'item-name' }, p.name), el('div', { class: 'item-sub mono' }, p.family))));
        if (vans.length) {
          card.append(el('p', { class: 'holders-head' }, "Engineers' vans"), el('ul', { class: 'list' }, vans.map(h =>
            el('li', {}, el('div', { class: 'item-main' }, el('div', { class: 'item-name' }, h.v.me ? 'You' : h.v.name)), el('div', { class: 'qty' }, h.qty)))));
        }
        if (sites.length) {
          card.append(el('p', { class: 'holders-head' }, 'Sites'), el('ul', { class: 'list' }, sites.map(h =>
            el('li', {}, el('div', { class: 'item-main' },
              el('div', { class: 'item-name' }, h.s.name, h.s.counted ? null : el('span', { class: 'tag', title: 'Never counted: the stock there is assumed' }, 'assumed')),
              el('div', { class: 'item-sub' }, [h.s.town, h.s.postcode].filter(Boolean).join(' · '))), el('div', { class: 'qty' }, h.qty)))));
        }
        if (!vans.length && !sites.length) card.append(el('p', { class: 'muted' }, 'No engineer or site has this on record.'));
        results.append(card);
      });
    };
    input.addEventListener('input', render);
    openSheet('Find a part', [input, status, results, el('div', { class: 'buttons' }, el('button', { onclick: closeSheet }, 'Close'))]);
    const showStatus = text => { status.textContent = ''; if (text === 'updating') status.append(el('span', { class: 'updating' }, 'Updating…')); else status.textContent = text; };
    showStatus(where ? 'updating' : 'Loading who holds what…');
    render();
    input.focus();
    try {
      const r = await api({ action: 'whereIs', session: state.session });
      if (!r.ok) {
        if (r.code === 'session') { closeSheet(); signOut(true); askPin(openFind, 'Engineer sign in'); return; }
        showStatus(r.error); return;
      }
      delete r.ok;
      where = r;
      store.set('pt_where', r);
      showStatus('');
      render();
    } catch (e) {
      showStatus(e.code === 'offline' ? (where ? 'No signal: showing what this phone saved ' + when(where.at) + '.' : 'No signal. Find a part needs signal the first time.') : e.message);
    }
  }

  // ---------- Change site (engineers) ----------
  // Lets a signed-in engineer move to another site in the same tab, instead of scanning its QR code
  // (each scan opens a new browser tab). The list is kept on the phone for poor signal.
  /** The searchable site list: Change site, or pick where to post parts (onPick). */
  async function chooseSite(onPick, title) {
    if (typeof onPick !== 'function') onPick = null;
    if (!isEngineer()) { askPin(() => chooseSite(onPick, title), 'Engineer sign in'); return; }
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
      list.slice(0, 40).forEach(s => results.append(el('button', { class: 'pick', onclick: () => { closeSheet(); (onPick || switchSite)(s); } },
        el('span', {}, el('span', { class: 'item-name' }, s.name), el('span', { class: 'item-sub' }, [s.town, s.postcode].filter(Boolean).join(' · '))),
        s.token === state.site && !onPick ? el('span', { class: 'tag current' }, 'current') : null)));
      if (q && !list.length) results.append(el('p', { class: 'muted' }, 'No sites match.'));
      if (list.length > 40) results.append(el('p', { class: 'muted' }, 'Showing 40 of ' + list.length + '. Type to narrow the list.'));
    };
    input.addEventListener('input', render);
    openSheet(title || 'Change site', [input, status, results, el('div', { class: 'buttons' }, el('button', { onclick: closeSheet }, 'Cancel'))]);
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
    else { $('loadingName').textContent = 'Loading ' + s.name + '…'; show('view-loading'); }
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
    // At a site, engineers also see each part's Up Time Kit amount and which parts are extra (to take back)
    const siteKit = !inVan && state.data && state.data.lastSeen ? state.data.kit || {} : null;
    const all = cur() && cur().stock || [];
    const held = f => (all.find(x => x.family === f) || {}).qty || 0;
    const vanHave = f => all.filter(x => asKit(x.family) === f).reduce((n, x) => n + x.qty, 0);   // with parts that count as it
    const extraOf = s => siteKit ? surplusFor(s.family, s.qty, held) : null;
    const extras = siteKit ? all.reduce((n, s) => n + ((extraOf(s) || {}).extra || 0), 0) : 0;
    $('stockExtras').hidden = !extras;
    $('stockExtras').textContent = extras ? (extras === 1 ? '1 part here is extra' : extras + ' parts here are extra') + ' (orange): take them back with Take to my van.' : '';
    const rows = all.filter(s => !q || (s.name || '').toLowerCase().includes(q) || s.family.toLowerCase().includes(q.replace(/\s/g, '')));
    rows.forEach(s => {
      const x = extraOf(s);
      const sub = s.family + (kit[s.family] ? ' · min ' + kit[s.family].min + ' · max ' + kit[s.family].max : '') + (siteKit && siteKit[s.family] ? ' · kit ' + siteKit[s.family] : '');
      list.append(el('li', { class: x && x.extra ? 'is-extra' : '' },
        el('div', { class: 'item-main' }, el('div', { class: 'item-name' }, s.name || partName(s.family) || 'Unknown part'),
          el('div', { class: 'item-sub mono' }, sub), extraNote(s.family, x)),
        el('div', { class: 'qty' + (s.qty < 0 || (kit[s.family] && vanHave(s.family) < kit[s.family].min) ? ' neg' : '') }, s.qty)));
    });
    $('stockEmpty').hidden = rows.length > 0;
  }

  // ---------- Admin dashboard ----------
  // One request loads every site, all stock lines and the parts list; everything else is worked out on the phone.
  const admin = { data: null, parts: new Map(), byFamily: new Map(), bySite: [], qrBuilt: false, tab: 'find' };

  async function openAdmin() {
    $('siteName').textContent = 'Admin';
    show('view-admin');
    if (!state.user || !/admin/i.test(state.user.role)) { askPin(loadAdmin, 'Admin sign in'); return; }
    // Show the copy saved on this phone straight away, then bring it up to date
    const saved = store.get('pt_admin', null);
    if (saved && !admin.data) applyAdmin(saved, true);
    loadAdmin();
  }

  async function loadAdmin() {
    $('adminSummary').textContent = admin.data ? '' : 'Loading…';
    $('adminUpdating').hidden = !admin.data;   // a saved copy is showing: say it is being brought up to date
    try {
      const r = await api({ action: 'admin', session: state.session });
      if (!r.ok) { $('adminSummary').textContent = r.error; if (r.code === 'session' || r.code === 'forbidden') askPin(loadAdmin, 'Admin sign in'); return; }
      applyAdmin(r);
    } catch (e) {
      $('adminSummary').textContent = e.code === 'offline'
        ? (admin.data ? 'No connection: showing the copy saved on this phone.' : 'No connection. The dashboard needs signal.') : e.message;
    } finally { $('adminUpdating').hidden = true; }
  }

  /** Takes in a full set of dashboard data (from loading, or returned by a change) and redraws. */
  function applyAdmin(r, fromSaved) {
      if (!fromSaved) { const keep = Object.assign({}, r); delete keep.ok; store.set('pt_admin', keep); }
      admin.data = r;
      admin.parts = new Map((r.parts || []).map(([family, name, codes, countsAs]) => [family, { family, name, codes: String(codes || ''), countsAs: countsAs || '' }]));
      admin.byFamily = new Map();
      admin.bySite = r.sites.map(() => []);
      (r.stock || []).forEach(([si, family, qty]) => {
        if (!admin.byFamily.has(family)) admin.byFamily.set(family, []);
        admin.byFamily.get(family).push({ site: si, qty });
        admin.bySite[si].push({ family, qty });
      });
      admin.qrBuilt = false;
      $('adminSummary').textContent = '';
      renderAdminStats();
      renderPartResults();
      renderSites();
      if (admin.tab === 'qr') renderQr();
      if (admin.tab === 'new') renderNewParts();
      if (admin.tab === 'surplus') renderSurplus();
      // Still looking at one site: redraw it from the new data
      if (!$('admin-site').hidden && admin.siteId) {
        const i = r.sites.findIndex(s => s.id === admin.siteId);
        if (i >= 0) showSiteDetail(i, true);
      }
  }

  const openSites = () => admin.data.sites.filter(s => s.active);

  const adminPartName = f => (admin.parts.get(f) || {}).name || 'Unknown part';
  const siteLine = s => [s.town, s.postcode].filter(Boolean).join(' · ');

  function renderAdminStats() {
    const d = admin.data;
    const open = openSites();
    const items = open.reduce((n, s) => n + s.items, 0);
    const holding = open.filter(s => s.items > 0).length;
    const need = admin.data.sites.filter((s, i) => countReason(i)).length;
    const stat = (value, label, tone, onclick) => el(onclick ? 'button' : 'div', { class: 'stat' + (tone ? ' tone-' + tone : ''), onclick },
      el('div', { class: 'stat-value' }, value), el('div', { class: 'stat-label' }, label + (onclick ? ' ›' : '')));
    const box = $('adminStats'); box.textContent = '';
    const toCheck = d.unreviewedParts || 0;
    box.append(
      stat(open.length, 'sites', 'green'),
      stat(items, 'items at ' + holding + (holding === 1 ? ' site' : ' sites'), 'lime'),
      stat(need, need === 1 ? 'site needs a count' : 'sites need a count', need ? 'pink' : 'blue', need ? showNeedCount : null),
      stat(toCheck, toCheck === 1 ? 'new part to check' : 'new parts to check', toCheck ? 'purple' : 'blue', toCheck ? showNewParts : null));
    renderRecovered();
  }

  /** Parts taken back from sites and returned to Ceva, with their value once the Parts tab has prices. */
  function renderRecovered() {
    const r = admin.data.recovered, box = $('adminRecovered');
    box.textContent = '';
    box.hidden = !r || !(r.fromSites || r.returned);
    if (box.hidden) return;
    const money = v => '£' + v.toLocaleString('en-GB', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
    const parts = n => n + (n === 1 ? ' part' : ' parts');
    box.append(el('div', { class: 'stat tone-orange recovered' },
      el('div', { class: 'stat-value' }, r.priced ? money(r.fromSitesValue) : parts(r.fromSites)),
      el('div', { class: 'stat-label' }, (r.priced ? parts(r.fromSites) + ' ' : '') + 'taken back from customer sites · ' + parts(r.returned) + ' returned to Ceva' +
        (r.priced ? ' (' + money(r.returnedValue) + ')' : '')),
      r.priced && r.unpriced ? el('div', { class: 'stat-label' }, r.unpriced + ' of them have no price yet (Parts tab, Cost column)') : null));
  }

  /** Why an open site needs a count ('' if it doesn't): stock below zero, never counted, or recount due. */
  function countReason(i) {
    const s = admin.data.sites[i];
    if (!s.active) return '';
    if ((admin.bySite[i] || []).some(l => l.qty < 0)) return 'below zero';
    if (!s.lastCount) return 'never counted';
    return (Date.now() - Date.parse(s.lastCount)) / 86400000 >= (admin.data.recountDays || 90) ? 'recount due' : '';
  }
  function showNeedCount() {
    $('siteQuery').value = '';
    $('siteSort').value = 'need';
    showAdminTab('sites');
    renderSites();
  }

  function showAdminTab(tab) {
    admin.tab = tab;
    document.querySelectorAll('[data-admin-tab]').forEach(b => b.setAttribute('aria-selected', String(b.dataset.adminTab === tab)));
    ['find', 'sites', 'site', 'new', 'qr', 'surplus'].forEach(t => { $('admin-' + t).hidden = t !== tab; });
    if (tab === 'qr') renderQr();
    if (tab === 'surplus') renderSurplus();
  }

  // --- New parts added from scans: an admin checks the code and name, then approves ---
  let tabBeforeNew = 'find';
  function showNewParts() {
    if (admin.tab !== 'new') tabBeforeNew = admin.tab === 'site' ? 'sites' : admin.tab;
    showAdminTab('new');
    renderNewParts();
    window.scrollTo(0, 0);
  }
  function renderNewParts() {
    const out = $('newPartList'); out.textContent = '';
    const list = admin.data.newParts;
    if (!list.length) { out.append(el('p', { class: 'muted' }, 'All new parts have been checked.')); return; }
    list.forEach(p => {
      const name = el('input', { class: 'input', value: p.name === 'Unnamed part' ? '' : p.name, placeholder: 'Part name', 'aria-label': 'Name for ' + p.family });
      const err = el('div', { class: 'error', hidden: true });
      const held = heldAt(p.family);
      const codes = p.codes.split(/[\s,]+/).filter(c => c && c !== p.family);
      const approve = el('button', { class: 'btn primary', onclick: async () => {
        if (!name.value.trim()) { err.textContent = 'Type the part name from the box first.'; err.hidden = false; name.focus(); return; }
        err.hidden = true; approve.disabled = true; approve.textContent = 'Saving…';
        try {
          const r = await api({ action: 'reviewPart', session: state.session, family: p.family, name: name.value.trim() });
          if (!r.ok) throw Object.assign(new Error(r.error), { code: r.code });
          admin.data.newParts = list.filter(x => x !== p);
          admin.data.unreviewedParts = admin.data.newParts.length;
          const known = admin.parts.get(p.family);
          if (known) known.name = r.name;
          toast('Approved ' + p.family);
          renderAdminStats();
          if (admin.data.newParts.length) renderNewParts(); else showAdminTab(tabBeforeNew);
          renderPartResults();
        } catch (e) {
          approve.disabled = false; approve.textContent = 'Approve';
          err.textContent = e.code === 'offline' ? 'No connection. Approving needs signal.' : e.message; err.hidden = false;
        }
      } }, 'Approve');
      const reject = el('button', { class: 'btn danger', onclick: () => openRejectPart(p) }, 'Reject: wrong code');
      out.append(el('div', { class: 'card new-part' },
        el('div', { class: 'item-name mono' }, p.family),
        el('div', { class: 'item-sub' }, [codes.length ? 'Box code ' + codes.join(', ') : '', p.addedBy ? 'added by ' + p.addedBy : '', p.addedAt ? when(p.addedAt) : ''].filter(Boolean).join(' · ')),
        el('div', { class: 'item-sub' }, held.length ? 'At ' + held.join(', ') : 'Not at any site or van'),
        el('label', { class: 'field' }, 'Name', name),
        err,
        approve, reject));
    });
  }
  /** Where stock of a part is recorded, sites then vans: ["Leeds Graphic Press (1)", "Justin's van (2)"]. */
  function heldAt(family) {
    return holdersOf(family).filter(h => h.qty > 0).map(h => admin.data.sites[h.site].name + ' (' + h.qty + ')')
      .concat(vanHoldersOf(family).map(h => h.van.name + "'s van (" + h.qty + ')'));
  }

  /** Reject a new part whose code is wrong: pick the part it really was (codes one character off first), or none. */
  function openRejectPart(p) {
    const isNew = new Set(admin.data.newParts.map(x => x.family));
    const known = [...admin.parts.values()].filter(x => !isNew.has(x.family));
    const near = C.oneOff(p.family, known.map(x => x.family)).map(f => admin.parts.get(f));
    const pick = x => el('button', { class: 'pick', onclick: () => confirmReject(p, x) },
      el('span', {}, el('span', { class: 'item-name' }, x.name), el('span', { class: 'item-sub mono' }, x.family)));
    const input = el('input', { class: 'input', placeholder: 'Search by part name or code', autocomplete: 'off' });
    const results = el('div', {});
    input.addEventListener('input', () => {
      results.textContent = '';
      const q = input.value.trim();
      if (!q) return;
      const list = matchParts(new Map(known.map(x => [x.family, x])), q);
      list.slice(0, 20).forEach(x => results.append(pick(x)));
      if (!list.length) results.append(el('p', { class: 'muted' }, 'No parts match.'));
    });
    openSheet('Reject ' + p.family + '?', [
      el('p', { class: 'muted' }, 'Use this when the code is wrong, for example a misread barcode. ' + p.family + ' comes off the parts list.'),
      el('p', { class: 'muted' }, 'Which part was it really? Stock recorded under ' + p.family + ' moves to that part.'),
      near.length ? [el('p', { class: 'muted' }, 'Codes one character different:'), ...near.map(pick)] : null,
      input, results,
      el('div', { class: 'buttons' },
        el('button', { onclick: () => confirmReject(p, null) }, 'Not a real part'),
        el('button', { onclick: closeSheet }, 'Cancel'))
    ]);
  }

  function confirmReject(p, to) {
    const held = heldAt(p.family);
    const err = el('div', { class: 'error', hidden: true });
    const go = el('button', { class: to ? 'primary' : 'danger', onclick: async () => {
      const r = await adminChange({ action: 'rejectPart', family: p.family, replaceWith: to ? to.family : '' }, err, go);
      if (!r) return;
      closeSheet();
      toast('Rejected ' + p.family + (to ? ': now ' + to.name : ''));
      if (!admin.data.newParts.length) showAdminTab(tabBeforeNew);
    } }, to ? 'Reject and use ' + to.name : 'Reject and remove');
    openSheet(to ? 'It was really ' + to.name : 'Not a real part', [
      el('p', {}, to ? p.family + ' becomes ' + to.family + ' (' + to.name + ').' : p.family + ' comes off the parts list.'),
      el('p', { class: 'muted' }, held.length
        ? (to ? 'Stock moves to ' + to.name + ' at: ' : 'Stock is taken off at: ') + held.join(', ') + '.'
        : 'No stock is recorded under this code.'),
      el('p', { class: 'muted' }, 'Parts on their way under this code ' + (to ? 'become ' + to.name + '.' : 'are cancelled.')),
      err, el('div', { class: 'buttons' }, go, el('button', { onclick: () => openRejectPart(p) }, 'Back'))]);
  }

  // --- Surplus: parts that can be collected from sites ---
  /** Surplus lines grouped by site, most items first: [{ s, i, lines: [{ family, qty, why, n }], total }]. */
  function surplusBySite() {
    const by = new Map();
    (admin.data.surplus || []).forEach(([i, family, qty, why, n]) => {
      if (!by.has(i)) by.set(i, { s: admin.data.sites[i], i, lines: [], total: 0 });
      const g = by.get(i);
      g.lines.push({ family, qty, why, n });
      g.total += qty;
    });
    return [...by.values()].sort((a, b) => b.total - a.total || a.s.name.localeCompare(b.s.name));
  }
  const surplusWhy = l => l.why === 'kit' ? 'Above the kit: kit is ' + l.n : 'Not used or delivered for ' + l.n + ' days';
  function renderSurplus() {
    if (!admin.data) return;
    const groups = surplusBySite();
    const items = groups.reduce((n, g) => n + g.total, 0);
    const days = admin.data.surplusDays || 60;
    $('surplusSummary').textContent = items ? items + (items === 1 ? ' item' : ' items') + ' to collect from ' + groups.length + (groups.length === 1 ? ' site' : ' sites') : 'No surplus at any site';
    $('surplusCopy').hidden = !items;
    $('surplusRule').textContent = 'Surplus = anything above a site\'s Up Time Kit, or any other part not used or delivered there for ' + days +
      ' days. Sites never counted are marked assumed: their stock is not confirmed yet.';
    const list = $('surplusList'); list.textContent = '';
    groups.forEach(g => {
      const card = el('div', { class: 'card part-card surplus-site' },
        el('div', { class: 'part-head', onclick: () => showSiteDetail(g.i) },
          el('div', { class: 'item-main' },
            el('div', { class: 'item-name' }, g.s.name, g.s.lastCount ? null : el('span', { class: 'tag' }, 'assumed')),
            el('div', { class: 'item-sub' }, siteLine(g.s))),
          el('div', { class: 'part-total' }, g.total + (g.total === 1 ? ' item' : ' items'))),
        el('ul', { class: 'list' }, g.lines.sort((a, b) => adminPartName(a.family).localeCompare(adminPartName(b.family))).map(l =>
          el('li', {}, el('div', { class: 'item-main' },
            el('div', { class: 'item-name' }, adminPartName(l.family)),
            el('div', { class: 'item-sub' }, l.family + ' · ' + surplusWhy(l))), el('div', { class: 'qty' }, l.qty)))));
      list.append(card);
    });
    const soon = (admin.data.surplusSoon || []).slice().sort((a, b) => a[3] - b[3]);
    $('surplusSoonBox').hidden = !soon.length;
    $('surplusSoonHead').textContent = 'Becoming surplus (' + soon.length + (soon.length === 1 ? ' part)' : ' parts)');
    const sl = $('surplusSoonList'); sl.textContent = '';
    soon.forEach(([i, family, qty, left]) => {
      const s = admin.data.sites[i];
      sl.append(el('li', { class: 'clickable', onclick: () => showSiteDetail(i) },
        el('div', { class: 'item-main' }, el('div', { class: 'item-name' }, adminPartName(family)),
          el('div', { class: 'item-sub' }, s.name + ' · surplus in ' + left + (left === 1 ? ' day' : ' days') + ' if not used')),
        el('div', { class: 'qty' }, qty)));
    });
  }
  async function copySurplus() {
    const text = surplusBySite().map(g => g.s.name + (g.s.postcode ? ' (' + g.s.postcode + ')' : '') + '\n' +
      g.lines.map(l => '  ' + l.family + '  ' + adminPartName(l.family) + '  x' + l.qty).join('\n')).join('\n\n');
    try { await navigator.clipboard.writeText(text); toast('Surplus list copied'); }
    catch (e) { openSheet('Surplus list', [el('pre', { class: 'order-text' }, text), el('div', { class: 'buttons' }, el('button', { onclick: closeSheet }, 'Close'))]); }
  }

  // --- Find a part: which sites hold it ---
  function matchParts(partsMap, q) {
    const raw = q.toUpperCase().replace(/\s+/g, '');
    const core = raw.replace(/^(PFFB|PFB|FFB|FB|P)(?=\d)/, '');
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    const out = [];
    for (const p of partsMap.values()) {
      const codeHit = core.length >= 3 && /\d/.test(core) && (p.family.slice(1).startsWith(core.slice(0, 9)) || p.codes.toUpperCase().replace(/[\s,]+/g, ' ').includes(core));
      const nameHit = words.length && words.every(w => p.name.toLowerCase().includes(w));
      if (codeHit || nameHit) out.push(p);
    }
    return out;
  }
  function vanHoldersOf(family) {
    return (admin.data.vanStock || []).filter(l => l[1] === family).map(l => ({ van: admin.data.vans[l[0]], qty: l[2] })).sort((a, b) => b.qty - a.qty);
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
      parts = matchParts(admin.parts, q);
      heading = parts.length ? parts.length + (parts.length === 1 ? ' matching part' : ' matching parts') : 'No matching parts';
    } else {
      // Nothing typed: show the parts held at the most sites
      parts = [...admin.byFamily.keys()].map(f => admin.parts.get(f) || { family: f, name: 'Unknown part', codes: '' })
        .sort((a, b) => holdersOf(b.family).length - holdersOf(a.family).length).slice(0, 10);
      heading = parts.length ? 'Most widely held parts' : 'No stock recorded at any site yet';
    }
    const total = f => holdersOf(f).reduce((n, h) => n + Math.max(0, h.qty), 0) + vanHoldersOf(f).reduce((n, h) => n + h.qty, 0);
    parts.sort((a, b) => total(b.family) - total(a.family));
    out.append(el('p', { class: 'muted' }, heading));
    parts.slice(0, 25).forEach(p => {
      const holders = holdersOf(p.family);
      const held = holders.filter(h => h.qty > 0).length, below = holders.filter(h => h.qty < 0).length;
      const vans = vanHoldersOf(p.family);
      const atSites = holders.reduce((n, h) => n + Math.max(0, h.qty), 0), inVans = vans.reduce((n, h) => n + h.qty, 0);
      // Below-zero records mean more were used than booked in: the site needs a count, not a "0 held"
      const summary = [vans.length ? inVans + ' in ' + vans.length + (vans.length === 1 ? ' van' : ' vans') : '',
        held ? atSites + ' at ' + held + (held === 1 ? ' site' : ' sites') : ''].filter(Boolean).join(' · ')
        || (below ? 'Below zero at ' + below + (below === 1 ? ' site' : ' sites') + ': needs a count' : 'Not held anywhere');
      const card = el('div', { class: 'card part-card' },
        el('div', { class: 'part-head' },
          el('div', { class: 'item-main' }, el('div', { class: 'item-name' }, p.name), el('div', { class: 'item-sub mono' }, p.family)),
          el('div', { class: 'part-total' + (held || vans.length ? '' : below ? ' below' : ' none') }, summary)));
      if (vans.length) {
        card.append(el('p', { class: 'holders-head' }, "Engineers' vans"),
          el('ul', { class: 'list' }, vans.map(h => el('li', {}, el('div', { class: 'item-main' }, el('div', { class: 'item-name' }, h.van.name)), el('div', { class: 'qty' }, h.qty)))));
        if (holders.length) card.append(el('p', { class: 'holders-head' }, 'Sites'));
      }
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
    const order = { 'below zero': 0, 'never counted': 1, 'recount due': 2 };
    // Closed sites go to the bottom of the list; "Needs a count" shows only those, most urgent first
    const rows = filteredSites().filter(s => sort !== 'need' || countReason(s.i)).sort((a, b) => (b.active - a.active) || (
      sort === 'need' ? order[countReason(a.i)] - order[countReason(b.i)] || a.name.localeCompare(b.name) :
      sort === 'items' ? b.items - a.items || a.name.localeCompare(b.name)
        : sort === 'count' ? (a.lastCount || '').localeCompare(b.lastCount || '') || a.name.localeCompare(b.name)
          : a.name.localeCompare(b.name)));
    const shut = rows.filter(s => !s.active).length;
    $('siteCount').textContent = (rows.length - shut) + ' of ' + openSites().length + ' sites' + (shut ? ' · ' + shut + ' closed' : '');
    const ul = $('siteList'); ul.textContent = '';
    rows.forEach(s => ul.append(el('li', { class: 'clickable' + (s.active ? '' : ' closed'), onclick: () => showSiteDetail(s.i) },
      el('div', { class: 'item-main' },
        el('div', { class: 'item-name' }, s.name, s.active ? null : el('span', { class: 'tag' }, 'closed')),
        el('div', { class: 'item-sub' }, [siteLine(s), s.printers.join(', ')].filter(Boolean).join(' · ')),
        el('div', { class: 'item-sub' + (countReason(s.i) ? ' warn-text' : '') }, [countReason(s.i) === 'below zero' ? 'Stock below zero' : '',
          s.lastCount ? 'Counted ' + when(s.lastCount) : 'Never counted', countReason(s.i) === 'recount due' ? 'recount due' : ''].filter(Boolean).join(' · '))),
      el('div', { class: 'qty' }, s.items))));
    if (!rows.length) ul.append(el('li', { class: 'muted' }, 'No sites match.'));
  }

  // --- One site ---
  function showSiteDetail(i, keepScroll) {
    const s = admin.data.sites[i];
    admin.siteId = s.id;
    const head = $('siteDetailHead'); head.textContent = '';
    head.append(
      el('div', { class: 'hero-label' }, 'Site ' + s.id + (s.active ? '' : ' · CLOSED')),
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
    $('siteDetailOpen').hidden = !s.active;
    renderMachines(s);
    $('machineAdd').hidden = !s.active;
    $('siteClose').textContent = s.active ? 'Close this site' : 'Reopen this site';
    $('siteClose').className = 'btn' + (s.active ? ' danger' : ' primary');
    ['find', 'sites', 'new', 'qr'].forEach(t => { $('admin-' + t).hidden = true; });
    $('admin-site').hidden = false;
    if (!keepScroll) window.scrollTo(0, 0);
  }

  // --- Sites and machines: add, edit, move, close ---
  const curSite = () => admin.data.sites.find(s => s.id === admin.siteId);

  /** Sends one change; the reply carries the refreshed dashboard. Returns the reply, or null after showing the error. */
  async function adminChange(req, errBox, button) {
    if (button) { button.disabled = true; button.dataset.label = button.textContent; button.textContent = 'Saving…'; }
    errBox.hidden = true;
    try {
      const r = await api(Object.assign({ session: state.session }, req));
      if (!r.ok) throw Object.assign(new Error(r.error), { code: r.code });
      admin.qrBuilt = false;
      applyAdmin(r.admin);
      return r;
    } catch (e) {
      errBox.textContent = e.code === 'offline' ? 'No connection. Changes need signal.' : e.message;
      errBox.hidden = false;
      return null;
    } finally {
      if (button) { button.disabled = false; button.textContent = button.dataset.label; }
    }
  }

  function field(label, input) { return el('label', { class: 'field' }, label, input); }

  /** Add a site (no site given) or edit one. */
  function openSiteForm(s) {
    const name = el('input', { class: 'input', value: s ? s.name : '', autocomplete: 'off' });
    const town = el('input', { class: 'input', value: s ? s.town : '', autocomplete: 'off' });
    const postcode = el('input', { class: 'input', value: s ? s.postcode : '', autocomplete: 'off', autocapitalize: 'characters' });
    const err = el('div', { class: 'error', hidden: true });
    const save = el('button', { class: 'primary', onclick: async () => {
      const r = await adminChange({ action: 'siteSave', id: s ? s.id : undefined, name: name.value, town: town.value, postcode: postcode.value }, err, save);
      if (!r) return;
      closeSheet();
      const i = admin.data.sites.findIndex(x => x.id === r.id);
      if (i >= 0) showSiteDetail(i);
      toast(s ? 'Site updated' : 'Site added. Its QR code is ready in the QR codes tab.');
    } }, s ? 'Save' : 'Add site');
    openSheet(s ? 'Edit site' : 'Add a site', [
      s ? null : el('p', { class: 'muted' }, 'Name, town and postcode only: no customer contact details.'),
      field('Site name', name), field('Town', town), field('Postcode', postcode), err,
      el('div', { class: 'buttons' }, save, el('button', { onclick: closeSheet }, 'Cancel'))]);
    setTimeout(() => name.focus(), 50);
  }

  function closeOrReopenSite() {
    const s = curSite();
    const err = el('div', { class: 'error', hidden: true });
    const go = el('button', { class: s.active ? 'danger' : 'primary', onclick: async () => {
      const r = await adminChange({ action: 'siteSave', id: s.id, name: s.name, town: s.town, postcode: s.postcode, active: !s.active }, err, go);
      if (!r) return;
      closeSheet();
      toast(s.active ? s.name + ' closed' : s.name + ' reopened');
    } }, s.active ? 'Close site' : 'Reopen site');
    openSheet(s.active ? 'Close ' + s.name + '?' : 'Reopen ' + s.name + '?', [
      el('p', { class: 'muted' }, s.active
        ? 'Its QR code stops working and it leaves the lists. Its history is kept, and you can reopen it later.' +
          (s.machines.length ? ' Move or remove its ' + s.machines.length + (s.machines.length === 1 ? ' machine' : ' machines') + ' first if they have gone elsewhere.' : '')
        : 'Its QR code works again and it returns to the lists.'),
      err, el('div', { class: 'buttons' }, go, el('button', { onclick: closeSheet }, 'Cancel'))]);
  }

  function renderMachines(s) {
    const ul = $('siteMachines'); ul.textContent = '';
    s.machines.forEach(m => ul.append(el('li', {},
      el('div', { class: 'item-main' },
        el('div', { class: 'item-name' }, m.model, m.noKit ? el('span', { class: 'tag' }, 'no kit') : (admin.data.kits || {})[m.model] ? el('span', { class: 'tag current' }, 'kit') : null),
        el('div', { class: 'item-sub mono' }, m.serial ? 'Serial ' + m.serial : 'No serial number')),
      s.active ? el('div', { class: 'machine-actions' },
        el('button', { class: 'small', onclick: () => openMoveMachine(s, m) }, 'Move'),
        el('button', { class: 'small', onclick: () => openRemoveMachine(s, m) }, 'Remove')) : null)));
    if (!s.machines.length) ul.append(el('li', { class: 'muted' }, 'No machines listed.'));
  }

  function openAddMachine() {
    const s = curSite();
    const models = admin.data.models || [];
    const pick = el('select', { class: 'input', 'aria-label': 'Model' },
      el('option', { value: '' }, 'Choose the model…'), models.map(m => el('option', { value: m }, m)), el('option', { value: '__new' }, 'New model (type it)…'));
    const typed = el('input', { class: 'input', placeholder: 'e.g. REVORIA PRESS SC285S', autocomplete: 'off', autocapitalize: 'characters' });
    const typedField = field('New model name', typed); typedField.hidden = true;
    pick.addEventListener('change', () => { typedField.hidden = pick.value !== '__new'; if (!typedField.hidden) typed.focus(); });
    const serial = el('input', { class: 'input', autocomplete: 'off', autocapitalize: 'characters' });
    const err = el('div', { class: 'error', hidden: true });
    const save = el('button', { class: 'primary', onclick: async () => {
      const model = pick.value === '__new' ? typed.value : pick.value;
      if (!model.trim()) { err.textContent = 'Choose the model.'; err.hidden = false; return; }
      const r = await adminChange({ action: 'machineAdd', siteId: s.id, model, serial: serial.value }, err, save);
      if (!r) return;
      closeSheet();
      toast('Added ' + model.trim().toUpperCase() + ' at ' + s.name);
    } }, 'Add machine');
    openSheet('Add a machine to ' + s.name, [field('Model', pick), typedField, field('Serial number', serial), err,
      el('div', { class: 'buttons' }, save, el('button', { onclick: closeSheet }, 'Cancel'))]);
  }

  /** One kit's worth of the model's kit parts held at the site (what "move the kit" would move). */
  function kitToMove(s, m) {
    const kit = m.noKit ? null : (admin.data.kits || {})[m.model];
    if (!kit) return null;
    const held = {};
    admin.bySite[admin.data.sites.indexOf(s)].forEach(l => { held[l.family] = l.qty; });
    return Object.keys(kit).map(f => ({ family: f, qty: Math.min(held[f] || 0, kit[f] || held[f] || 0) })).filter(l => l.qty > 0);
  }

  function openMoveMachine(s, m) {
    const input = el('input', { class: 'input', placeholder: 'Site name, town or postcode', autocomplete: 'off' });
    const results = el('div', {});
    const render = () => {
      results.textContent = '';
      const q = input.value.trim().toLowerCase();
      const list = openSites().filter(x => x.id !== s.id && (!q || [x.name, x.town, x.postcode, x.postcode.replace(/\s/g, '')].join(' ').toLowerCase().includes(q)))
        .sort((a, b) => a.name.localeCompare(b.name));
      list.slice(0, 30).forEach(x => results.append(el('button', { class: 'pick', onclick: () => confirmMove(s, m, x) },
        el('span', {}, el('span', { class: 'item-name' }, x.name), el('span', { class: 'item-sub' }, siteLine(x))))));
      if (!list.length) results.append(el('p', { class: 'muted' }, 'No sites match.'));
    };
    input.addEventListener('input', render);
    openSheet('Move ' + m.model + (m.serial ? ' ' + m.serial : '') + ' to…', [input, results, el('div', { class: 'buttons' }, el('button', { onclick: closeSheet }, 'Cancel'))]);
    render();
    setTimeout(() => input.focus(), 50);
  }

  function confirmMove(s, m, to) {
    const kit = kitToMove(s, m);
    const tick = el('input', { type: 'checkbox', checked: true });
    const err = el('div', { class: 'error', hidden: true });
    const kitBox = kit && kit.length ? el('div', { class: 'kit-move' },
      el('label', { class: 'check' }, tick, ' Move its Up Time Kit stock too'),
      el('ul', { class: 'list compact' }, kit.map(l => el('li', {},
        el('div', { class: 'item-main' }, el('div', { class: 'item-name' }, adminPartName(l.family)), el('div', { class: 'item-sub mono' }, l.family)),
        el('div', { class: 'qty' }, l.qty)))))
      : kit ? el('p', { class: 'muted' }, 'No ' + m.model + ' kit stock is recorded at ' + s.name + ', so only the machine moves.') : null;
    const go = el('button', { class: 'primary', onclick: async () => {
      const r = await adminChange({ action: 'machineMove', row: m.row, model: m.model, serial: m.serial, toSiteId: to.id, moveKit: !!(kit && kit.length && tick.checked) }, err, go);
      if (!r) return;
      closeSheet();
      toast('Moved ' + m.model + ' to ' + to.name + (r.moved && r.moved.length ? ' with ' + r.moved.reduce((n, l) => n + l.qty, 0) + ' kit items' : ''));
    } }, 'Move machine');
    openSheet('Move to ' + to.name + '?', [
      el('p', {}, m.model + (m.serial ? ' (serial ' + m.serial + ')' : '') + ' moves from ' + s.name + ' to ' + to.name + '.'),
      kitBox, err, el('div', { class: 'buttons' }, go, el('button', { onclick: closeSheet }, 'Cancel'))]);
  }

  function openRemoveMachine(s, m) {
    const err = el('div', { class: 'error', hidden: true });
    const go = el('button', { class: 'danger', onclick: async () => {
      const r = await adminChange({ action: 'machineRemove', row: m.row, model: m.model, serial: m.serial }, err, go);
      if (!r) return;
      closeSheet();
      toast('Removed ' + m.model + ' from ' + s.name);
    } }, 'Remove machine');
    openSheet('Remove ' + m.model + '?', [
      el('p', { class: 'muted' }, 'Use this when the machine is taken out of service. If it has gone to another site, use Move instead. Stock at the site is not changed.'),
      err, el('div', { class: 'buttons' }, go, el('button', { onclick: closeSheet }, 'Cancel'))]);
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
    admin.data.sites.map((s, i) => Object.assign({ i }, s)).filter(s => s.active).sort((a, b) => a.name.localeCompare(b.name)).forEach(s => {
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
    // Transfer (rare): parts sent from the van to a site, picked from the site list first
    $('vanTransfer').addEventListener('click', () => chooseSite(s => { state.postTo = s; state.where = 'van'; startMode('POSTED'); }, 'Transfer to which site?'));
    document.querySelectorAll('#whereSwitch button').forEach(b => b.addEventListener('click', () => {
      if (b.dataset.where === 'van') openVan(); else { state.where = 'site'; goHome(); }
    }));
    $('nositeVan').addEventListener('click', openVan);
    $('nositeChoose').addEventListener('click', chooseSite);
    $('findPart').addEventListener('click', openFind);
    $('doNotPress').addEventListener('click', doNotPress);
    $('surplusCopy').addEventListener('click', copySurplus);
    $('vanFindPart').addEventListener('click', openFind);
    $('vanJobs').addEventListener('click', openJobs);
    $('recountGo').addEventListener('click', () => startMode('COUNT'));
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
    document.querySelectorAll('input[name=source]').forEach(r => r.addEventListener('change', () => {
      const stock = {};
      (cur() && cur().stock || []).forEach(s => { stock[s.family] = s.qty; });
      reviewWarnings(sendType(), stock);   // "From my van" checks the van's stock instead
    }));
    $('doneHome').addEventListener('click', goHome);
    $('doneCopy').addEventListener('click', () => copyText(state.doneSap));
    $('doneExtras').addEventListener('click', takeExtras);
    $('sheetBackdrop').addEventListener('click', closeSheet);
    $('printQr').addEventListener('click', () => window.print());
    $('adminRefresh').addEventListener('click', loadAdmin);
    document.querySelectorAll('[data-admin-tab]').forEach(b => b.addEventListener('click', () => showAdminTab(b.dataset.adminTab)));
    $('partQuery').addEventListener('input', renderPartResults);
    $('siteQuery').addEventListener('input', renderSites);
    $('siteSort').addEventListener('change', renderSites);
    $('siteBack').addEventListener('click', () => showAdminTab('sites'));
    $('siteAdd').addEventListener('click', () => openSiteForm(null));
    $('siteEdit').addEventListener('click', () => openSiteForm(curSite()));
    $('machineAdd').addEventListener('click', openAddMachine);
    $('siteClose').addEventListener('click', closeOrReopenSite);
    $('newBack').addEventListener('click', () => showAdminTab(tabBeforeNew));
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
    if (!('serviceWorker' in navigator) || location.protocol !== 'https:') return;
    // When a new version takes over, reload once so the open screen runs it (not on the very first install)
    const hadController = !!navigator.serviceWorker.controller;
    let reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController || reloaded) return;
      reloaded = true;
      // Never interrupt a scan in progress; it picks up the update next time the app opens
      if (state.view === 'view-scan' || state.view === 'view-review' || state.basket.length) return;
      location.reload();
    });
    navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then(reg => reg.update()).catch(() => {});
  }

  // Exposed for automated tests
  window.PTApp = { state, openJobs, sapText, feedback, handleCode, openSearch, searchParts, openReview, sendReview, startMode, syncQueue, loadSite, openAdmin, showAdminTab, showSiteDetail, admin, openVan, vanShortfall, orderLines, orderParts, smartsheetUrl, chooseSite, openFind, route };

  init();
})();
