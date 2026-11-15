// Tabi — self-hosted group itinerary server.
// HTTP (static + small REST API) and a WebSocket channel for live sync.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { openDb } from './db.js';
import { resolveLink, extractUrls, myMapsId, fetchMyMapsKml, photonAddress, geocode } from './links.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PORT = +(process.env.PORT || 8080);
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data'));
const TRUST_PROXY = /^(1|true|yes)$/i.test(process.env.TRUST_PROXY || '');
const CONFIG = {
  styleLight: process.env.MAP_STYLE_LIGHT || 'https://tiles.openfreemap.org/styles/liberty',
  styleDark: process.env.MAP_STYLE_DARK || 'https://tiles.openfreemap.org/styles/dark',
  offlineTileLimit: +(process.env.OFFLINE_TILE_LIMIT || 3000),
};

const db = openDb(DATA_DIR);
const UA = 'Tabi-trip-planner/1.0 (self-hosted group itinerary app)';

// ---------- helpers ----------
const now = () => Date.now();
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const newToken = () => crypto.randomBytes(32).toString('base64url');
const newCode = () => Array.from(crypto.randomBytes(6), (b) => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[b % 32]).join('');

function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(pw, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}
function checkPassword(pw, stored) {
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  const test = crypto.scryptSync(pw, salt, 64);
  return crypto.timingSafeEqual(test, Buffer.from(hash, 'hex'));
}

function getSetting(key, fallback) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? JSON.parse(row.value) : fallback;
}
function setSetting(key, value) {
  db.prepare('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, JSON.stringify(value));
}

const DEFAULT_TRIP = { name: 'Japan trip', start: null, end: null, timezone: 'Asia/Tokyo', autoConfirm: 0, vetoRule: 'single', joinCode: null };
const getTrip = () => ({ ...DEFAULT_TRIP, ...getSetting('trip', {}) });

const cache = {
  get(key) {
    const r = db.prepare('SELECT value, ts FROM geocache WHERE key = ?').get(key);
    if (!r || now() - r.ts > 14 * 864e5) return null;
    return JSON.parse(r.value);
  },
  set(key, value) {
    db.prepare('INSERT OR REPLACE INTO geocache(key, value, ts) VALUES(?, ?, ?)').run(key, JSON.stringify(value), now());
  },
};

const STATUSES = new Set(['suggested', 'maybe', 'confirmed', 'visited', 'skipped', 'vetoed']);
const VOTES = new Set(['up', 'down', 'veto']);
const COLORS = ['#E60012', '#F39700', '#00A672', '#009BBF', '#8F76D6', '#C1A470', '#00AC9B', '#E85298', '#0079C2', '#9CAEB7'];

const publicUser = (u) => ({ id: u.id, name: u.name, color: u.color, isAdmin: !!u.is_admin, shareLocation: !!u.share_location });
const listUsers = () => db.prepare('SELECT * FROM users ORDER BY id').all().map(publicUser);
const userCount = () => db.prepare('SELECT COUNT(*) n FROM users').get().n;

function placeRow(p) {
  const votes = {};
  for (const v of db.prepare('SELECT user_id, value FROM votes WHERE place_id = ?').all(p.id)) votes[v.user_id] = v.value;
  return {
    id: p.id, name: p.name, lat: p.lat, lng: p.lng, address: p.address, notes: p.notes, url: p.url, layer: p.layer,
    status: p.status, day: p.day, time: p.time, sort: p.sort, createdBy: p.created_by, createdAt: p.created_at,
    updatedBy: p.updated_by, updatedAt: p.updated_at, votes,
  };
}
const getPlace = (id) => {
  const p = db.prepare('SELECT * FROM places WHERE id = ?').get(id);
  return p ? placeRow(p) : null;
};

function listLocations() {
  const out = {};
  const rows = db.prepare('SELECT l.* FROM locations l JOIN users u ON u.id = l.user_id WHERE u.share_location = 1').all();
  for (const r of rows) out[r.user_id] = { lat: r.lat, lng: r.lng, acc: r.acc, heading: r.heading, speed: r.speed, batt: r.batt, ts: r.ts, source: r.source };
  return out;
}

function recentActivity(limit = 60) {
  return db.prepare('SELECT * FROM activity ORDER BY id DESC LIMIT ?').all(limit).map((a) => ({ id: a.id, ts: a.ts, userId: a.user_id, text: a.text }));
}

function logActivity(userId, text) {
  const ts = now();
  const r = db.prepare('INSERT INTO activity(ts, user_id, text) VALUES(?, ?, ?)').run(ts, userId, text);
  db.prepare('DELETE FROM activity WHERE id <= ?').run(Number(r.lastInsertRowid) - 500);
  broadcast({ t: 'activity', item: { id: Number(r.lastInsertRowid), ts, userId, text } });
}

function tripForClient(user) {
  const t = getTrip();
  return { name: t.name, start: t.start, end: t.end, timezone: t.timezone, autoConfirm: t.autoConfirm, vetoRule: t.vetoRule, joinCode: user ? t.joinCode : undefined };
}

function snapshot(user) {
  const me = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
  return {
    t: 'state',
    me: { ...publicUser(me), owntracksToken: me.owntracks_token },
    trip: tripForClient(user),
    users: listUsers(),
    places: db.prepare('SELECT * FROM places').all().map(placeRow),
    locations: listLocations(),
    online: onlineIds(),
    activity: recentActivity(),
    config: CONFIG,
    serverTime: now(),
  };
}

function createSession(userId) {
  const token = newToken();
  db.prepare('INSERT INTO sessions(token_hash, user_id, created_at, last_seen) VALUES(?, ?, ?, ?)').run(sha256(token), userId, now(), now());
  return token;
}
function userFromToken(token) {
  if (!token) return null;
  const s = db.prepare('SELECT * FROM sessions WHERE token_hash = ?').get(sha256(token));
  if (!s) return null;
  if (now() - s.last_seen > 3600e3) db.prepare('UPDATE sessions SET last_seen = ? WHERE token_hash = ?').run(now(), s.token_hash);
  return db.prepare('SELECT * FROM users WHERE id = ?').get(s.user_id) || null;
}

// ---------- tiny login rate limiter ----------
const attempts = new Map();
function rateLimited(ip) {
  const a = attempts.get(ip) || { n: 0, ts: now() };
  if (now() - a.ts > 10 * 60e3) { a.n = 0; a.ts = now(); }
  a.n++;
  attempts.set(ip, a);
  return a.n > 20;
}

// ---------- HTTP ----------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.map': 'application/json', '.txt': 'text/plain',
};
const STATIC_ROOTS = [
  ['/vendor/maplibre-gl/', path.join(ROOT, 'node_modules/maplibre-gl/dist')],
  ['/vendor/fflate/', path.join(ROOT, 'node_modules/fflate/esm')],
  ['/', path.join(ROOT, 'public')],
];

