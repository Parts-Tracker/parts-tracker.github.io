/* Offline support: keeps the app files on the phone. Data requests always go to the network.
   App files are fetched fresh when there is signal (falling back to the saved copy offline or after 4 s),
   so updates reach phones straight away; the third-party libraries are versioned and served from the copy. */
const CACHE = 'pt-v50';
const APP_FILES = ['./', 'index.html', 'app.css', 'config.js', 'codes.js', 'scanner.js', 'outbox.js', 'app.js', 'icon.svg', 'manifest.webmanifest'];
importScripts('outbox.js');
const LIBS = [
  'https://cdn.jsdelivr.net/npm/@zxing/library@0.21.3/umd/index.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/qrcode-generator/1.4.4/qrcode.min.js'
];

self.addEventListener('install', e => {
  // cache: 'reload' skips the browser's own HTTP cache, so a new version never saves old files
  e.waitUntil(caches.open(CACHE)
    .then(c => c.addAll(APP_FILES.map(u => new Request(u, { cache: 'reload' })).concat(LIBS)))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.hostname.endsWith('google.com') || url.hostname.endsWith('googleusercontent.com')) return;
  if (url.origin !== location.origin) {
    // Versioned libraries: the saved copy is always right
    e.respondWith(caches.match(req).then(hit => hit || fetch(req)));
    return;
  }
  e.respondWith(networkFirst(req));
});

async function networkFirst(req) {
  const cache = await caches.open(CACHE);
  const fresh = fetch(req, { cache: 'no-cache' }).then(res => {
    if (res.ok) cache.put(req, res.clone());
    return res;
  });
  const timeout = new Promise(resolve => setTimeout(resolve, 4000));
  try {
    const res = await Promise.race([fresh, timeout]);
    if (res) return res;
  } catch (err) { /* offline: fall through to the saved copy */ }
  const saved = await cache.match(req, { ignoreSearch: true });
  return saved || fresh;
}

// Background sync (Chrome on Android): Chrome wakes this worker when signal returns, even with the app closed,
// and it sends the records waiting in the outbox. If there is still no signal it fails, so Chrome tries again later.
self.addEventListener('sync', e => {
  if (e.tag === PTOutbox.TAG) e.waitUntil(PTOutbox.send(fetch));
});
