// Offline shell.
//
// Collection happens in rooms with bad wifi and on tablets in airplane mode,
// so the app itself must survive a cold start with no network: the shell and
// the 759-row task file are precached, and everything the writer produces
// lives in IndexedDB until the queue can drain.
//
// Bump CACHE when any shell file changes — the old cache is dropped wholesale
// on activate, which is the only reliable way to retire a stale module graph.

const CACHE = 'noto-collect-v1';

const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/app.css',
  './js/app.js',
  './js/store.js',
  './js/tasks.js',
  './js/ink.js',
  './js/sync.js',
  './js/util.js',
  './js/exchange.js',
  './data/russian_core_tasks.json',
  './icons/icon.svg',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // Individually, so one missing optional asset can't fail the whole install.
    await Promise.all(SHELL.map((path) => cache.add(path).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((n) => n !== CACHE).map((n) => caches.delete(n)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  // Uploads and anything cross-origin go straight to the network — a cached
  // POST response would be a lie about what the server accepted.
  if (request.method !== 'GET') return;
  if (new URL(request.url).origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        return await fetch(request);
      } catch {
        const cache = await caches.open(CACHE);
        return (await cache.match('./index.html')) ?? Response.error();
      }
    })());
    return;
  }

  // Stale-while-revalidate: instant from cache, refreshed in the background so
  // a deploy is picked up on the next load without ever blocking this one.
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(request);
    const network = fetch(request)
      .then((response) => {
        if (response.ok) cache.put(request, response.clone());
        return response;
      })
      .catch(() => null);
    return cached ?? (await network) ?? Response.error();
  })());
});
