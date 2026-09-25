/* JZD Shop Manager — the phone's service worker.

   Keeps the app on the phone so it opens with no signal, on a mobile job. The
   shop's work itself is kept by the phone shell (IndexedDB) and goes up to the
   Shop Hub when the phone is back on the shop's Wi-Fi; this file only keeps
   the program.

   The hub writes the app's fingerprint into APP below, so a new version of the
   app is a new service worker: the phone fetches the new files the next time
   it opens the app on the shop's Wi-Fi, and uses them from the next start. */
const APP = "__JZD_APP__";
const CACHE = "jzd-phone-" + APP;
/* what the app cannot open without */
const CORE = ["/", "/phone-shell.js", "/noble.js", "/vendor/qrcode.js"];
/* the VIN scanner's libraries: large, so fetched after the app is kept */
const LATER = ["/vendor/zxing-reader.js", "/vendor/zxing_reader.wasm", "/vendor/tesseract.min.js", "/vendor/tesseract-worker.min.js",
  "/vendor/tesseract-core-simd-lstm.wasm.js", "/vendor/tesseract-core-lstm.wasm.js", "/vendor/eng.traineddata.gz"];
const KEPT = new Set(CORE.concat(LATER).concat(["/phone", "/phone/"]));

self.addEventListener("install", ev => {
  ev.waitUntil(caches.open(CACHE).then(c => c.addAll(CORE.map(u => new Request(u, {cache: "reload"})))).then(() => self.skipWaiting()));
});

self.addEventListener("activate", ev => {
  ev.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith("jzd-phone-") && k !== CACHE) await caches.delete(k);
    await self.clients.claim();
    const c = await caches.open(CACHE);
    for (const u of LATER) {
      try { if (!(await c.match(u))) { const r = await fetch(u, {cache: "reload"}); if (r.ok) await c.put(u, r); } } catch (e) { /* next time */ }
    }
  })());
});

self.addEventListener("fetch", ev => {
  const req = ev.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || !KEPT.has(url.pathname)) return;   /* the hub's live traffic is never cached */
  const key = url.pathname === "/phone" || url.pathname === "/phone/" ? "/" : url.pathname;
  ev.respondWith((async () => {
    const c = await caches.open(CACHE);
    const hit = await c.match(key);
    if (hit) return hit;
    const r = await fetch(req);
    if (r.ok) c.put(key, r.clone()).catch(() => {});
    return r;
  })());
});
