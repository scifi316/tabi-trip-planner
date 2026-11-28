// Service worker: app shell works offline; map assets are cache-first so saved areas
// keep working without a connection.
const VERSION = 'tabi-shell-v11';
const MAP_CACHE = 'tabi-map-v1';
const SHELL = [
  '/', '/index.html', '/app.css', '/manifest.webmanifest', '/icons/icon.svg', '/icons/icon-192.png',
  '/js/main.js', '/js/store.js', '/js/ui.js', '/js/map.js', '/js/cluster-motion.js', '/js/itinerary.js', '/js/settings.js',
  '/js/place.js', '/js/add.js', '/js/parsers.js', '/js/location.js', '/js/offline.js',
  '/js/sheetdrag.js',
  '/js/navbar.js',
  '/js/zoomlock.js', '/js/photozoom.js',
  '/changelog.json', '/js/changelog.js', '/js/whatsnew.js',
  '/js/devview.js',
  '/js/memarker.js',
  '/js/money.js', '/js/groups.js', '/js/tour.js', '/js/receipt.js', '/js/ocr.js', '/js/friends.js',
  '/js/notifications.js', '/js/photo.js', '/js/fx.js', '/js/owntracks.js', '/js/account.js', '/js/tooltip.js', '/js/notifpage.js', '/js/reactions.js', '/js/push.js', '/js/emoji.js', '/js/photos.js', '/js/stays.js', '/js/chat.js', '/js/android.js', '/js/basemap.js',
  '/js/ready.js', '/js/readycheck.js',
  '/vendor/maplibre-gl/maplibre-gl.mjs', '/vendor/maplibre-gl/maplibre-gl.css',
  '/vendor/maplibre-gl/maplibre-gl-worker.mjs',
  '/vendor/fflate/browser.js',
];

// Each file is fetched on its own with a time limit, and only good responses are kept: one missing
// or slow file (a deploy that renamed something) must never stop the new version from installing.
self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const c = await caches.open(VERSION);
    await Promise.all(SHELL.map(async (u) => {
      try {
        const r = await fetch(u, { cache: 'no-cache', signal: AbortSignal.timeout(15000) });
        if (r.ok) await c.put(u, r);
      } catch { /* offline or gone: the network-first fetch handler copes */ }
    }));
    await self.skipWaiting();
  })());
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
    if (/^\/api\/(attachments\/[\w-]+|avatars\/[a-f0-9]{64}\.\w+|photos\/f\/[a-f0-9]{64}\.\w+|chat\/f\/[a-f0-9]{64}\.\w+|emoji\/[a-f0-9]{64}\.\w+)$/.test(url.pathname)) {
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

  // GIFs from KLIPY load straight from KLIPY every time: its terms don't allow keeping copies.
  if (/(^|\.)klipy\.com$/.test(url.hostname)) return;
  // Satellite photos (GSI, Japan) also load live: GSI's terms cover live use, not keeping copies.
  if (url.hostname === 'cyberjapandata.gsi.go.jp') return;
  // Other cross-origin requests from the app are map styles, tiles, sprites and fonts: cache first.
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

// ---------- Web Push: notifications while Tabi is closed ----------
// The server only pushes when none of your Tabi windows is on screen. Every push must show a
// notification (browsers require it), so even a malformed one shows something.
function parsePush(text) {
  try { return text ? JSON.parse(text) : {}; } catch { return { body: text || '' }; }
}
async function showPush(d) {
    await self.registration.showNotification(d.title || 'Tabi', {
      body: d.body || 'Something changed in your trip.',
      tag: d.tag || undefined, // the same notification updated (a count going up) replaces itself
      icon: '/icons/icon-192.png', badge: '/icons/badge-96.png',
      timestamp: d.ts || Date.now(),
      data: { url: d.url || '/' },
    });
    if (typeof d.unread === 'number' && self.navigator.setAppBadge) {
      try { await (d.unread ? self.navigator.setAppBadge(d.unread) : self.navigator.clearAppBadge()); } catch { /* not supported */ }
    }
}
self.addEventListener('push', (e) => {
  let text = '';
  try { text = e.data ? e.data.text() : ''; } catch { /* unreadable */ }
  e.waitUntil(showPush(parsePush(text)));
});

// Tapping it opens Tabi at what it's about (or focuses Tabi if it's already open).
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = new URL(e.notification.data?.url || '/', self.location.origin);
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const win = wins.find((w) => new URL(w.url).origin === self.location.origin);
    if (win) {
      try { await win.focus(); } catch { /* some browsers refuse */ }
      win.postMessage({ t: 'open-notif', id: url.searchParams.get('n') });
      return;
    }
    await self.clients.openWindow(url.href);
  })());
});

// Browsers sometimes renew a subscription on their own: tell the server about the new one.
self.addEventListener('pushsubscriptionchange', (e) => {
  e.waitUntil((async () => {
    try {
      const { publicKey } = await (await fetch('/api/push/key', { credentials: 'same-origin' })).json();
      const sub = e.newSubscription || await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: publicKey });
      await fetch('/api/push/subscribe', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscription: sub.toJSON() }) });
    } catch { /* the app re-registers next time it opens */ }
  })());
});
