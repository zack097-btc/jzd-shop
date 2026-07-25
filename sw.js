/* JZD Shop Manager service worker — offline app shell + fresh-when-online */
const CACHE = 'jzd-shop-v1';
const ASSETS = [
  './', './index.html', './manifest.webmanifest',
  './icon-192.png', './icon-512.png', './icon-maskable-512.png'
];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
/* Network-first: always fresh when online (picks up updates automatically), cached copy when offline. */
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    fetch(e.request).then(resp => {
      const cp = resp.clone();
      caches.open(CACHE).then(c => c.put(e.request, cp)).catch(()=>{});
      return resp;
    }).catch(() => caches.match(e.request, {ignoreSearch: true}).then(m => m || caches.match('./index.html')))
  );
});