const COMPRESSIBLE = new Set(['.html', '.js', '.mjs', '.css', '.json', '.svg', '.webmanifest']);
const gzCache = new Map();

function send(res, status, body, headers = {}) {
  const isObj = typeof body === 'object' && !Buffer.isBuffer(body);
  res.writeHead(status, { 'Content-Type': isObj ? 'application/json' : 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(isObj ? JSON.stringify(body) : body);
}

function clientIp(req) {
  if (TRUST_PROXY) {
    const f = req.headers['x-forwarded-for'];
    if (f) return String(f).split(',')[0].trim();
  }
  return req.socket.remoteAddress;
}

async function readBody(req, limit = 2e6) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw Object.assign(new Error('Request too large'), { status: 413 });
    chunks.push(c);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { throw Object.assign(new Error('Invalid JSON'), { status: 400 }); }
}

function authUser(req, url) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : url.searchParams.get('token');
  return userFromToken(token);
}

function serveStatic(req, res, pathname) {
  for (const [prefix, dir] of STATIC_ROOTS) {
    if (!pathname.startsWith(prefix)) continue;
    const rel = decodeURIComponent(pathname.slice(prefix.length)) || 'index.html';
    const file = path.normalize(path.join(dir, rel));
    if (!file.startsWith(dir)) return send(res, 403, 'Forbidden');
    let target = file;
    if (!fs.existsSync(target) || fs.statSync(target).isDirectory()) {
      if (prefix !== '/' || path.extname(rel)) continue;
      target = path.join(dir, 'index.html'); // SPA fallback
    }
    const ext = path.extname(target);
    const isVendor = prefix.startsWith('/vendor');
    const headers = {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': isVendor ? 'public, max-age=604800' : 'no-cache',
      Vary: 'Accept-Encoding',
      ...(rel === 'sw.js' ? { 'Service-Worker-Allowed': '/' } : {}),
    };
    if (COMPRESSIBLE.has(ext) && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
      const st = fs.statSync(target);
      const key = target + ':' + st.mtimeMs;
      let gz = gzCache.get(key);
      if (!gz) { gz = zlib.gzipSync(fs.readFileSync(target), { level: 9 }); gzCache.set(key, gz); }
      res.writeHead(200, { ...headers, 'Content-Encoding': 'gzip', 'Content-Length': gz.length });
      return res.end(req.method === 'HEAD' ? undefined : gz);
    }
    res.writeHead(200, headers);
    fs.createReadStream(target).pipe(res);
    return;
  }
  send(res, 404, 'Not found');
}

