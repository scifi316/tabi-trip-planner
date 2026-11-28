// Offline map packs: pre-download vector tiles + style assets into Cache Storage.
// The service worker serves them cache-first. Respects OpenFreeMap's offline guidance
// (≤ 3,000 tiles per download, ≤ 4 parallel requests).
import { state } from './store.js';

export const MAP_CACHE = 'tabi-map-v1';
const JAPAN = { w: 122.9, s: 24.0, e: 146.0, n: 45.6 };

const lon2x = (lon, z) => Math.floor(((lon + 180) / 360) * 2 ** z);
const lat2y = (lat, z) => {
  const r = (lat * Math.PI) / 180;
  return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z);
};
function tilesInBox(b, z) {
  const out = [];
  const x0 = lon2x(b.w, z), x1 = lon2x(b.e, z), y0 = lat2y(b.n, z), y1 = lat2y(b.s, z);
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) out.push(`${z}/${x}/${y}`);
  return out;
}
const around = (p, km) => {
  const dLat = km / 111, dLng = km / (111 * Math.cos((p.lat * Math.PI) / 180));
  return { w: p.lng - dLng, e: p.lng + dLng, s: p.lat - dLat, n: p.lat + dLat };
};

async function cachedJson(url) {
  const cache = await caches.open(MAP_CACHE);
  let res = await cache.match(url);
  if (!res) {
    res = await fetch(url, { mode: 'cors' });
    if (!res.ok) throw new Error(`Could not load ${url}`);
    await cache.put(url, res.clone());
  }
  return res.json();
}

// Gather style, sprite, glyph and tile template info for the styles we use.
async function styleAssets() {
  const styles = [...new Set([state.config.styleLight || 'https://tiles.openfreemap.org/styles/liberty', state.config.styleDark || 'https://tiles.openfreemap.org/styles/dark'])];
  const assets = new Set(styles);
  const templates = new Map(); // template -> maxzoom
  for (const url of styles) {
    const style = await cachedJson(url);
    const sprites = Array.isArray(style.sprite) ? style.sprite.map((s) => s.url) : style.sprite ? [style.sprite] : [];
    for (const s of sprites) for (const sfx of ['.json', '.png', '@2x.json', '@2x.png']) assets.add(s + sfx);
    const fonts = new Set();
    for (const l of style.layers || []) {
      const f = l.layout?.['text-font'];
      if (Array.isArray(f) && f.every((x) => typeof x === 'string')) fonts.add(f.join(','));
    }
    if (style.glyphs) for (const f of fonts) for (const r of ['0-255', '256-511', '8192-8447', '12288-12543', '65280-65535']) {
      assets.add(style.glyphs.replace('{fontstack}', encodeURIComponent(f)).replace('{range}', r));
    }
    for (const src of Object.values(style.sources || {})) {
      if (src.type !== 'vector') continue;
      const tj = src.url ? await cachedJson(src.url) : src;
      if (src.url) assets.add(src.url);
      for (const t of tj.tiles || []) templates.set(t, tj.maxzoom ?? 14);
    }
  }
  return { assets: [...assets], templates };
}

// The places "Save maps around all places" covers
const packPlaces = () => [...state.places.values()].filter((p) => p.status !== 'vetoed');
// Where each one is, to about 100 m: a place added or moved further than that needs saving again
const spot = (p) => `${(+p.lat).toFixed(3)},${(+p.lng).toFixed(3)}`;
const PACK_KEY = 'tabi.maps.pack';

// Ready for Japan (TA-36): has the places pack run on this device since the places last changed?
// Remembered when a run finishes with nothing left to fetch. 'fresh' | 'stale' | 'none'
export function noteStopsPackDone() {
  try { localStorage.setItem(PACK_KEY, JSON.stringify({ at: Date.now(), spots: [...new Set(packPlaces().map(spot))] })); } catch { /* storage full or private mode */ }
}
export function stopsPackState() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(PACK_KEY) || 'null'); } catch { /* ignore */ }
  if (!saved?.at || !Array.isArray(saved.spots)) return { state: 'none', at: null };
  const have = new Set(saved.spots);
  return { state: packPlaces().every((p) => have.has(spot(p))) ? 'fresh' : 'stale', at: saved.at };
}

// pack: 'stops' (overview of Japan + neighbourhood of every place) or 'view' (current map area)
export async function planPack(kind, { bounds, zoom } = {}) {
  const { assets, templates } = await styleAssets();
  const keys = new Set();
  const add = (list) => list.forEach((k) => keys.add(k));
  if (kind === 'stops') {
    for (let z = 0; z <= 7; z++) add(tilesInBox(JAPAN, z));
    const places = packPlaces()
      .sort((a, b) => (b.day ? 1 : 0) - (a.day ? 1 : 0) || (a.status === 'confirmed' ? -1 : 1));
    for (const p of places) {
      for (let z = 8; z <= 11; z++) add(tilesInBox(around(p, 4), z));
      for (let z = 12; z <= 14; z++) add(tilesInBox(around(p, 1.2), z));
    }
  } else {
    const z0 = Math.max(0, Math.floor(zoom) - 3);
    for (let z = z0; z <= 14; z++) add(tilesInBox(bounds, z));
  }
  const urls = [];
  for (const [tpl, maxz] of templates) {
    for (const k of keys) {
      const [z, x, y] = k.split('/');
      if (+z > maxz) continue;
      urls.push(tpl.replace('{z}', z).replace('{x}', x).replace('{y}', y));
    }
  }
  return { tileUrls: urls, assets };
}

export async function downloadPack(plan, { limit = 3000, onProgress, signal } = {}) {
  if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
  const cache = await caches.open(MAP_CACHE);
  const queue = [...plan.assets, ...plan.tileUrls];
  const todo = [];
  for (const u of queue) if (!(await cache.match(u))) todo.push(u);
  const capped = todo.slice(0, limit);
  let done = 0, failed = 0, i = 0;
  const worker = async () => {
    while (i < capped.length && !signal?.aborted) {
      const u = capped[i++];
      try {
        const r = await fetch(u, { mode: 'cors', signal });
        if (r.ok) await cache.put(u, r); else failed++;
      } catch { failed++; }
      done++;
      onProgress?.(done, capped.length);
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  return { downloaded: done - failed, failed, skipped: queue.length - todo.length, remaining: todo.length - capped.length };
}

export async function mapCacheInfo() {
  const cache = await caches.open(MAP_CACHE);
  const n = (await cache.keys()).length;
  const est = await navigator.storage?.estimate?.();
  return { entries: n, usage: est?.usage || 0, quota: est?.quota || 0 };
}
export async function clearMapCache() { await caches.delete(MAP_CACHE); try { localStorage.removeItem(PACK_KEY); } catch { /* ignore */ } }
