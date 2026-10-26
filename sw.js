/* Kotoba service worker.
   - App shell: cached on install, served stale-while-revalidate (bump CACHE_VERSION on each deploy).
   - cards.json: network-first, so a replaced file shows up on the next open; cached copy used offline.
   - Google Fonts: cache-first with background refresh.
*/
const CACHE_VERSION = 'kotoba-v1';
const SHELL_CACHE = `${CACHE_VERSION}-shell`;
const DATA_CACHE = `${CACHE_VERSION}-data`;
const FONT_CACHE = 'kotoba-fonts';

const SHELL = [
  './',
  './index.html',
  './styles.css',
  './app.js',
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
    await cache.addAll(SHELL);
    // warm the data cache so the very first offline launch still has cards
    try { const r = await fetch('./cards.json', { cache: 'no-store' }); if (r.ok) await (await caches.open(DATA_CACHE)).put('./cards.json', r); } catch {}
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

  // cards.json → network first
  if (url.origin === location.origin && url.pathname.endsWith('/cards.json')) {
    event.respondWith((async () => {
      const cache = await caches.open(DATA_CACHE);
      try {
        const fresh = await fetch(req, { cache: 'no-store' });
        if (fresh.ok) cache.put('./cards.json', fresh.clone());
        return fresh;
      } catch {
        const cached = await cache.match('./cards.json');
        return cached || new Response('{"version":"offline","decks":[]}', { headers: { 'Content-Type': 'application/json' } });
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