function validName(n) {
  n = String(n || '').trim();
  return n.length >= 1 && n.length <= 24 ? n : null;
}

async function photon(pathAndQuery) {
  const key = 'p:' + pathAndQuery;
  const hit = cache.get(key);
  if (hit) return hit;
  const r = await fetch('https://photon.komoot.io' + pathAndQuery, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error('Search service returned ' + r.status);
  const j = await r.json();
  const results = (j.features || []).map((f) => ({
    name: f.properties.name || f.properties.street || 'Unnamed place',
    lat: f.geometry.coordinates[1],
    lng: f.geometry.coordinates[0],
    address: photonAddress(f.properties),
    kind: f.properties.osm_value || f.properties.type,
  }));
  cache.set(key, results);
  return results;
}

function toKml(places) {
  const esc = (s) => String(s ?? '').replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
  const groups = {};
  for (const p of places) (groups[p.day || 'Unscheduled'] ||= []).push(p);
  const folders = Object.keys(groups).sort().map((k) => `<Folder><name>${esc(k)}</name>${groups[k].map((p) =>
    `<Placemark><name>${esc(p.name)}</name><description>${esc([p.status, p.time, p.notes].filter(Boolean).join(' — '))}</description><Point><coordinates>${p.lng},${p.lat},0</coordinates></Point></Placemark>`).join('')}</Folder>`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>${esc(getTrip().name)}</name>${folders}</Document></kml>`;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  try {
    if (!p.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
      return serveStatic(req, res, p);
    }

    // ---- public endpoints ----
    if (p === '/api/status' && req.method === 'GET') {
      return send(res, 200, { setup: userCount() > 0, tripName: getTrip().name });
    }

    if (p === '/api/setup' && req.method === 'POST') {
      if (userCount() > 0) return send(res, 409, { error: 'This trip is already set up. Ask a friend for the invite link.' });
      const b = await readBody(req);
      const name = validName(b.name);
      if (!name) return send(res, 400, { error: 'Enter a name up to 24 characters.' });
      if (String(b.password || '').length < 4) return send(res, 400, { error: 'Use a password with at least 4 characters.' });
      setSetting('trip', { ...DEFAULT_TRIP, name: String(b.tripName || 'Japan trip').slice(0, 60), start: b.start || null, end: b.end || null, joinCode: newCode() });
      const r = db.prepare('INSERT INTO users(name, color, pass_hash, is_admin, created_at, owntracks_token) VALUES(?, ?, ?, 1, ?, ?)')
        .run(name, b.color || COLORS[0], hashPassword(b.password), now(), newToken().slice(0, 20));
      return send(res, 200, { token: createSession(Number(r.lastInsertRowid)) });
    }

    if (p === '/api/join' && req.method === 'POST') {
      if (rateLimited(clientIp(req))) return send(res, 429, { error: 'Too many attempts. Wait 10 minutes and try again.' });
      const b = await readBody(req);
      const trip = getTrip();
      if (!trip.joinCode || String(b.code || '').trim().toUpperCase() !== trip.joinCode) return send(res, 403, { error: 'That invite code is not valid. Ask for a fresh invite link.' });
      const name = validName(b.name);
      if (!name) return send(res, 400, { error: 'Enter a name up to 24 characters.' });
      if (String(b.password || '').length < 4) return send(res, 400, { error: 'Use a password with at least 4 characters.' });
      if (db.prepare('SELECT 1 FROM users WHERE name = ?').get(name)) return send(res, 409, { error: `Someone is already called ${name}. Pick another name, or sign in instead.` });
      const used = new Set(db.prepare('SELECT color FROM users').all().map((u) => u.color));
      const color = b.color || COLORS.find((c) => !used.has(c)) || COLORS[userCount() % COLORS.length];
      const r = db.prepare('INSERT INTO users(name, color, pass_hash, created_at, owntracks_token) VALUES(?, ?, ?, ?, ?)')
        .run(name, color, hashPassword(b.password), now(), newToken().slice(0, 20));
      const id = Number(r.lastInsertRowid);
      broadcast({ t: 'users', users: listUsers() });
      logActivity(id, `${name} joined the trip`);
      return send(res, 200, { token: createSession(id) });
    }

    if (p === '/api/login' && req.method === 'POST') {
      if (rateLimited(clientIp(req))) return send(res, 429, { error: 'Too many attempts. Wait 10 minutes and try again.' });
      const b = await readBody(req);
      const u = db.prepare('SELECT * FROM users WHERE name = ?').get(String(b.name || '').trim());
      if (!u || !checkPassword(String(b.password || ''), u.pass_hash)) return send(res, 401, { error: 'Name or password is wrong.' });
      return send(res, 200, { token: createSession(u.id) });
    }

    // OwnTracks HTTP mode: Basic auth with <name>:<owntracks token>
    if (p === '/api/owntracks' && req.method === 'POST') {
      const auth = String(req.headers.authorization || '');
      const [name, tok] = auth.startsWith('Basic ') ? Buffer.from(auth.slice(6), 'base64').toString().split(':') : [];
      const u = name && db.prepare('SELECT * FROM users WHERE name = ?').get(name);
      if (!u || !tok || !u.owntracks_token || tok !== u.owntracks_token) return send(res, 401, { error: 'Bad OwnTracks credentials' }, { 'WWW-Authenticate': 'Basic realm="tabi"' });
      const b = await readBody(req);
      if (b._type === 'location' && u.share_location) {
        updateLocation(u, { lat: b.lat, lng: b.lon, acc: b.acc, heading: b.cog, speed: b.vel != null ? b.vel / 3.6 : null, batt: b.batt, ts: b.tst ? b.tst * 1000 : now() }, 'owntracks');
      }
      // Reply with friends' positions so they also appear inside OwnTracks
      const locs = listLocations();
      const out = [];
      for (const f of listUsers()) {
        if (f.id === u.id || !locs[f.id]) continue;
        const l = locs[f.id];
        const tid = f.name.replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase() || 'XX';
        const topic = `owntracks/${f.name}/phone`;
        out.push({ _type: 'card', name: f.name, tid, topic });
        out.push({ _type: 'location', lat: l.lat, lon: l.lng, acc: Math.round(l.acc || 0), tst: Math.round(l.ts / 1000), tid, topic, ...(l.batt != null ? { batt: l.batt } : {}) });
      }
      return send(res, 200, out);
    }

    // ---- authenticated endpoints ----
    const user = authUser(req, url);
    if (!user) return send(res, 401, { error: 'Sign in again.' });

    if (p === '/api/logout' && req.method === 'POST') {
      const token = (req.headers.authorization || '').slice(7);
      db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
      return send(res, 200, { ok: true });
    }

    if (p === '/api/password' && req.method === 'POST') {
      const b = await readBody(req);
      if (!checkPassword(String(b.current || ''), user.pass_hash)) return send(res, 401, { error: 'Your current password is wrong.' });
      if (String(b.next || '').length < 4) return send(res, 400, { error: 'Use a password with at least 4 characters.' });
      db.prepare('UPDATE users SET pass_hash = ? WHERE id = ?').run(hashPassword(b.next), user.id);
      return send(res, 200, { ok: true });
    }

    if (p === '/api/search' && req.method === 'GET') {
      const q = String(url.searchParams.get('q') || '').trim().slice(0, 120);
      if (!q) return send(res, 200, { results: [] });
      const lat = parseFloat(url.searchParams.get('lat'));
      const lng = parseFloat(url.searchParams.get('lng'));
      const lang = url.searchParams.get('lang') === 'ja' ? 'default' : 'en';
      const bias = Number.isFinite(lat) && Number.isFinite(lng) ? `&lat=${lat.toFixed(2)}&lon=${lng.toFixed(2)}` : '';
      try {
        return send(res, 200, { results: await photon(`/api?limit=8&lang=${lang}&bbox=122.9,24.0,146.0,45.6&q=${encodeURIComponent(q)}${bias}`) });
      } catch (e) {
        return send(res, 502, { error: 'Search is unavailable right now. Paste a map link instead.', detail: e.message });
      }
    }

    if (p === '/api/reverse' && req.method === 'GET') {
      const lat = parseFloat(url.searchParams.get('lat'));
      const lng = parseFloat(url.searchParams.get('lng'));
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return send(res, 400, { error: 'Missing coordinates' });
      try {
        const r = await photon(`/reverse?lang=en&lat=${lat.toFixed(5)}&lon=${lng.toFixed(5)}`);
        return send(res, 200, { result: r[0] || null });
      } catch {
        return send(res, 200, { result: null });
      }
    }

    if (p === '/api/resolve' && req.method === 'POST') {
      const b = await readBody(req);
      const text = String(b.text || '');
      const urls = extractUrls(text);
      const items = urls.length ? urls : text.split(/\n+/).map((s) => s.trim()).filter(Boolean).slice(0, 50);
      const results = [];
      for (const u of items.slice(0, 100)) {
        if (myMapsId(u)) { results.push({ input: u, url: u, myMaps: myMapsId(u), ok: false }); continue; }
        results.push({ input: u, ...(await resolveLink(u, cache)) });
      }
      // If the share text had a title line before the URL (Google Maps app share), use it as the name
      if (urls.length === 1 && results[0]) {
        const title = text.split('\n').map((s) => s.trim()).find((s) => s && !s.includes('http'));
        if (title && !results[0].name) results[0].name = title.slice(0, 200);
        if (title && !results[0].ok && !results[0].myMaps) {
          const g = await geocode(title, cache);
          if (g) Object.assign(results[0], { lat: g.lat, lng: g.lng, address: g.address, approximate: true, ok: true });
        }
      }
      return send(res, 200, { results });
    }

    if (p === '/api/mymaps' && req.method === 'GET') {
      const mid = myMapsId(url.searchParams.get('url') || '') || url.searchParams.get('mid');
      if (!mid || !/^[\w-]+$/.test(mid)) return send(res, 400, { error: 'That does not look like a Google My Maps link. It should contain "mid=".' });
      try {
        const kml = await fetchMyMapsKml(mid);
        res.writeHead(200, { 'Content-Type': 'application/vnd.google-earth.kml+xml; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(kml);
      } catch (e) {
        return send(res, 502, { error: e.message });
      }
    }

    if (p === '/api/export' && req.method === 'GET') {
      const places = db.prepare('SELECT * FROM places ORDER BY day, sort').all().map(placeRow);
      const fmt = url.searchParams.get('format');
      if (fmt === 'kml') {
        res.writeHead(200, { 'Content-Type': 'application/vnd.google-earth.kml+xml', 'Content-Disposition': 'attachment; filename="tabi-trip.kml"' });
        return res.end(toKml(places));
      }
      return send(res, 200, { trip: tripForClient(null), users: listUsers(), places }, { 'Content-Disposition': 'attachment; filename="tabi-trip.json"' });
    }

    return send(res, 404, { error: 'Not found' });
  } catch (e) {
    console.error(e);
    return send(res, e.status || 500, { error: e.status ? e.message : 'Something went wrong on the server.' });
  }
});

// ---------- WebSocket ----------
const wss = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024 });
const clients = new Set();

function onlineIds() {
  return [...new Set([...clients].map((c) => c.user.id))];
}
function broadcast(msg, except) {
  const data = JSON.stringify(msg);
  for (const c of clients) if (c !== except && c.ws.readyState === 1) c.ws.send(data);
}
function broadcastPresence() {
  broadcast({ t: 'presence', online: onlineIds() });
}

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname !== '/ws') return socket.destroy();
  const user = userFromToken(url.searchParams.get('token'));
  if (!user) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    return socket.destroy();
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    const client = { ws, user, alive: true };
    clients.add(client);
    ws.send(JSON.stringify(snapshot(user)));
    broadcastPresence();
    ws.on('pong', () => { client.alive = true; });
    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      if (msg.t === 'ping') return ws.send('{"t":"pong"}');
      if (msg.t !== 'op') return;
      // Refresh user row (admin flag/colour can change)
      const fresh = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
      if (!fresh) { ws.send('{"t":"kicked"}'); return ws.close(); }
      client.user = fresh;
      let result;
      try {
        result = handleOp(fresh, msg.op, msg.data || {}, client) || { ok: true };
      } catch (e) {
        result = { ok: false, error: e.expose ? e.message : 'That change could not be saved.' };
        if (!e.expose) console.error(e);
      }
      if (msg.id) ws.send(JSON.stringify({ t: 'ack', id: msg.id, ...result }));
    });
    ws.on('close', () => {
      clients.delete(client);
      broadcastPresence();
    });
  });
});

setInterval(() => {
  for (const c of clients) {
    if (!c.alive) { c.ws.terminate(); clients.delete(c); continue; }
    c.alive = false;
    try { c.ws.ping(); } catch { /* ignore */ }
  }
}, 30000).unref();

const fail = (message) => { throw Object.assign(new Error(message), { expose: true }); };
const str = (v, max) => (v == null || v === '' ? null : String(v).slice(0, max));
const isDay = (d) => d == null || /^\d{4}-\d{2}-\d{2}$/.test(d);
const isTime = (t) => t == null || /^\d{2}:\d{2}$/.test(t);

function cleanPlace(d, existing = {}) {
  const p = { ...existing };
  if ('name' in d) p.name = str(d.name, 200) || 'Untitled place';
  if ('lat' in d) p.lat = +d.lat;
  if ('lng' in d) p.lng = +d.lng;
  if ('address' in d) p.address = str(d.address, 300);
  if ('notes' in d) p.notes = str(d.notes, 5000);
  if ('url' in d) p.url = str(d.url, 2000);
  if ('layer' in d) p.layer = str(d.layer, 100);
  if ('status' in d) { if (!STATUSES.has(d.status)) fail('Unknown status'); p.status = d.status; }
  if ('day' in d) { const v = d.day || null; if (!isDay(v)) fail('Day must look like 2026-03-14'); p.day = v; }
  if ('time' in d) { const v = d.time || null; if (!isTime(v)) fail('Time must look like 14:30'); p.time = v; }
  if ('sort' in d) p.sort = Number.isFinite(+d.sort) ? +d.sort : 0;
  if (!Number.isFinite(p.lat) || !Number.isFinite(p.lng) || Math.abs(p.lat) > 90 || Math.abs(p.lng) > 180) fail('That place has no valid location');
  return p;
}

function insertPlace(user, d) {
  if (!/^[\w-]{6,64}$/.test(String(d.id || ''))) fail('Bad place id');
  if (db.prepare('SELECT 1 FROM places WHERE id = ?').get(d.id)) return null; // idempotent replay
  const p = cleanPlace({ status: 'suggested', ...d });
  const ts = now();
  db.prepare(`INSERT INTO places(id, name, lat, lng, address, notes, url, layer, status, day, time, sort, created_by, created_at, updated_by, updated_at)
    VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    d.id, p.name, p.lat, p.lng, p.address ?? null, p.notes ?? null, p.url ?? null, p.layer ?? null, p.status || 'suggested',
    p.day ?? null, p.time ?? null, p.sort ?? ts, user.id, ts, user.id, ts);
  return getPlace(d.id);
}

function applyVoteRules(placeId) {
  const trip = getTrip();
  const place = db.prepare('SELECT * FROM places WHERE id = ?').get(placeId);
  if (!place) return;
  const votes = db.prepare('SELECT value FROM votes WHERE place_id = ?').all(placeId).map((v) => v.value);
  const members = userCount();
  const vetoes = votes.filter((v) => v === 'veto').length;
  const ups = votes.filter((v) => v === 'up').length;
  let next = null;
  if (place.status !== 'vetoed' && vetoes > 0 && (trip.vetoRule === 'single' || (trip.vetoRule === 'majority' && vetoes > members / 2))) next = 'vetoed';
  else if (trip.autoConfirm > 0 && ups >= trip.autoConfirm && (place.status === 'suggested' || place.status === 'maybe')) next = 'confirmed';
  if (next) {
    db.prepare('UPDATE places SET status = ?, updated_at = ? WHERE id = ?').run(next, now(), placeId);
    return next;
  }
}

function updateLocation(user, l, source) {
  const lat = +l.lat, lng = +l.lng;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
  const n = (v) => (v == null || v === '' || !Number.isFinite(+v) ? null : +v);
  const loc = {
    lat, lng,
    acc: n(l.acc),
    heading: n(l.heading),
    speed: n(l.speed),
    batt: n(l.batt) == null ? null : Math.round(n(l.batt)),
    ts: Math.min(+l.ts || now(), now()),
    source,
  };
  db.prepare(`INSERT INTO locations(user_id, lat, lng, acc, heading, speed, batt, ts, source) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET lat=excluded.lat, lng=excluded.lng, acc=excluded.acc, heading=excluded.heading, speed=excluded.speed,
    batt=COALESCE(excluded.batt, locations.batt), ts=excluded.ts, source=excluded.source`).run(user.id, loc.lat, loc.lng, loc.acc, loc.heading, loc.speed, loc.batt, loc.ts, source);
  broadcast({ t: 'loc', userId: user.id, loc });
}

const STATUS_WORDS = { suggested: 'moved back to suggested', maybe: 'marked as maybe', confirmed: 'confirmed', visited: 'marked as visited', skipped: 'skipped', vetoed: 'vetoed' };

function handleOp(user, op, d, client) {
  const requireAdmin = () => { if (!user.is_admin) fail('Only trip admins can do that.'); };
  switch (op) {
    case 'place.add': {
      const place = insertPlace(user, d.place || {});
      if (place) {
        broadcast({ t: 'place', place });
        logActivity(user.id, `${user.name} added ${place.name}`);
      }
      return { ok: true };
    }
    case 'place.bulk': {
      const list = Array.isArray(d.places) ? d.places.slice(0, 2000) : [];
      const added = [];
      db.exec('BEGIN');
      try {
        for (const item of list) {
          try { const p = insertPlace(user, item); if (p) added.push(p); } catch { /* skip bad rows */ }
        }
        db.exec('COMMIT');
      } catch (e) { db.exec('ROLLBACK'); throw e; }
      if (added.length) {
        broadcast({ t: 'places', places: added });
        logActivity(user.id, `${user.name} imported ${added.length} place${added.length === 1 ? '' : 's'}${d.source ? ` from ${String(d.source).slice(0, 80)}` : ''}`);
      }
      return { ok: true, added: added.length };
    }
    case 'place.update': {
      const row = db.prepare('SELECT * FROM places WHERE id = ?').get(d.id);
      if (!row) fail('That place was deleted.');
      const patch = d.patch || {};
      const p = cleanPlace(patch, row);
      db.prepare(`UPDATE places SET name=?, lat=?, lng=?, address=?, notes=?, url=?, layer=?, status=?, day=?, time=?, sort=?, updated_by=?, updated_at=? WHERE id=?`)
        .run(p.name, p.lat, p.lng, p.address ?? null, p.notes ?? null, p.url ?? null, p.layer ?? null, p.status, p.day ?? null, p.time ?? null, p.sort, user.id, now(), d.id);
      if (patch.status && patch.status !== row.status) {
        if (row.status === 'vetoed') db.prepare("DELETE FROM votes WHERE place_id = ? AND value = 'veto'").run(d.id);
        logActivity(user.id, `${user.name} ${STATUS_WORDS[patch.status]} ${p.name}`);
      } else if ('day' in patch && patch.day !== row.day) {
        logActivity(user.id, patch.day ? `${user.name} moved ${p.name} to ${patch.day}` : `${user.name} unscheduled ${p.name}`);
      }
      broadcast({ t: 'place', place: getPlace(d.id) });
      return { ok: true };
    }
    case 'place.reorder': {
      const ids = Array.isArray(d.ids) ? d.ids : [];
      const stmt = db.prepare('UPDATE places SET sort = ?, updated_at = ? WHERE id = ?');
      ids.forEach((id, i) => stmt.run(i + 1, now(), String(id)));
      broadcast({ t: 'places', places: ids.map(getPlace).filter(Boolean) });
      return { ok: true };
    }
    case 'place.delete': {
      const row = db.prepare('SELECT * FROM places WHERE id = ?').get(d.id);
      if (!row) return { ok: true };
      db.prepare('DELETE FROM places WHERE id = ?').run(d.id);
      broadcast({ t: 'place.del', id: d.id });
      logActivity(user.id, `${user.name} removed ${row.name}`);
      return { ok: true };
    }
    case 'place.vote': {
      const row = db.prepare('SELECT * FROM places WHERE id = ?').get(d.id);
      if (!row) fail('That place was deleted.');
      if (d.value == null) db.prepare('DELETE FROM votes WHERE place_id = ? AND user_id = ?').run(d.id, user.id);
      else {
        if (!VOTES.has(d.value)) fail('Unknown vote');
        db.prepare('INSERT INTO votes(place_id, user_id, value) VALUES(?, ?, ?) ON CONFLICT(place_id, user_id) DO UPDATE SET value = excluded.value').run(d.id, user.id, d.value);
      }
      const changed = applyVoteRules(d.id);
      if (d.value === 'veto') logActivity(user.id, `${user.name} vetoed ${row.name}`);
      if (changed === 'confirmed') logActivity(null, `${row.name} was confirmed by votes`);
      broadcast({ t: 'place', place: getPlace(d.id) });
      return { ok: true };
    }
    case 'loc.update': {
      if (!user.share_location) return { ok: false, error: 'Location sharing is off.' };
      updateLocation(user, d, 'app');
      return null;
    }
    case 'loc.share': {
      const on = d.on ? 1 : 0;
      db.prepare('UPDATE users SET share_location = ? WHERE id = ?').run(on, user.id);
      if (!on) {
        db.prepare('DELETE FROM locations WHERE user_id = ?').run(user.id);
        broadcast({ t: 'loc', userId: user.id, loc: null });
      }
      broadcast({ t: 'users', users: listUsers() });
      return { ok: true };
    }
    case 'user.update': {
      if (d.color && /^#[0-9a-f]{6}$/i.test(d.color)) db.prepare('UPDATE users SET color = ? WHERE id = ?').run(d.color, user.id);
      if (d.name) {
        const name = validName(d.name);
        if (!name) fail('Enter a name up to 24 characters.');
        const clash = db.prepare('SELECT id FROM users WHERE name = ? AND id != ?').get(name, user.id);
        if (clash) fail(`Someone is already called ${name}.`);
        db.prepare('UPDATE users SET name = ? WHERE id = ?').run(name, user.id);
      }
      broadcast({ t: 'users', users: listUsers() });
      return { ok: true };
    }
    case 'user.owntracksReset': {
      const tok = newToken().slice(0, 20);
      db.prepare('UPDATE users SET owntracks_token = ? WHERE id = ?').run(tok, user.id);
      return { ok: true, token: tok };
    }
    case 'user.remove': {
      requireAdmin();
      if (+d.id === user.id) fail('You cannot remove yourself.');
      const target = db.prepare('SELECT * FROM users WHERE id = ?').get(+d.id);
      if (!target) return { ok: true };
      db.prepare('DELETE FROM users WHERE id = ?').run(target.id);
      for (const c of clients) if (c.user.id === target.id) { c.ws.send('{"t":"kicked"}'); c.ws.close(); }
      broadcast({ t: 'users', users: listUsers() });
      broadcast({ t: 'loc', userId: target.id, loc: null });
      logActivity(user.id, `${user.name} removed ${target.name} from the trip`);
      return { ok: true };
    }
    case 'user.admin': {
      requireAdmin();
      if (+d.id === user.id && !d.on) fail('Make someone else an admin first, then they can remove your admin role.');
      db.prepare('UPDATE users SET is_admin = ? WHERE id = ?').run(d.on ? 1 : 0, +d.id);
      broadcast({ t: 'users', users: listUsers() });
      return { ok: true };
    }
    case 'trip.update': {
      requireAdmin();
      const t = getTrip();
      if ('name' in d) t.name = str(d.name, 60) || 'Japan trip';
      if ('start' in d) { if (!isDay(d.start || null)) fail('Start date is not valid'); t.start = d.start || null; }
      if ('end' in d) { if (!isDay(d.end || null)) fail('End date is not valid'); t.end = d.end || null; }
      if (t.start && t.end && t.end < t.start) fail('The trip has to end after it starts.');
      if ('autoConfirm' in d) t.autoConfirm = Math.max(0, Math.min(50, parseInt(d.autoConfirm, 10) || 0));
      if ('vetoRule' in d) { if (!['single', 'majority', 'off'].includes(d.vetoRule)) fail('Unknown veto rule'); t.vetoRule = d.vetoRule; }
      setSetting('trip', t);
      for (const c of clients) c.ws.readyState === 1 && c.ws.send(JSON.stringify({ t: 'trip', trip: tripForClient(c.user) }));
      return { ok: true };
    }
    case 'trip.newCode': {
      requireAdmin();
      const t = getTrip();
      t.joinCode = newCode();
      setSetting('trip', t);
      for (const c of clients) c.ws.readyState === 1 && c.ws.send(JSON.stringify({ t: 'trip', trip: tripForClient(c.user) }));
      return { ok: true };
    }
    default:
      fail('Unknown action');
  }
}

server.listen(PORT, () => {
  console.log(`Tabi is running on http://localhost:${PORT}  (data: ${DATA_DIR})`);
  if (userCount() === 0) console.log('No trip yet: open the app in a browser to create it.');
});
