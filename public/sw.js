// Service worker: app shell works offline; map assets are cache-first so saved areas
// keep working without a connection.
const VERSION = 'tabi-shell-v4';
const MAP_CACHE = 'tabi-map-v1';
const SHELL = [
  '/', '/index.html', '/app.css', '/manifest.webmanifest', '/icons/icon.svg', '/icons/icon-192.png',
  '/js/main.js', '/js/store.js', '/js/ui.js', '/js/map.js', '/js/itinerary.js', '/js/settings.js',
  '/js/place.js', '/js/add.js', '/js/parsers.js', '/js/location.js', '/js/offline.js',
  '/js/money.js', '/js/groups.js', '/js/tour.js', '/js/receipt.js', '/js/ocr.js', '/js/friends.js',
  '/js/notifications.js', '/js/photo.js', '/js/fx.js',
  '/vendor/maplibre-gl/maplibre-gl.mjs', '/vendor/maplibre-gl/maplibre-gl.css',
  '/vendor/maplibre-gl/maplibre-gl-worker.mjs',
  '/vendor/fflate/browser.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => Promise.all(SHELL.map((u) => c.add(u).catch(() => {})))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith('tabi-shell-') && k !== VERSION).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (url.origin === self.location.origin) {
    // Receipt images and profile photos never change (new ones get new URLs): keep them for offline viewing.
    if (/^\/api\/(attachments\/[\w-]+|avatars\/[a-f0-9]{64}\.\w+)$/.test(url.pathname)) {
      e.respondWith(caches.open('tabi-receipts').then(async (c) => (await c.match(req)) || fetch(req).then((r) => { if (r.ok) c.put(req, r.clone()); return r; })));
      return;
    }
    if (url.pathname.startsWith('/api/') || url.pathname === '/ws') return;
    // Network first so updates show up straight away; fall back to the cached shell offline.
    e.respondWith((async () => {
      try {
        const res = await fetch(req);
        if (res.ok) caches.open(VERSION).then((c) => c.put(req, res.clone()));
        return res;
      } catch {
        const cached = await caches.match(req, { ignoreSearch: req.mode === 'navigate' });
        return cached || (req.mode === 'navigate' ? caches.match('/index.html') : Response.error());
      }
    })());
    return;
  }

  // Cross-origin requests from the app are map styles, tiles, sprites and fonts: cache first.
  if (url.protocol === 'https:') {
    e.respondWith((async () => {
      const cache = await caches.open(MAP_CACHE);
      const hit = await cache.match(req.url);
      if (hit) return hit;
      try {
        const res = await fetch(req);
        if (res.ok && (res.type === 'cors' || res.type === 'basic')) cache.put(req.url, res.clone());
        return res;
      } catch {
        return new Response('', { status: 504, statusText: 'Offline' });
      }
    })());
  }
});
