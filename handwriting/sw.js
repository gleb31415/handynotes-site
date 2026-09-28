// Offline shell.
//
// Collection happens in rooms with bad wifi and on tablets in airplane mode,
// so the app itself must survive a cold start with no network: the shell,
// both core task files (Russian 758 rows, English 871) and the interface
// dictionaries (js/i18n.js) are precached, and everything the writer
// produces lives in IndexedDB until the queue can drain.
//
// «Решение почерком» must work offline too, so the symbol corpus, the
// compositor modules and the whole vendored KaTeX (module, CSS and all 20
// fonts — which fonts a formula needs is only known once it is typeset) are
// precached as well. They are fetched in the background at install; the page
// itself still imports KaTeX only when a formula is first shown.
//
// Bump CACHE when any shell file changes — the old cache is dropped wholesale
// on activate, which is the only reliable way to retire a stale module graph.

const CACHE = 'noto-collect-v11';

const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/app.css?v=2',
  './js/app.js',
  './js/store.js',
  './js/tasks.js',
  './js/ink.js',
  './js/sync.js',
  './js/util.js',
  './js/exchange.js',
  './js/i18n.js',
  './js/community.js',
  './js/glyphs.js',
  './js/mathlayout.js',
  './js/variation.js',
  './js/solution.js',
  './js/compose.js',
  './js/textink.js',
  './js/compose-ui.js',
  './data/russian_core_tasks.json',
  './data/english_core_tasks.json',
  './data/math_glyphs.json',
  './vendor/katex/katex.mjs',
  './vendor/katex/katex.min.css',
  './vendor/katex/fonts/KaTeX_AMS-Regular.woff2',
  './vendor/katex/fonts/KaTeX_Caligraphic-Bold.woff2',
  './vendor/katex/fonts/KaTeX_Caligraphic-Regular.woff2',
  './vendor/katex/fonts/KaTeX_Fraktur-Bold.woff2',
  './vendor/katex/fonts/KaTeX_Fraktur-Regular.woff2',
  './vendor/katex/fonts/KaTeX_Main-Bold.woff2',
  './vendor/katex/fonts/KaTeX_Main-BoldItalic.woff2',
  './vendor/katex/fonts/KaTeX_Main-Italic.woff2',
  './vendor/katex/fonts/KaTeX_Main-Regular.woff2',
  './vendor/katex/fonts/KaTeX_Math-BoldItalic.woff2',
  './vendor/katex/fonts/KaTeX_Math-Italic.woff2',
  './vendor/katex/fonts/KaTeX_SansSerif-Bold.woff2',
  './vendor/katex/fonts/KaTeX_SansSerif-Italic.woff2',
  './vendor/katex/fonts/KaTeX_SansSerif-Regular.woff2',
  './vendor/katex/fonts/KaTeX_Script-Regular.woff2',
  './vendor/katex/fonts/KaTeX_Size1-Regular.woff2',
  './vendor/katex/fonts/KaTeX_Size2-Regular.woff2',
  './vendor/katex/fonts/KaTeX_Size3-Regular.woff2',
  './vendor/katex/fonts/KaTeX_Size4-Regular.woff2',
  './vendor/katex/fonts/KaTeX_Typewriter-Regular.woff2',
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
