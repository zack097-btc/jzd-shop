/* JZD Shop Manager's hosted version is retired — Shop Manager is a Windows
   program now and keeps its book in a real file.

   This worker exists for one reason: a browser that installed the old web app
   still has the old shop in its cache and would keep serving it offline, out of
   sight, long after the page is gone. Anything with that installation gets this
   file on its next update check; it empties the cache, unregisters itself and
   reloads the tab, which then lands on the notice in index.html.

   It has no fetch handler on purpose — every request goes straight to the
   network. Delete this file once GitHub Pages is switched off and enough time
   has passed for the installed copies to have checked in. */
self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.map(k => caches.delete(k)));
    await self.registration.unregister();
    const windows = await self.clients.matchAll({ type: 'window' });
    windows.forEach(c => c.navigate(c.url));
  })());
});
