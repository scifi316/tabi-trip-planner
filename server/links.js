// Turns pasted map links (Google Maps, Apple Maps, OSM, geo: URIs, raw coordinates)
// into { name, lat, lng, url }. Short links are followed server-side.

const UA = 'Tabi-trip-planner/1.0 (self-hosted group itinerary app)';
const num = '(-?\\d{1,3}(?:\\.\\d+)?)';

export function extractUrls(text) {
  const urls = String(text || '').match(/(https?:\/\/[^\s<>"']+|geo:[^\s<>"']+)/gi) || [];
  return [...new Set(urls.map((u) => u.replace(/[),.;]+$/, '')))];
}

function validLatLng(lat, lng) {
  return Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && !(lat === 0 && lng === 0);
}

function decode(s) {
  try { return decodeURIComponent(String(s).replace(/\+/g, ' ')).trim(); } catch { return String(s).trim(); }
}

// Pure parsing: no network. Returns { lat, lng, name, query } where any may be missing.
export function parseMapUrl(raw) {
  const out = {};
  let s = String(raw || '').trim();
  if (!s) return out;

  // Plain "lat, lng"
  const plain = s.match(new RegExp(`^${num}\\s*,\\s*${num}$`));
  if (plain) {
    const lat = +plain[1], lng = +plain[2];
    if (validLatLng(lat, lng)) return { lat, lng };
  }

  // geo:lat,lng?q=name
  const geo = s.match(new RegExp(`^geo:${num},${num}`, 'i'));
  if (geo) {
    out.lat = +geo[1]; out.lng = +geo[2];
    const q = s.match(/[?&]q=([^&]+)/);
    if (q) {
      const qq = decode(q[1]);
      const named = qq.match(/\(([^)]+)\)/);
      if (named) out.name = named[1];
    }
    return out;
  }

  // Google consent interstitial wraps the real URL in ?continue=
  const cont = s.match(/[?&]continue=([^&]+)/);
  if (/consent\.google\./.test(s) && cont) s = decode(cont[1]);

  // Google: !3dLAT!4dLNG is the actual place pin (most precise)
  const pin = [...s.matchAll(new RegExp(`!3d${num}!4d${num}`, 'g'))].pop();
  if (pin) { out.lat = +pin[1]; out.lng = +pin[2]; }

  // Google place name: /maps/place/NAME/...
  const place = s.match(/\/maps\/place\/([^/@?]+)/);
  if (place) {
    const n = decode(place[1]);
    if (!new RegExp(`^${num},\\s*${num}$`).test(n)) out.name = n;
    else if (out.lat == null) { const [a, b] = n.split(','); out.lat = +a; out.lng = +b; }
  }

  // Query params that commonly hold coordinates
  for (const key of ['coordinate', 'll', 'q', 'query', 'destination', 'daddr', 'center', 'sll']) {
    const m = s.match(new RegExp(`[?&]${key}=([^&#]+)`));
    if (!m) continue;
    const v = decode(m[1]);
    const c = v.match(new RegExp(`^(?:loc:)?${num}\\s*,\\s*${num}`));
    if (c && out.lat == null) { out.lat = +c[1]; out.lng = +c[2]; }
    else if (!c && ['q', 'query', 'destination', 'daddr'].includes(key) && !out.name) out.query = v;
  }
  // Apple Maps: name= / address=
  const aName = s.match(/[?&]name=([^&#]+)/);
  if (aName && /apple\.com/.test(s)) out.name = decode(aName[1]);
  const aAddr = s.match(/[?&]address=([^&#]+)/);
  if (aAddr && /apple\.com/.test(s)) out.address = decode(aAddr[1]);

  // OpenStreetMap: ?mlat=&mlon= or #map=z/lat/lng
  const ml = s.match(new RegExp(`[?&]mlat=${num}.*[?&]mlon=${num}`));
  if (ml && out.lat == null) { out.lat = +ml[1]; out.lng = +ml[2]; }
  const hash = s.match(new RegExp(`#map=\\d+(?:\\.\\d+)?/${num}/${num}`));
  if (hash && out.lat == null) { out.lat = +hash[1]; out.lng = +hash[2]; }

  // Google viewport centre /@lat,lng,zoom (least precise; only if nothing better)
  const at = s.match(new RegExp(`/@${num},${num}`));
  if (at && out.lat == null) { out.lat = +at[1]; out.lng = +at[2]; }

  if (out.lat != null && !validLatLng(out.lat, out.lng)) { delete out.lat; delete out.lng; }
  if (out.query && !out.name) out.name = out.query;
  return out;
}

async function fetchWithRedirects(url, max = 8) {
  let current = url;
  const chain = [url];
  for (let i = 0; i < max; i++) {
    const res = await fetch(current, {
      redirect: 'manual',
      headers: { 'User-Agent': 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36', 'Accept-Language': 'en' },
      signal: AbortSignal.timeout(10000),
    });
    const loc = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && loc) {
      current = new URL(loc, current).toString();
      chain.push(current);
      continue;
    }
    const body = res.headers.get('content-type')?.includes('text/html') ? (await res.text()).slice(0, 400000) : '';
    return { finalUrl: current, chain, body };
  }
  return { finalUrl: current, chain, body: '' };
}

export async function geocode(query, cache) {
  const key = 'q:' + query.toLowerCase();
  const hit = cache?.get(key);
  if (hit) return hit;
  // Photon (komoot), biased to Japan
  const u = `https://photon.komoot.io/api?limit=1&lang=en&bbox=122.9,24.0,146.0,45.6&q=${encodeURIComponent(query)}`;
  try {
    const r = await fetch(u, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(8000) });
    const j = await r.json();
    const f = j.features?.[0];
    if (f) {
      const res = { lat: f.geometry.coordinates[1], lng: f.geometry.coordinates[0], address: photonAddress(f.properties) };
      cache?.set(key, res);
      return res;
    }
  } catch { /* fall through */ }
  return null;
}

export function photonAddress(p = {}) {
  return [p.street && (p.housenumber ? `${p.housenumber} ${p.street}` : p.street), p.district || p.locality, p.city || p.county, p.state]
    .filter(Boolean)
    .filter((v, i, a) => a.indexOf(v) === i)
    .join(', ');
}

// Full resolution: parse, follow short links, scrape page as a fallback, geocode the name last.
export async function resolveLink(raw, cache) {
  const url = String(raw).trim();
  let info = parseMapUrl(url);
  let finalUrl = url;

  if (info.lat == null && /^https?:/i.test(url)) {
    try {
      const { finalUrl: f, chain, body } = await fetchWithRedirects(url);
      finalUrl = f;
      for (const u of chain.slice(1).reverse()) {
        const p = parseMapUrl(u);
        if (info.lat == null && p.lat != null) { info.lat = p.lat; info.lng = p.lng; }
        if (!info.name && p.name) info.name = p.name;
        if (!info.address && p.address) info.address = p.address;
        if (!info.query && p.query) info.query = p.query;
      }
      if (info.lat == null && body) {
        // Google place pages embed a static-map preview with the centre coordinates
        const m = body.match(new RegExp(`center=${num}(?:%2C|,)${num}`)) || body.match(new RegExp(`\\[null,null,${num},${num}\\]`));
        if (m) { info.lat = +m[1]; info.lng = +m[2]; }
        const og = body.match(/<meta[^>]+(?:property|itemprop)="(?:og:title|name)"[^>]+content="([^"]+)"/i);
        if (og && !info.name) info.name = og[1].replace(/\s*[·-]\s*Google Maps$/, '').trim();
      }
    } catch (e) {
      info.error = e.name === 'TimeoutError' ? 'That link took too long to open.' : 'The Tabi server could not open that link. Check that it has internet access.';
    }
  }

  if (info.lat == null && (info.name || info.query)) {
    const g = await geocode(info.query || info.name, cache);
    if (g) Object.assign(info, { lat: g.lat, lng: g.lng, address: info.address || g.address, approximate: true });
  }
  // Coordinates but no name (OSM / raw coordinates): ask Photon what is there
  if (info.lat != null && !info.name) {
    const r = await reverse(info.lat, info.lng, cache);
    if (r) { info.name = r.name; info.address = info.address || r.address; }
  }
  return { ...info, url: finalUrl.length < 2000 ? finalUrl : url, ok: info.lat != null };
}

export async function reverse(lat, lng, cache) {
  const key = `r:${lat.toFixed(5)},${lng.toFixed(5)}`;
  const hit = cache?.get(key);
  if (hit) return hit;
  try {
    const r = await fetch(`https://photon.komoot.io/reverse?lang=en&lat=${lat}&lon=${lng}`, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(6000) });
    const f = (await r.json()).features?.[0];
    if (!f) return null;
    const res = { name: f.properties.name || f.properties.street || null, address: photonAddress(f.properties) };
    if (!res.name) return null;
    cache?.set(key, res);
    return res;
  } catch { return null; }
}

export function myMapsId(url) {
  const m = String(url).match(/[?&]mid=([\w-]+)/);
  return m ? m[1] : null;
}

export async function fetchMyMapsKml(mid) {
  let r;
  try {
    r = await fetch(`https://www.google.com/maps/d/kml?mid=${encodeURIComponent(mid)}&forcekml=1`, {
      headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(20000),
    });
  } catch {
    throw new Error('The Tabi server could not reach Google to download the map. Check that it has internet access, or export the map as KML and import the file.');
  }
  if (!r.ok) throw new Error(`Google returned ${r.status}. Make sure the map is shared as "Anyone with the link can view".`);
  const text = await r.text();
  if (!text.includes('<kml')) throw new Error('That link did not return a My Maps file. Check that the map is shared publicly or by link.');
  return text;
}
