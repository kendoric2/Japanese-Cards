/* Kotoba service worker.
   - App shell: cached on install, served stale-while-revalidate (bump CACHE_VERSION on each deploy).
   - cards.json: network-first, so a replaced file shows up on the next open; cached copy used offline.
   - Google Fonts: cache-first with background refresh.
*/
const CACHE_VERSION = 'kotoba-v11';
const SHELL_CACHE = `${CACHE_VERSION}-shell`;
const DATA_CACHE = `${CACHE_VERSION}-data`;
const FONT_CACHE = 'kotoba-fonts';

const SHELL = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './kana-data.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
  './icons/favicon.svg',
];

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    // cache: 'reload' bypasses the browser's HTTP cache so a fresh deploy is never precached stale
    await cache.addAll(SHELL.map(u => new Request(u, { cache: 'reload' })));
    // warm the data cache so the very first offline launch still has cards
    const data = await caches.open(DATA_CACHE);
    for (const f of ['./cards.json', './lessons.json', './grammar.json']) {
      try { const r = await fetch(f, { cache: 'no-store' }); if (r.ok) await data.put(f, r); } catch {}
    }
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== SHELL_CACHE && k !== DATA_CACHE && k !== FONT_CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // data files (cards, lessons, grammar) → network first, cached copy offline
  const dataFile = ['/cards.json', '/lessons.json', '/grammar.json'].find(f => url.pathname.endsWith(f));
  if (url.origin === location.origin && dataFile) {
    event.respondWith((async () => {
      const cache = await caches.open(DATA_CACHE);
      const key = '.' + dataFile;
      try {
        const fresh = await fetch(req, { cache: 'no-store' });
        if (fresh.ok) cache.put(key, fresh.clone());
        return fresh;
      } catch {
        const cached = await cache.match(key);
        return cached || new Response('{"version":"offline","decks":[],"lessons":[],"entries":[]}', { headers: { 'Content-Type': 'application/json' } });
      }
    })());
    return;
  }

  // fonts → cache first, refresh in background
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    event.respondWith(staleWhileRevalidate(req, FONT_CACHE));
    return;
  }

  // same-origin shell → stale-while-revalidate; navigations fall back to index.html
  if (url.origin === location.origin) {
    event.respondWith((async () => {
      const res = await staleWhileRevalidate(req, SHELL_CACHE);
      if (res) return res;
      if (req.mode === 'navigate') return (await caches.match('./index.html')) || Response.error();
      return Response.error();
    })());
  }
});

async function staleWhileRevalidate(req, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(req, { ignoreSearch: true });
  const network = fetch(req).then(res => { if (res && res.ok) cache.put(req, res.clone()); return res; }).catch(() => null);
  return cached || (await network);
}
