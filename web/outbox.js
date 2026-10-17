/* Outbox for background sync (Chrome on Android): a copy of the records waiting to send, kept in IndexedDB
   so the service worker can send them when signal returns, even with the app closed. The app's own queue
   (localStorage) stays the master copy: a record sent from here and then again by the app is recognised by
   the backend (same batch id) and not recorded twice. Used by app.js and sw.js. */
(function (root) {
  'use strict';
  const DB = 'pt-outbox', STORE = 'requests', META = 'meta';

  function open() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => { req.result.createObjectStore(STORE); req.result.createObjectStore(META); };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  /** Runs fn(stores) in one transaction and resolves when it has been written. */
  async function tx(mode, fn) {
    const db = await open();
    try {
      return await new Promise((resolve, reject) => {
        const t = db.transaction([STORE, META], mode);
        let out;
        Promise.resolve(fn(t.objectStore(STORE), t.objectStore(META))).then(v => { out = v; }, reject);
        t.oncomplete = () => resolve(out);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      });
    } finally { db.close(); }
  }
  const all = store => new Promise((resolve, reject) => {
    const keys = store.getAllKeys(), vals = store.getAll();
    vals.onsuccess = () => resolve(keys.result.map((k, i) => [k, vals.result[i]]));
    vals.onerror = () => reject(vals.error);
  });

  /** Replaces the outbox with these requests (each a full submit request with its batchId). */
  function save(apiUrl, requests) {
    return tx('readwrite', (store, meta) => {
      store.clear();
      requests.forEach(r => store.put(r, r.batchId));
      meta.put(apiUrl, 'apiUrl');
    });
  }

  function list() { return tx('readonly', store => all(store)).then(rows => rows.map(r => r[1])); }

  /**
   * Sends everything in the outbox. Sent (or refused, e.g. sign-in needed: the app shows that when it opens)
   * requests are removed one by one, so anything queued meanwhile is kept. Rejects if there was no signal,
   * which makes Chrome try again later.
   */
  async function send(fetchFn) {
    // Both reads are started straight away, inside the one transaction
    const [rows, apiUrl] = await tx('readonly', (store, meta) => Promise.all([
      all(store),
      new Promise(res => { const g = meta.get('apiUrl'); g.onsuccess = () => res(g.result); g.onerror = () => res(''); })
    ]));
    if (!rows.length || !apiUrl) return { sent: 0, left: rows.length };
    let sent = 0, offline = false;
    for (const [key, req] of rows) {
      try {
        const res = await fetchFn(apiUrl, { method: 'POST', body: JSON.stringify(req), redirect: 'follow' });
        if (!res.ok) { offline = true; break; }
        await res.json();
        await tx('readwrite', store => { store.delete(key); });
        sent++;
      } catch (e) { offline = true; break; }
    }
    if (offline) throw Object.assign(new Error('No signal: ' + (rows.length - sent) + ' record(s) still waiting'), { sent: sent });
    return { sent: sent, left: 0 };
  }

  root.PTOutbox = { save, list, send, TAG: 'pt-send' };
})(typeof self !== 'undefined' ? self : window);
