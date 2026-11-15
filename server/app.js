// Tabi application: HTTP API, static files and the WebSocket hub.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { WebSocketServer } from 'ws';
import { resolveLink, extractUrls, myMapsId, fetchMyMapsKml, photonAddress, geocode } from './links.js';
import { createAuth } from './auth.js';
import { cleanExpense, CURRENCIES } from './money.js';

export function createApp({ db, blobs, root, env = process.env, getHealth = () => ({}) }) {
  const TRUST_PROXY = /^(1|true|yes)$/i.test(env.TRUST_PROXY || '');
  const CONFIG = {
    styleLight: env.MAP_STYLE_LIGHT || 'https://tiles.openfreemap.org/styles/liberty',
    styleDark: env.MAP_STYLE_DARK || 'https://tiles.openfreemap.org/styles/dark',
    offlineTileLimit: +(env.OFFLINE_TILE_LIMIT || 3000),
    currencies: Object.keys(CURRENCIES),
  };
  const UA = 'Tabi-trip-planner/1.0 (self-hosted group itinerary app)';
  const auth = createAuth({ db, env, trustProxy: TRUST_PROXY });

  // ---------- helpers ----------
  const now = () => Date.now();
  const newToken = () => crypto.randomBytes(32).toString('base64url');
  const newCode = () => Array.from(crypto.randomBytes(6), (b) => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[b % 32]).join('');
  const hashPassword = (pw) => { const salt = crypto.randomBytes(16).toString('hex'); return `${salt}:${crypto.scryptSync(pw, salt, 64).toString('hex')}`; };
  function checkPassword(pw, stored) {
    const [salt, hash] = String(stored).split(':');
    if (!salt || !hash) return false;
    return crypto.timingSafeEqual(crypto.scryptSync(pw, salt, 64), Buffer.from(hash, 'hex'));
  }
  const getSetting = (key, fallback) => { const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(key); return r ? JSON.parse(r.value) : fallback; };
  const setSetting = (key, value) => db.prepare('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, JSON.stringify(value));

  const DEFAULT_TRIP = { name: 'Japan trip', start: null, end: null, timezone: 'Asia/Tokyo', autoConfirm: 0, vetoRule: 'single', joinCode: null, currency: 'JPY' };
  const getTrip = () => ({ ...DEFAULT_TRIP, ...getSetting('trip', {}) });

  const cache = {
    get(key, maxAge = 14 * 864e5) {
      const r = db.prepare('SELECT value, ts FROM geocache WHERE key = ?').get(key);
      return !r || now() - r.ts > maxAge ? null : JSON.parse(r.value);
    },
    set(key, value) { db.prepare('INSERT OR REPLACE INTO geocache(key, value, ts) VALUES(?, ?, ?)').run(key, JSON.stringify(value), now()); },
  };

  const STATUSES = new Set(['suggested', 'maybe', 'confirmed', 'visited', 'skipped', 'vetoed']);
  const VOTES = new Set(['up', 'down', 'veto']);
  const COLORS = ['#E60012', '#F39700', '#00A672', '#009BBF', '#8F76D6', '#C1A470', '#00AC9B', '#E85298', '#0079C2', '#9CAEB7'];

  const publicUser = (u) => ({ id: u.id, name: u.name, color: u.color, isAdmin: !!u.is_admin, shareLocation: !!u.share_location });
  const listUsers = () => db.prepare('SELECT * FROM users ORDER BY id').all().map(publicUser);
  const userCount = () => db.prepare('SELECT COUNT(*) n FROM users').get().n;
  const userIdSet = () => new Set(db.prepare('SELECT id FROM users').all().map((u) => u.id));

  function placeRow(p) {
    const votes = {};
    for (const v of db.prepare('SELECT user_id, value FROM votes WHERE place_id = ?').all(p.id)) votes[v.user_id] = v.value;
    return {
      id: p.id, name: p.name, lat: p.lat, lng: p.lng, address: p.address, notes: p.notes, url: p.url, layer: p.layer,
      status: p.status, day: p.day, time: p.time, sort: p.sort, groupId: p.group_id || null,
      createdBy: p.created_by, createdAt: p.created_at, updatedBy: p.updated_by, updatedAt: p.updated_at,
      removedAt: p.removed_at || null, removedBy: p.removed_by || null, votes,
    };
  }
  const getPlace = (id) => { const p = db.prepare('SELECT * FROM places WHERE id = ?').get(id); return p ? placeRow(p) : null; };

  function listSubgroups() {
    return db.prepare('SELECT * FROM subgroups ORDER BY created_at').all().map((g) => ({
      id: g.id, name: g.name, color: g.color, startDay: g.start_day, endDay: g.end_day, createdBy: g.created_by,
      memberIds: db.prepare('SELECT user_id FROM subgroup_members WHERE subgroup_id = ?').all(g.id).map((m) => m.user_id),
    }));
  }

  function expenseRow(e) {
    return {
      id: e.id, kind: e.kind, title: e.title, amount: e.amount, currency: e.currency, rate: e.rate, category: e.category,
      paidBy: e.paid_by, date: e.date, placeId: e.place_id, groupId: e.group_id, visibility: e.visibility, splitMode: e.split_mode,
      notes: e.notes, createdBy: e.created_by, createdAt: e.created_at, updatedBy: e.updated_by, updatedAt: e.updated_at,
      shares: db.prepare('SELECT user_id, amount, weight FROM expense_shares WHERE expense_id = ?').all(e.id).map((s) => ({ userId: s.user_id, amount: s.amount, weight: s.weight })),
      items: db.prepare('SELECT name, amount, user_ids FROM expense_items WHERE expense_id = ? ORDER BY idx').all(e.id).map((i) => ({ name: i.name, amount: i.amount, userIds: JSON.parse(i.user_ids) })),
      attachments: db.prepare('SELECT id, mime, width, height, bytes, created_by FROM attachments WHERE expense_id = ? ORDER BY created_at').all(e.id)
        .map((a) => ({ id: a.id, mime: a.mime, width: a.width, height: a.height, bytes: a.bytes, createdBy: a.created_by })),
    };
  }
  const getExpense = (id) => { const e = db.prepare('SELECT * FROM expenses WHERE id = ? AND deleted_at IS NULL').get(id); return e ? expenseRow(e) : null; };
  const canSeeExpense = (user, e) => e.visibility === 'group' || e.paidBy === user.id || e.createdBy === user.id || e.shares.some((s) => s.userId === user.id);

  function listLocations() {
    const out = {};
    for (const r of db.prepare('SELECT l.* FROM locations l JOIN users u ON u.id = l.user_id WHERE u.share_location = 1').all()) {
      out[r.user_id] = { lat: r.lat, lng: r.lng, acc: r.acc, heading: r.heading, speed: r.speed, batt: r.batt, ts: r.ts, source: r.source };
    }
    return out;
  }
  const recentActivity = (limit = 60) => db.prepare('SELECT * FROM activity ORDER BY id DESC LIMIT ?').all(limit).map((a) => ({ id: a.id, ts: a.ts, userId: a.user_id, text: a.text }));

  function logActivity(userId, text) {
    const ts = now();
    const r = db.prepare('INSERT INTO activity(ts, user_id, text) VALUES(?, ?, ?)').run(ts, userId, text);
    db.prepare('DELETE FROM activity WHERE id <= ?').run(Number(r.lastInsertRowid) - 500);
    broadcast({ t: 'activity', item: { id: Number(r.lastInsertRowid), ts, userId, text } });
  }

  function tripForClient(user) {
    const t = getTrip();
    return { name: t.name, start: t.start, end: t.end, timezone: t.timezone, autoConfirm: t.autoConfirm, vetoRule: t.vetoRule, currency: t.currency, joinCode: user ? t.joinCode : undefined };
  }

  function snapshot(user) {
    const me = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
    const admin = !!me.is_admin;
    return {
      t: 'state',
      me: { ...publicUser(me), owntracksToken: me.owntracks_token },
      trip: tripForClient(user),
      users: listUsers(),
      places: db.prepare(`SELECT * FROM places ${admin ? '' : 'WHERE removed_at IS NULL'}`).all().map(placeRow),
      subgroups: listSubgroups(),
      expenses: db.prepare('SELECT * FROM expenses WHERE deleted_at IS NULL').all().map(expenseRow).filter((e) => canSeeExpense(me, e)),
      locations: listLocations(),
      online: onlineIds(),
      activity: recentActivity(),
      config: { ...CONFIG, gate: auth.gateEnabled ? auth.gateToken : null },
      serverTime: now(),
    };
  }

  // ---------- login rate limiter ----------
  const attempts = new Map();
  function rateLimited(ip) {
    const a = attempts.get(ip) || { n: 0, ts: now() };
    if (now() - a.ts > 10 * 60e3) { a.n = 0; a.ts = now(); }
    a.n++;
    attempts.set(ip, a);
    return a.n > 20;
  }

  // ---------- HTTP plumbing ----------
  const MIME = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
    '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.map': 'application/json', '.txt': 'text/plain',
    '.wasm': 'application/wasm', '.gz': 'application/gzip',
  };
  const nm = (p) => path.join(root, 'node_modules', p);
  const STATIC_ROOTS = [
    ['/vendor/maplibre-gl/', nm('maplibre-gl/dist')],
    ['/vendor/fflate/', nm('fflate/esm')],
    ['/vendor/tesseract/', nm('tesseract.js/dist')],
    ['/vendor/tesseract-core/', nm('tesseract.js-core')],
    ['/vendor/tessdata/', nm('@tesseract.js-data/jpn/4.0.0_best_int')],
    ['/vendor/tessdata/', nm('@tesseract.js-data/eng/4.0.0_best_int')],
    ['/', path.join(root, 'public')],
  ];
  const COMPRESSIBLE = new Set(['.html', '.js', '.mjs', '.css', '.json', '.svg', '.webmanifest']);
  const gzCache = new Map();

  function send(res, status, body, headers = {}) {
    const isObj = typeof body === 'object' && !Buffer.isBuffer(body);
    res.writeHead(status, { 'Content-Type': isObj ? 'application/json' : 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...res._extraHeaders, ...headers });
    res.end(isObj ? JSON.stringify(body) : body);
  }
  const addCookie = (res, c) => { if (!c) return; res._extraHeaders ||= {}; const prev = res._extraHeaders['Set-Cookie']; res._extraHeaders['Set-Cookie'] = prev ? [].concat(prev, c) : c; };

  function clientIp(req) {
    if (TRUST_PROXY) {
      const f = req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'];
      if (f) return String(f).split(',')[0].trim();
    }
    return req.socket.remoteAddress;
  }

  async function readBody(req, limit = 2e6) {
    const buf = await readRaw(req, limit);
    if (!buf.length) return {};
    try { return JSON.parse(buf.toString('utf8')); } catch { throw Object.assign(new Error('Invalid JSON'), { status: 400 }); }
  }
  async function readRaw(req, limit) {
    const chunks = [];
    let size = 0;
    for await (const c of req) {
      size += c.length;
      if (size > limit) throw Object.assign(new Error('That file is too large.'), { status: 413 });
      chunks.push(c);
    }
    return Buffer.concat(chunks);
  }

  // Cross-site requests are refused: if the browser says where a request came from, it must be us.
  function sameOrigin(req) {
    const origin = req.headers.origin;
    if (!origin) return true;
    try {
      const host = (TRUST_PROXY && req.headers['x-forwarded-host']) || req.headers.host;
      return new URL(origin).host === host;
    } catch { return false; }
  }

  function serveStatic(req, res, pathname) {
    if (pathname === '/manifest.webmanifest') return serveManifest(req, res);
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
        'X-Content-Type-Options': 'nosniff',
        ...(ext === '.html' ? { 'Referrer-Policy': 'same-origin', 'X-Frame-Options': 'DENY' } : {}),
        ...(rel === 'sw.js' ? { 'Service-Worker-Allowed': '/' } : {}),
        ...res._extraHeaders,
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

  // The manifest carries the gate token in start_url so home-screen apps (which have their own
  // cookie jar on iOS) can get in. It's only served to people who already passed the gate.
  function serveManifest(req, res) {
    const m = JSON.parse(fs.readFileSync(path.join(root, 'public/manifest.webmanifest'), 'utf8'));
    if (auth.gateEnabled) m.start_url = `/?gate=${auth.gateToken}`;
    res.writeHead(200, { 'Content-Type': MIME['.webmanifest'], 'Cache-Control': 'no-cache', ...res._extraHeaders });
    res.end(JSON.stringify(m));
  }

  const validName = (n) => { n = String(n || '').trim(); return n.length >= 1 && n.length <= 24 ? n : null; };

  async function photon(pathAndQuery) {
    const key = 'p:' + pathAndQuery;
    const hit = cache.get(key);
    if (hit) return hit;
    const r = await fetch('https://photon.komoot.io' + pathAndQuery, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error('Search service returned ' + r.status);
    const j = await r.json();
    const results = (j.features || []).map((f) => ({
      name: f.properties.name || f.properties.street || 'Unnamed place',
      lat: f.geometry.coordinates[1], lng: f.geometry.coordinates[0],
      address: photonAddress(f.properties), kind: f.properties.osm_value || f.properties.type,
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

  function canSeeAttachment(user, a) {
    if (a.created_by === user.id) return true;
    if (!a.expense_id) return false;
    const e = getExpense(a.expense_id);
    return !!e && canSeeExpense(user, e);
  }

  // ---------- HTTP routes ----------
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;
    try {
      if (p === '/healthz') return send(res, 200, { ok: true, ...getHealth() });

      // Private-link gate. Without the key the site looks like nothing is there.
      const gate = auth.checkGate(req, url);
      if (!gate.ok) return send(res, 404, 'Not found');
      if (gate.setCookie) {
        addCookie(res, gate.setCookie);
        if (req.method === 'GET' && !p.startsWith('/api/')) {
          res.writeHead(302, { Location: gate.cleanUrl, 'Cache-Control': 'no-store', ...res._extraHeaders });
          return res.end();
        }
      }

      if (!p.startsWith('/api/')) {
        if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
        return serveStatic(req, res, p);
      }
      if (req.method !== 'GET' && !sameOrigin(req)) return send(res, 403, { error: 'Cross-site request refused.' });

      // ---- public endpoints ----
      if (p === '/api/status' && req.method === 'GET') {
        const s = auth.resolve(req, url);
        if (s?.refreshCookie) addCookie(res, s.refreshCookie);
        return send(res, 200, { setup: userCount() > 0, tripName: getTrip().name, signedIn: !!s });
      }

      if (p === '/api/setup' && req.method === 'POST') {
        if (userCount() > 0) return send(res, 409, { error: 'This trip is already set up. Ask a friend for the invite link.' });
        const b = await readBody(req);
        const name = validName(b.name);
        if (!name) return send(res, 400, { error: 'Enter a name up to 24 characters.' });
        if (String(b.password || '').length < 6) return send(res, 400, { error: 'Use a password with at least 6 characters.' });
        setSetting('trip', { ...DEFAULT_TRIP, name: String(b.tripName || 'Japan trip').slice(0, 60), start: b.start || null, end: b.end || null, joinCode: newCode() });
        const r = db.prepare('INSERT INTO users(name, color, pass_hash, is_admin, created_at, owntracks_token) VALUES(?, ?, ?, 1, ?, ?)')
          .run(name, b.color || COLORS[0], hashPassword(b.password), now(), newToken().slice(0, 20));
        const s = auth.create(req, Number(r.lastInsertRowid));
        addCookie(res, s.setCookie);
        return send(res, 200, { ok: true });
      }

      if (p === '/api/join' && req.method === 'POST') {
        if (rateLimited(clientIp(req))) return send(res, 429, { error: 'Too many attempts. Wait 10 minutes and try again.' });
        const b = await readBody(req);
        const trip = getTrip();
        if (!trip.joinCode || String(b.code || '').trim().toUpperCase() !== trip.joinCode) return send(res, 403, { error: 'That invite code is not valid. Ask for a fresh invite link.' });
        const name = validName(b.name);
        if (!name) return send(res, 400, { error: 'Enter a name up to 24 characters.' });
        if (String(b.password || '').length < 6) return send(res, 400, { error: 'Use a password with at least 6 characters.' });
        if (db.prepare('SELECT 1 FROM users WHERE name = ?').get(name)) return send(res, 409, { error: `Someone is already called ${name}. Pick another name, or sign in instead.` });
        const used = new Set(db.prepare('SELECT color FROM users').all().map((u) => u.color));
        const color = b.color || COLORS.find((c) => !used.has(c)) || COLORS[userCount() % COLORS.length];
        const r = db.prepare('INSERT INTO users(name, color, pass_hash, created_at, owntracks_token) VALUES(?, ?, ?, ?, ?)')
          .run(name, color, hashPassword(b.password), now(), newToken().slice(0, 20));
        const id = Number(r.lastInsertRowid);
        broadcast({ t: 'users', users: listUsers() });
        logActivity(id, `${name} joined the trip`);
        addCookie(res, auth.create(req, id).setCookie);
        return send(res, 200, { ok: true });
      }

      if (p === '/api/login' && req.method === 'POST') {
        if (rateLimited(clientIp(req))) return send(res, 429, { error: 'Too many attempts. Wait 10 minutes and try again.' });
        const b = await readBody(req);
        const u = db.prepare('SELECT * FROM users WHERE name = ?').get(String(b.name || '').trim());
        if (!u || !checkPassword(String(b.password || ''), u.pass_hash)) return send(res, 401, { error: 'Name or password is wrong.' });
        addCookie(res, auth.create(req, u.id).setCookie);
        return send(res, 200, { ok: true });
      }

      // OwnTracks HTTP mode: Basic auth with <name>:<owntracks token>
      if (p === '/api/owntracks' && req.method === 'POST') {
        const h = String(req.headers.authorization || '');
        const [name, tok] = h.startsWith('Basic ') ? Buffer.from(h.slice(6), 'base64').toString().split(':') : [];
        const u = name && db.prepare('SELECT * FROM users WHERE name = ?').get(name);
        if (!u || !tok || !u.owntracks_token || tok !== u.owntracks_token) return send(res, 401, { error: 'Bad OwnTracks credentials' }, { 'WWW-Authenticate': 'Basic realm="tabi"' });
        const b = await readBody(req);
        if (b._type === 'location' && u.share_location) {
          updateLocation(u, { lat: b.lat, lng: b.lon, acc: b.acc, heading: b.cog, speed: b.vel != null ? b.vel / 3.6 : null, batt: b.batt, ts: b.tst ? b.tst * 1000 : now() }, 'owntracks');
        }
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
      const session = auth.resolve(req, url);
      if (!session) return send(res, 401, { error: 'Sign in again.' });
      const user = session.user;
      if (session.refreshCookie) addCookie(res, session.refreshCookie);

      if (p === '/api/logout' && req.method === 'POST') {
        auth.revoke(session.hash);
        addCookie(res, auth.clearCookie(req));
        return send(res, 200, { ok: true });
      }
      if (p === '/api/sessions' && req.method === 'GET') return send(res, 200, { sessions: auth.list(user.id, session.hash) });
      if (p === '/api/logout-others' && req.method === 'POST') {
        auth.revokeUser(user.id, session.hash);
        for (const c of clients) if (c.user.id === user.id && c.sessionHash !== session.hash) { c.ws.send('{"t":"kicked"}'); c.ws.close(); }
        return send(res, 200, { ok: true });
      }

      if (p === '/api/password' && req.method === 'POST') {
        const b = await readBody(req);
        if (!checkPassword(String(b.current || ''), user.pass_hash)) return send(res, 401, { error: 'Your current password is wrong.' });
        if (String(b.next || '').length < 6) return send(res, 400, { error: 'Use a password with at least 6 characters.' });
        db.prepare('UPDATE users SET pass_hash = ? WHERE id = ?').run(hashPassword(b.next), user.id);
        auth.revokeUser(user.id, session.hash); // sign out other devices
        return send(res, 200, { ok: true });
      }

      if (p === '/api/search' && req.method === 'GET') {
        const q = String(url.searchParams.get('q') || '').trim().slice(0, 120);
        if (!q) return send(res, 200, { results: [] });
        const lat = parseFloat(url.searchParams.get('lat')), lng = parseFloat(url.searchParams.get('lng'));
        const lang = url.searchParams.get('lang') === 'ja' ? 'default' : 'en';
        const bias = Number.isFinite(lat) && Number.isFinite(lng) ? `&lat=${lat.toFixed(2)}&lon=${lng.toFixed(2)}` : '';
        try {
          return send(res, 200, { results: await photon(`/api?limit=8&lang=${lang}&bbox=122.9,24.0,146.0,45.6&q=${encodeURIComponent(q)}${bias}`) });
        } catch (e) {
          return send(res, 502, { error: 'Search is unavailable right now. Paste a map link instead.', detail: e.message });
        }
      }

      if (p === '/api/reverse' && req.method === 'GET') {
        const lat = parseFloat(url.searchParams.get('lat')), lng = parseFloat(url.searchParams.get('lng'));
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) return send(res, 400, { error: 'Missing coordinates' });
        try { return send(res, 200, { result: (await photon(`/reverse?lang=en&lat=${lat.toFixed(5)}&lon=${lng.toFixed(5)}`))[0] || null }); }
        catch { return send(res, 200, { result: null }); }
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
          res.writeHead(200, { 'Content-Type': 'application/vnd.google-earth.kml+xml; charset=utf-8', 'Cache-Control': 'no-store', ...res._extraHeaders });
          return res.end(kml);
        } catch (e) { return send(res, 502, { error: e.message }); }
      }

      // Exchange rates (frankfurter.app, ECB data, free) — cached for 6 hours
      if (p === '/api/rate' && req.method === 'GET') {
        const from = String(url.searchParams.get('from') || '').toUpperCase();
        const to = String(url.searchParams.get('to') || getTrip().currency).toUpperCase();
        if (!(from in CURRENCIES) || !(to in CURRENCIES)) return send(res, 400, { error: 'Unsupported currency' });
        if (from === to) return send(res, 200, { rate: 1 });
        const key = `fx:${from}:${to}`;
        const hit = cache.get(key, 6 * 3600e3);
        if (hit) return send(res, 200, hit);
        try {
          const r = await fetch(`https://api.frankfurter.app/latest?from=${from}&to=${to}`, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(8000) });
          const j = await r.json();
          const rate = j.rates?.[to];
          if (!rate) throw new Error('no rate');
          const out = { rate, date: j.date };
          cache.set(key, out);
          return send(res, 200, out);
        } catch { return send(res, 502, { error: 'Could not look up the exchange rate. Type it in instead.' }); }
      }

      // Receipt photos and screenshots
      if (p === '/api/attachments' && req.method === 'POST') {
        const mime = String(req.headers['content-type'] || '').split(';')[0];
        const ext = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }[mime];
        if (!ext) return send(res, 415, { error: 'Upload a JPEG, PNG or WebP image.' });
        const buf = await readRaw(req, 8e6);
        if (!buf.length) return send(res, 400, { error: 'The image was empty.' });
        const key = await blobs.put(buf, ext);
        const id = 'a' + crypto.randomBytes(9).toString('base64url');
        db.prepare('INSERT INTO attachments(id, expense_id, blob_key, mime, bytes, width, height, created_by, created_at) VALUES(?, NULL, ?, ?, ?, ?, ?, ?, ?)')
          .run(id, key, mime, buf.length, +url.searchParams.get('w') || null, +url.searchParams.get('h') || null, user.id, now());
        return send(res, 200, { id, mime, bytes: buf.length });
      }
      const att = p.match(/^\/api\/attachments\/([\w-]{6,64})(\/ocr)?$/);
      if (att) {
        const a = db.prepare('SELECT * FROM attachments WHERE id = ?').get(att[1]);
        if (!a || !canSeeAttachment(user, a)) return send(res, 404, { error: 'Not found' });
        if (att[2] && req.method === 'POST') {
          const b = await readBody(req);
          db.prepare('UPDATE attachments SET ocr_text = ? WHERE id = ?').run(String(b.text || '').slice(0, 20000), a.id);
          return send(res, 200, { ok: true });
        }
        if (req.method === 'GET') {
          const buf = await blobs.get(a.blob_key);
          if (!buf) return send(res, 404, { error: 'The image file is missing.' });
          res.writeHead(200, { 'Content-Type': a.mime, 'Content-Length': buf.length, 'Cache-Control': 'private, max-age=31536000, immutable', ...res._extraHeaders });
          return res.end(buf);
        }
      }

      if (p === '/api/export' && req.method === 'GET') {
        const places = db.prepare('SELECT * FROM places WHERE removed_at IS NULL ORDER BY day, sort').all().map(placeRow);
        if (url.searchParams.get('format') === 'kml') {
          res.writeHead(200, { 'Content-Type': 'application/vnd.google-earth.kml+xml', 'Content-Disposition': 'attachment; filename="tabi-trip.kml"', ...res._extraHeaders });
          return res.end(toKml(places));
        }
        if (url.searchParams.get('format') === 'expenses') {
          const rows = db.prepare('SELECT * FROM expenses WHERE deleted_at IS NULL ORDER BY date, created_at').all().map(expenseRow).filter((e) => canSeeExpense(user, e));
          const names = Object.fromEntries(listUsers().map((u) => [u.id, u.name]));
          const q = (s) => `"${String(s ?? '').replace(/"/g, '""')}"`;
          const csv = ['date,title,kind,amount,currency,rate,paid_by,split,visibility,category'].concat(rows.map((e) =>
            [e.date, q(e.title), e.kind, e.amount / 10 ** CURRENCIES[e.currency], e.currency, e.rate, q(names[e.paidBy]),
              q(e.shares.map((s) => `${names[s.userId]}:${s.amount / 10 ** CURRENCIES[e.currency]}`).join('; ')), e.visibility, e.category || ''].join(','))).join('\n');
          res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="tabi-expenses.csv"', ...res._extraHeaders });
          return res.end('﻿' + csv);
        }
        return send(res, 200, { trip: tripForClient(null), users: listUsers(), places, subgroups: listSubgroups() }, { 'Content-Disposition': 'attachment; filename="tabi-trip.json"' });
      }

      return send(res, 404, { error: 'Not found' });
    } catch (e) {
      if (!e.status) console.error(e);
      return send(res, e.status || 500, { error: e.status ? e.message : 'Something went wrong on the server.' });
    }
  });

  // ---------- WebSocket ----------
  const wss = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024 });
  const clients = new Set();
  const onlineIds = () => [...new Set([...clients].map((c) => c.user.id))];

  function sendTo(c, msg) { if (c.ws.readyState === 1) c.ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg)); }
  function broadcast(msg) { const data = JSON.stringify(msg); for (const c of clients) sendTo(c, data); }
  const broadcastPresence = () => broadcast({ t: 'presence', online: onlineIds() });

  // Removed places are only visible to admins.
  function broadcastPlace(id) {
    const place = getPlace(id);
    if (!place) return broadcast({ t: 'place.del', id });
    for (const c of clients) sendTo(c, place.removedAt && !c.user.is_admin ? { t: 'place.del', id } : { t: 'place', place });
  }
  function broadcastPlaces(list) {
    for (const c of clients) {
      const vis = list.filter((p) => !p.removedAt || c.user.is_admin);
      if (vis.length) sendTo(c, { t: 'places', places: vis });
    }
  }
  // Private expenses only go to the people in them.
  function broadcastExpense(id) {
    const e = getExpense(id);
    for (const c of clients) sendTo(c, e && canSeeExpense(c.user, e) ? { t: 'expense', expense: e } : { t: 'expense.del', id });
  }
  const broadcastGroups = () => broadcast({ t: 'subgroups', subgroups: listSubgroups() });
  function refreshClientsOf(userId) {
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    for (const c of clients) if (c.user.id === userId && u) { c.user = u; sendTo(c, snapshot(u)); }
  }

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://localhost');
    const reject = (code, text) => { socket.write(`HTTP/1.1 ${code} ${text}\r\n\r\n`); socket.destroy(); };
    if (url.pathname !== '/ws') return reject(404, 'Not Found');
    if (!auth.checkGate(req, url).ok) return reject(404, 'Not Found');
    if (!sameOrigin(req)) return reject(403, 'Forbidden');
    const session = auth.resolve(req, url);
    if (!session) return reject(401, 'Unauthorized');
    wss.handleUpgrade(req, socket, head, (ws) => {
      const client = { ws, user: session.user, sessionHash: session.hash, alive: true };
      clients.add(client);
      sendTo(client, snapshot(session.user));
      broadcastPresence();
      ws.on('pong', () => { client.alive = true; });
      ws.on('message', (raw) => {
        let msg;
        try { msg = JSON.parse(raw); } catch { return; }
        if (msg.t === 'ping') return ws.send('{"t":"pong"}');
        if (msg.t !== 'op') return;
        const fresh = db.prepare('SELECT * FROM users WHERE id = ?').get(client.user.id);
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
      ws.on('close', () => { clients.delete(client); broadcastPresence(); });
    });
  });

  const heartbeat = setInterval(() => {
    for (const c of clients) {
      if (!c.alive) { c.ws.terminate(); clients.delete(c); continue; }
      c.alive = false;
      try { c.ws.ping(); } catch { /* ignore */ }
    }
  }, 30000);
  heartbeat.unref();
  const purge = setInterval(() => auth.purgeExpired(), 6 * 3600e3);
  purge.unref();

  // ---------- operations ----------
  const fail = (message) => { throw Object.assign(new Error(message), { expose: true }); };
  const str = (v, max) => (v == null || v === '' ? null : String(v).slice(0, max));
  const isDay = (d) => d == null || /^\d{4}-\d{2}-\d{2}$/.test(d);
  const isTime = (t) => t == null || /^\d{2}:\d{2}$/.test(t);
  const groupExists = (id) => !!db.prepare('SELECT 1 FROM subgroups WHERE id = ?').get(id);

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
    if ('groupId' in d) { const g = d.groupId || null; if (g && !groupExists(g)) fail('That subgroup no longer exists.'); p.group_id = g; }
    if (!Number.isFinite(p.lat) || !Number.isFinite(p.lng) || Math.abs(p.lat) > 90 || Math.abs(p.lng) > 180) fail('That place has no valid location');
    return p;
  }

  function insertPlace(user, d) {
    if (!/^[\w-]{6,64}$/.test(String(d.id || ''))) fail('Bad place id');
    if (db.prepare('SELECT 1 FROM places WHERE id = ?').get(d.id)) return null; // idempotent replay
    const p = cleanPlace({ status: 'suggested', ...d });
    const ts = now();
    db.prepare(`INSERT INTO places(id, name, lat, lng, address, notes, url, layer, status, day, time, sort, group_id, created_by, created_at, updated_by, updated_at)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      d.id, p.name, p.lat, p.lng, p.address ?? null, p.notes ?? null, p.url ?? null, p.layer ?? null, p.status || 'suggested',
      p.day ?? null, p.time ?? null, p.sort ?? ts, p.group_id ?? null, user.id, ts, user.id, ts);
    return getPlace(d.id);
  }

  function applyVoteRules(placeId) {
    const trip = getTrip();
    const place = db.prepare('SELECT * FROM places WHERE id = ?').get(placeId);
    if (!place) return;
    const votes = db.prepare('SELECT value FROM votes WHERE place_id = ?').all(placeId).map((v) => v.value);
    const vetoes = votes.filter((v) => v === 'veto').length;
    const ups = votes.filter((v) => v === 'up').length;
    let next = null;
    if (place.status !== 'vetoed' && vetoes > 0 && (trip.vetoRule === 'single' || (trip.vetoRule === 'majority' && vetoes > userCount() / 2))) next = 'vetoed';
    else if (trip.autoConfirm > 0 && ups >= trip.autoConfirm && (place.status === 'suggested' || place.status === 'maybe')) next = 'confirmed';
    if (next) { db.prepare('UPDATE places SET status = ?, updated_at = ? WHERE id = ?').run(next, now(), placeId); return next; }
  }

  function updateLocation(user, l, source) {
    const lat = +l.lat, lng = +l.lng;
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
    const n = (v) => (v == null || v === '' || !Number.isFinite(+v) ? null : +v);
    const loc = { lat, lng, acc: n(l.acc), heading: n(l.heading), speed: n(l.speed), batt: n(l.batt) == null ? null : Math.round(n(l.batt)), ts: Math.min(+l.ts || now(), now()), source };
    db.prepare(`INSERT INTO locations(user_id, lat, lng, acc, heading, speed, batt, ts, source) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET lat=excluded.lat, lng=excluded.lng, acc=excluded.acc, heading=excluded.heading, speed=excluded.speed,
      batt=COALESCE(excluded.batt, locations.batt), ts=excluded.ts, source=excluded.source`).run(user.id, loc.lat, loc.lng, loc.acc, loc.heading, loc.speed, loc.batt, loc.ts, source);
    broadcast({ t: 'loc', userId: user.id, loc });
  }

  const STATUS_WORDS = { suggested: 'moved back to suggested', maybe: 'marked as maybe', confirmed: 'confirmed', visited: 'marked as visited', skipped: 'skipped', vetoed: 'vetoed' };
  const tx = (fn) => { db.exec('BEGIN'); try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } };

  function handleOp(user, op, d) {
    const requireAdmin = () => { if (!user.is_admin) fail('Only trip admins can do that.'); };
    switch (op) {
      // ---- places ----
      case 'place.add': {
        const place = insertPlace(user, d.place || {});
        if (place) { broadcastPlace(place.id); logActivity(user.id, `${user.name} added ${place.name}`); }
        return { ok: true };
      }
      case 'place.bulk': {
        const list = Array.isArray(d.places) ? d.places.slice(0, 2000) : [];
        const added = tx(() => list.map((item) => { try { return insertPlace(user, item); } catch { return null; } }).filter(Boolean));
        if (added.length) {
          broadcastPlaces(added);
          logActivity(user.id, `${user.name} imported ${added.length} place${added.length === 1 ? '' : 's'}${d.source ? ` from ${String(d.source).slice(0, 80)}` : ''}`);
        }
        return { ok: true, added: added.length };
      }
      case 'place.update': {
        const row = db.prepare('SELECT * FROM places WHERE id = ?').get(d.id);
        if (!row) fail('That place was deleted.');
        const patch = d.patch || {};
        const p = cleanPlace(patch, row);
        db.prepare('UPDATE places SET name=?, lat=?, lng=?, address=?, notes=?, url=?, layer=?, status=?, day=?, time=?, sort=?, group_id=?, updated_by=?, updated_at=? WHERE id=?')
          .run(p.name, p.lat, p.lng, p.address ?? null, p.notes ?? null, p.url ?? null, p.layer ?? null, p.status, p.day ?? null, p.time ?? null, p.sort, p.group_id ?? null, user.id, now(), d.id);
        if (patch.status && patch.status !== row.status) {
          if (row.status === 'vetoed') db.prepare("DELETE FROM votes WHERE place_id = ? AND value = 'veto'").run(d.id);
          logActivity(user.id, `${user.name} ${STATUS_WORDS[patch.status]} ${p.name}`);
        } else if ('day' in patch && patch.day !== row.day) {
          logActivity(user.id, patch.day ? `${user.name} moved ${p.name} to ${patch.day}` : `${user.name} unscheduled ${p.name}`);
        }
        broadcastPlace(d.id);
        return { ok: true };
      }
      case 'place.reorder': {
        const ids = Array.isArray(d.ids) ? d.ids.map(String) : [];
        const stmt = db.prepare('UPDATE places SET sort = ?, updated_at = ? WHERE id = ?');
        tx(() => ids.forEach((id, i) => stmt.run(i + 1, now(), id)));
        broadcastPlaces(ids.map(getPlace).filter(Boolean));
        return { ok: true };
      }
      case 'place.delete': { // anyone: moves it to "Previously interested"
        const row = db.prepare('SELECT * FROM places WHERE id = ?').get(d.id);
        if (!row || row.removed_at) return { ok: true };
        db.prepare('UPDATE places SET removed_at = ?, removed_by = ?, updated_at = ? WHERE id = ?').run(now(), user.id, now(), d.id);
        broadcastPlace(d.id);
        logActivity(user.id, `${user.name} removed ${row.name}`);
        return { ok: true };
      }
      case 'place.restore': {
        requireAdmin();
        const row = db.prepare('SELECT * FROM places WHERE id = ?').get(d.id);
        if (!row) fail('That place was deleted for good.');
        db.prepare('UPDATE places SET removed_at = NULL, removed_by = NULL, status = CASE WHEN status = \'vetoed\' THEN \'suggested\' ELSE status END, updated_at = ? WHERE id = ?').run(now(), d.id);
        broadcastPlace(d.id);
        logActivity(user.id, `${user.name} brought back ${row.name}`);
        return { ok: true };
      }
      case 'place.purge': {
        requireAdmin();
        const row = db.prepare('SELECT * FROM places WHERE id = ?').get(d.id);
        if (!row) return { ok: true };
        if (!row.removed_at) fail('Remove it first; only previously interested places can be deleted for good.');
        db.prepare('DELETE FROM places WHERE id = ?').run(d.id);
        broadcast({ t: 'place.del', id: d.id });
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
        broadcastPlace(d.id);
        return { ok: true };
      }

      // ---- subgroups (anyone can manage them) ----
      case 'group.save': {
        const g = d.group || {};
        if (!/^[\w-]{6,64}$/.test(String(g.id || ''))) fail('Bad subgroup id');
        const name = str(g.name, 40);
        if (!name) fail('Give the subgroup a name.');
        const color = /^#[0-9a-f]{6}$/i.test(g.color || '') ? g.color : COLORS[3];
        const start = g.startDay || null, end = g.endDay || g.startDay || null;
        if (!isDay(start) || !isDay(end)) fail('Dates must look like 2026-03-14');
        if (start && end && end < start) fail('The last day has to be on or after the first day.');
        const ids = userIdSet();
        const members = [...new Set((g.memberIds || []).map(Number))].filter((id) => ids.has(id));
        const existed = db.prepare('SELECT * FROM subgroups WHERE id = ?').get(g.id);
        tx(() => {
          if (existed) db.prepare('UPDATE subgroups SET name = ?, color = ?, start_day = ?, end_day = ? WHERE id = ?').run(name, color, start, end, g.id);
          else db.prepare('INSERT INTO subgroups(id, name, color, start_day, end_day, created_by, created_at) VALUES(?, ?, ?, ?, ?, ?, ?)').run(g.id, name, color, start, end, user.id, now());
          db.prepare('DELETE FROM subgroup_members WHERE subgroup_id = ?').run(g.id);
          const ins = db.prepare('INSERT INTO subgroup_members(subgroup_id, user_id) VALUES(?, ?)');
          members.forEach((m) => ins.run(g.id, m));
        });
        broadcastGroups();
        logActivity(user.id, existed ? `${user.name} updated the subgroup ${name}` : `${user.name} made a subgroup: ${name}`);
        return { ok: true };
      }
      case 'group.member': {
        const g = db.prepare('SELECT * FROM subgroups WHERE id = ?').get(d.id);
        if (!g) fail('That subgroup no longer exists.');
        const target = db.prepare('SELECT * FROM users WHERE id = ?').get(+d.userId);
        if (!target) fail('That person is no longer in the trip.');
        if (d.on) db.prepare('INSERT OR IGNORE INTO subgroup_members(subgroup_id, user_id) VALUES(?, ?)').run(g.id, target.id);
        else db.prepare('DELETE FROM subgroup_members WHERE subgroup_id = ? AND user_id = ?').run(g.id, target.id);
        broadcastGroups();
        logActivity(user.id, d.on ? `${user.name} added ${target.name} to ${g.name}` : `${user.name} took ${target.name} out of ${g.name}`);
        return { ok: true };
      }
      case 'group.delete': {
        const g = db.prepare('SELECT * FROM subgroups WHERE id = ?').get(d.id);
        if (!g) return { ok: true };
        const affected = db.prepare('SELECT id FROM places WHERE group_id = ?').all(g.id).map((r) => r.id);
        tx(() => {
          db.prepare('UPDATE places SET group_id = NULL WHERE group_id = ?').run(g.id);
          db.prepare('UPDATE expenses SET group_id = NULL WHERE group_id = ?').run(g.id);
          db.prepare('DELETE FROM subgroups WHERE id = ?').run(g.id);
        });
        broadcastGroups();
        if (affected.length) broadcastPlaces(affected.map(getPlace).filter(Boolean));
        logActivity(user.id, `${user.name} ended the subgroup ${g.name}`);
        return { ok: true };
      }

      // ---- money ----
      case 'expense.save': {
        const e = cleanExpense(d.expense || {}, { userIds: userIdSet() });
        const existing = getExpense(e.id);
        if (existing && !canSeeExpense(user, existing)) fail('You can’t edit that expense.');
        if (db.prepare('SELECT 1 FROM expenses WHERE id = ? AND deleted_at IS NOT NULL').get(e.id)) fail('That expense was deleted.');
        if (e.groupId && !groupExists(e.groupId)) e.groupId = null;
        const ts = now();
        tx(() => {
          if (existing) {
            db.prepare(`UPDATE expenses SET kind=?, title=?, amount=?, currency=?, rate=?, category=?, paid_by=?, date=?, place_id=?, group_id=?, visibility=?, split_mode=?, notes=?, updated_by=?, updated_at=? WHERE id=?`)
              .run(e.kind, e.title, e.amount, e.currency, e.rate, e.category, e.paidBy, e.date, e.placeId, e.groupId, e.visibility, e.splitMode, e.notes, user.id, ts, e.id);
          } else {
            db.prepare(`INSERT INTO expenses(id, kind, title, amount, currency, rate, category, paid_by, date, place_id, group_id, visibility, split_mode, notes, created_by, created_at, updated_by, updated_at)
              VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
              .run(e.id, e.kind, e.title, e.amount, e.currency, e.rate, e.category, e.paidBy, e.date, e.placeId, e.groupId, e.visibility, e.splitMode, e.notes, user.id, ts, user.id, ts);
          }
          db.prepare('DELETE FROM expense_shares WHERE expense_id = ?').run(e.id);
          const sh = db.prepare('INSERT INTO expense_shares(expense_id, user_id, amount, weight) VALUES(?, ?, ?, ?)');
          e.shares.forEach((s) => sh.run(e.id, s.userId, s.amount, s.weight));
          db.prepare('DELETE FROM expense_items WHERE expense_id = ?').run(e.id);
          const it = db.prepare('INSERT INTO expense_items(expense_id, idx, name, amount, user_ids) VALUES(?, ?, ?, ?, ?)');
          e.items.forEach((x, i) => it.run(e.id, i, x.name, x.amount, JSON.stringify(x.userIds)));
          // Attach receipts: ones this person uploaded, or ones already on this expense
          db.prepare('UPDATE attachments SET expense_id = NULL WHERE expense_id = ?').run(e.id);
          const link = db.prepare('UPDATE attachments SET expense_id = ? WHERE id = ? AND (created_by = ? OR expense_id IS NULL OR expense_id = ?)');
          const prevIds = new Set((existing?.attachments || []).map((a) => a.id));
          e.attachmentIds.forEach((aid) => { const a = db.prepare('SELECT * FROM attachments WHERE id = ?').get(aid); if (a && (a.created_by === user.id || prevIds.has(aid))) link.run(e.id, aid, user.id, e.id); });
        });
        broadcastExpense(e.id);
        if (e.visibility === 'group' && !existing) {
          const payer = db.prepare('SELECT name FROM users WHERE id = ?').get(e.paidBy)?.name;
          logActivity(user.id, e.kind === 'payment' ? `${payer} paid back ${db.prepare('SELECT name FROM users WHERE id = ?').get(e.shares[0].userId)?.name}` : `${user.name} added ${e.title}`);
        }
        return { ok: true };
      }
      case 'expense.delete': {
        const e = getExpense(d.id);
        if (!e) return { ok: true };
        if (!canSeeExpense(user, e)) fail('You can’t delete that expense.');
        db.prepare('UPDATE expenses SET deleted_at = ?, updated_by = ? WHERE id = ?').run(now(), user.id, d.id);
        broadcast({ t: 'expense.del', id: d.id });
        if (e.visibility === 'group') logActivity(user.id, `${user.name} deleted ${e.title}`);
        return { ok: true };
      }

      // ---- location ----
      case 'loc.update': {
        if (!user.share_location) return { ok: false, error: 'Location sharing is off.' };
        updateLocation(user, d, 'app');
        return null;
      }
      case 'loc.share': {
        const on = d.on ? 1 : 0;
        db.prepare('UPDATE users SET share_location = ? WHERE id = ?').run(on, user.id);
        if (!on) { db.prepare('DELETE FROM locations WHERE user_id = ?').run(user.id); broadcast({ t: 'loc', userId: user.id, loc: null }); }
        broadcast({ t: 'users', users: listUsers() });
        return { ok: true };
      }

      // ---- people ----
      case 'user.update': {
        if (d.color && /^#[0-9a-f]{6}$/i.test(d.color)) db.prepare('UPDATE users SET color = ? WHERE id = ?').run(d.color, user.id);
        if (d.name) {
          const name = validName(d.name);
          if (!name) fail('Enter a name up to 24 characters.');
          if (db.prepare('SELECT id FROM users WHERE name = ? AND id != ?').get(name, user.id)) fail(`Someone is already called ${name}.`);
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
        auth.revokeUser(target.id);
        db.prepare('DELETE FROM users WHERE id = ?').run(target.id);
        for (const c of clients) if (c.user.id === target.id) { sendTo(c, { t: 'kicked' }); c.ws.close(); }
        broadcast({ t: 'users', users: listUsers() });
        broadcast({ t: 'loc', userId: target.id, loc: null });
        broadcastGroups();
        logActivity(user.id, `${user.name} removed ${target.name} from the trip`);
        return { ok: true };
      }
      case 'user.admin': {
        requireAdmin();
        if (+d.id === user.id && !d.on) fail('Make someone else an admin first, then they can remove your admin role.');
        db.prepare('UPDATE users SET is_admin = ? WHERE id = ?').run(d.on ? 1 : 0, +d.id);
        broadcast({ t: 'users', users: listUsers() });
        refreshClientsOf(+d.id); // they gain or lose "Previously interested"
        return { ok: true };
      }

      // ---- trip ----
      case 'trip.update': {
        requireAdmin();
        const t = getTrip();
        if ('name' in d) t.name = str(d.name, 60) || 'Japan trip';
        if ('start' in d) { if (!isDay(d.start || null)) fail('Start date is not valid'); t.start = d.start || null; }
        if ('end' in d) { if (!isDay(d.end || null)) fail('End date is not valid'); t.end = d.end || null; }
        if (t.start && t.end && t.end < t.start) fail('The trip has to end after it starts.');
        if ('autoConfirm' in d) t.autoConfirm = Math.max(0, Math.min(50, parseInt(d.autoConfirm, 10) || 0));
        if ('vetoRule' in d) { if (!['single', 'majority', 'off'].includes(d.vetoRule)) fail('Unknown veto rule'); t.vetoRule = d.vetoRule; }
        if ('currency' in d && d.currency !== t.currency) {
          if (!(d.currency in CURRENCIES)) fail('Unsupported currency');
          if (db.prepare('SELECT 1 FROM expenses WHERE deleted_at IS NULL LIMIT 1').get()) fail('The trip currency can’t change once expenses have been added.');
          t.currency = d.currency;
        }
        setSetting('trip', t);
        for (const c of clients) sendTo(c, { t: 'trip', trip: tripForClient(c.user) });
        return { ok: true };
      }
      case 'trip.newCode': {
        requireAdmin();
        const t = getTrip();
        t.joinCode = newCode();
        setSetting('trip', t);
        for (const c of clients) sendTo(c, { t: 'trip', trip: tripForClient(c.user) });
        return { ok: true };
      }
      default:
        fail('Unknown action');
    }
  }

  return {
    server,
    userCount,
    close() { for (const c of clients) c.ws.terminate(); clearInterval(heartbeat); clearInterval(purge); return new Promise((r) => server.close(r)); },
  };
}
