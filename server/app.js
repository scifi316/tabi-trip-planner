// Tabi application: HTTP API, static files and the WebSocket hub.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { WebSocketServer } from 'ws';
import { resolveLink, extractUrls, myMapsId, fetchMyMapsKml, photonAddress, geocode } from './links.js';
import os from 'node:os';
import { createAuth, parseCookies } from './auth.js';
import { devPush, devRecent, devSubscribe, startedAt } from './devlog.js';
import { cleanExpense, CURRENCIES } from './money.js';
import { createNotifier, prefsOf, cleanPrefs, NOTIFY_KINDS } from './notify.js';
import { imageSize } from './images.js';
import { createPusher } from './push.js';
import { createChat, isKlipyMedia } from './chat.js';
import { APK_MAX, appInfo, assetLinks } from './apk.js';

export function createApp({ db, blobs, root, dataDir = '', env = process.env, getHealth = () => ({}) }) {
  const TRUST_PROXY = /^(1|true|yes)$/i.test(env.TRUST_PROXY || '');
  const CONFIG = {
    styleLight: env.MAP_STYLE_LIGHT || 'https://tiles.openfreemap.org/styles/liberty',
    styleDark: env.MAP_STYLE_DARK || 'https://tiles.openfreemap.org/styles/dark',
    offlineTileLimit: +(env.OFFLINE_TILE_LIMIT || 3000),
    currencies: Object.keys(CURRENCIES),
  };
  const UA = 'Tabi-trip-planner/1.0 (self-hosted group itinerary app)';
  const auth = createAuth({ db, env, trustProxy: TRUST_PROXY });
  const VERSION = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  // Build id: changes whenever any file the app is made of changes. The page carries the build it
  // was loaded from, and the server tells every client the current one, so a home-screen app that
  // iOS kept frozen in the background notices it's out of date and reloads itself.
  const BUILD = (() => {
    const h = crypto.createHash('sha256').update(VERSION);
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const f = path.join(dir, e.name);
        if (e.isDirectory()) walk(f); else h.update(e.name).update(fs.readFileSync(f));
      }
    };
    try { walk(path.join(root, 'public')); } catch { /* missing public dir in tests */ }
    return `${VERSION}-${h.digest('hex').slice(0, 10)}`;
  })();
  const INDEX_FILE = path.join(root, 'public', 'index.html');

  // Developer console: separate secret (DEV_KEY). Read-only views of the database, live locations,
  // OwnTracks traffic, outbound calls and server logs. It also lets the holder past the private-link gate.
  // Password reset links from the console can take over any account, so they're off unless
  // DEV_RESET_LINKS=on (for the day the only admin is locked out).
  const DEV_KEY = env.DEV_KEY || '';
  const DEV_RESET_LINKS = /^(1|true|on|yes)$/i.test(env.DEV_RESET_LINKS || '');
  const devToken = DEV_KEY ? crypto.createHmac('sha256', DEV_KEY).update('tabi-dev-v1').digest('base64url').slice(0, 32) : '';
  const isDev = (req) => { const c = DEV_KEY && parseCookies(req).tabi_dev; return !!c && auth.safeEqual(c, devToken); };

  // ---------- helpers ----------
  const now = () => Date.now();
  const newToken = () => crypto.randomBytes(32).toString('base64url');
  const newCode = () => Array.from(crypto.randomBytes(6), (b) => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[b % 32]).join('');
  const hashPassword = (pw) => { const salt = crypto.randomBytes(16).toString('hex'); return `${salt}:${crypto.scryptSync(pw, salt, 64).toString('hex')}`; };
  function checkPassword(pw, stored) {
    const [salt, hash] = String(stored || '').split(':');
    if (!salt || !hash || hash.length !== 128) return false; // former members restored without a password can't sign in
    return crypto.timingSafeEqual(crypto.scryptSync(pw, salt, 64), Buffer.from(hash, 'hex'));
  }
  // Recovery codes: 16 characters in 4 groups (80 bits), without look-alike letters. Stored hashed like passwords.
  const RC_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  const newRecoveryCode = () => [...crypto.randomBytes(16)].map((b) => RC_ALPHABET[b % 32]).join('').match(/.{4}/g).join('-');
  const normRecoveryCode = (c) => String(c || '').toUpperCase().replace(/[^0-9A-Z]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  // none: no code. pending: a code exists and can still be viewed, not yet confirmed as saved.
  // unconfirmed: made before 1.6 (no confirmation then). saved: confirmed, only the hash is kept.
  const recoveryStatus = (u) => (!u.recovery_hash ? 'none' : u.recovery_pending ? 'pending' : u.recovery_ack_at ? 'saved' : 'unconfirmed');
  const recoveryInfo = (u) => ({ status: recoveryStatus(u), set: recoveryStatus(u) === 'saved', setAt: u.recovery_set_at || null, savedAt: u.recovery_ack_at || null, snoozeUntil: u.recovery_snooze || null });
  const pushRecovery = (id) => { const u = db.prepare('SELECT * FROM users WHERE id = ?').get(id); for (const c of clients) if (c.user.id === id) sendTo(c, { t: 'me.recovery', recovery: recoveryInfo(u) }); };
  const recoverFails = new Map(); // user id -> { n, ts }: wrong recovery codes, per account
  const clientLogCount = new Map(); // user id -> browser errors reported since start (capped)
  const helpAsked = new Map();    // user id -> time admins were last asked
  const getSetting = (key, fallback) => { const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(key); return r ? JSON.parse(r.value) : fallback; };
  const setSetting = (key, value) => db.prepare('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, JSON.stringify(value));

  const DEFAULT_TRIP = { name: 'Japan trip', start: null, end: null, timezone: 'Asia/Tokyo', autoConfirm: 0, vetoRule: 'single', joinCode: null, currency: 'JPY', photoReminder: '19:00' };
  const getTrip = () => ({ ...DEFAULT_TRIP, ...getSetting('trip', {}) });
  // The Android app an admin uploaded (see apk.js); what everyone sees of it
  const androidApp = () => getSetting('androidApp', null);
  const androidPublic = (a = androidApp()) => (a ? { version: a.versionName, code: a.versionCode, size: a.size, at: a.at, test: !!a.test } : null);

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

  // ---------- clearing all expenses (admins and the developer console) ----------
  // Expenses are soft-deleted with a batch id, so the most recent clear can be undone exactly,
  // without bringing back expenses that had been deleted one by one before it.
  function expenseCounts() {
    const one = (sql) => db.prepare(sql).get().n;
    return {
      expenses: one("SELECT COUNT(*) n FROM expenses WHERE deleted_at IS NULL AND kind = 'expense'"),
      payments: one("SELECT COUNT(*) n FROM expenses WHERE deleted_at IS NULL AND kind = 'payment'"),
      private: one("SELECT COUNT(*) n FROM expenses WHERE deleted_at IS NULL AND visibility = 'private'"),
    };
  }
  function lastExpenseReset() {
    const r = db.prepare(`SELECT reset_batch b, COUNT(*) n, MAX(deleted_at) at, MAX(updated_by) by FROM expenses
      WHERE reset_batch IS NOT NULL AND deleted_at IS NOT NULL GROUP BY reset_batch ORDER BY at DESC LIMIT 1`).get();
    if (!r) return null;
    const who = r.b.split(':')[1];
    return { batch: r.b, count: r.n, at: r.at, by: who === 'dev' ? 'the developer console' : nameOf(+who) };
  }
  function pushResetInfo() {
    const info = lastExpenseReset();
    for (const c of clients) if (c.user.is_admin || db.prepare('SELECT is_admin FROM users WHERE id = ?').get(c.user.id)?.is_admin) sendTo(c, { t: 'expense.resetInfo', info });
  }
  function resetExpenses({ actor = null, scope = 'all' }) {
    const where = `deleted_at IS NULL${scope === 'shared' ? " AND visibility = 'group'" : ''}`;
    const rows = db.prepare(`SELECT id FROM expenses WHERE ${where}`).all().map((r) => r.id);
    if (!rows.length) return { batch: null, count: 0 };
    const batch = `r${now()}:${actor ? actor.id : 'dev'}`;
    const affected = new Set(db.prepare(`SELECT paid_by u FROM expenses WHERE ${where} UNION SELECT s.user_id FROM expense_shares s JOIN expenses e ON e.id = s.expense_id WHERE e.${where.replace(/ AND /g, ' AND e.')}`).all().map((r) => r.u));
    db.prepare(`UPDATE expenses SET deleted_at = ?, updated_by = ?, reset_batch = ? WHERE ${where}`).run(now(), actor?.id ?? null, batch);
    for (const id of rows) broadcast({ t: 'expense.del', id });
    const who = actor ? actor.name : 'The developer console';
    logActivity(actor?.id ?? null, `${who} cleared ${rows.length} expense${rows.length === 1 ? '' : 's'}${scope === 'shared' ? ' (shared ones)' : ''}. Balances start from zero.`);
    notifier.notify([...affected].map((uid) => ({ userId: uid, kinds: ['expenses', 'payments'], text: `${who} cleared ${scope === 'shared' ? 'all shared' : 'all'} expenses. Balances start from zero.` })),
      { actorId: actor?.id ?? null, ref: { type: 'reset', id: batch } });
    devPush('op', { user: actor ? actor.name : 'dev', op: 'expense.reset', ok: true, count: rows.length, scope });
    pushResetInfo();
    return { batch, count: rows.length };
  }
  function restoreExpenseReset(batch, actor = null) {
    const ids = db.prepare('SELECT id FROM expenses WHERE reset_batch = ? AND deleted_at IS NOT NULL').all(batch).map((r) => r.id);
    if (!ids.length) return { count: 0 };
    db.prepare('UPDATE expenses SET deleted_at = NULL, reset_batch = NULL, updated_by = ? WHERE reset_batch = ?').run(actor?.id ?? null, batch);
    for (const id of ids) broadcastExpense(id);
    const who = actor ? actor.name : 'The developer console';
    logActivity(actor?.id ?? null, `${who} brought back ${ids.length} cleared expense${ids.length === 1 ? '' : 's'}`);
    const affected = new Set(ids.flatMap((id) => involved(getExpense(id))));
    notifier.notify([...affected].map((uid) => ({ userId: uid, kinds: ['expenses', 'payments'], text: `${who} brought back ${ids.length} expenses that were cleared` })),
      { actorId: actor?.id ?? null, ref: { type: 'reset', id: batch } });
    pushResetInfo();
    return { count: ids.length };
  }

  // Reactions people can send each other. Kept short so the row fits on a phone.
  const REACTIONS = ['👋', '❤️', '😂', '🎉', '🙏', '👍', '😮', '🍻'];
  // Custom emojis: written :name: wherever an emoji goes (reactions), drawn from a small image.
  const EMOJI_MAX = 100, EMOJI_PX = 128, EMOJI_BYTES = 64 * 1024;
  const EMOJI_NAME = /^[a-z0-9_]{2,24}$/;
  const customEmojis = () => db.prepare('SELECT * FROM custom_emojis WHERE deleted_at IS NULL ORDER BY id').all()
    .map((e) => ({ name: e.name, url: `/api/emoji/${e.file}`, by: e.created_by, at: e.created_at }));
  // ---- picture a day ----
  const PHOTOS_PER_DAY = 5;
  const PHOTO_LIMIT = (+env.PHOTO_LIMIT_MB || 2048) * 1024 * 1024; // all photos together (R2's free tier is 10 GB)
  const photoList = () => {
    const likes = {};
    for (const l of db.prepare('SELECT photo_id, user_id FROM photo_likes').all()) (likes[l.photo_id] ||= []).push(l.user_id);
    return db.prepare('SELECT * FROM daily_photos WHERE deleted_at IS NULL ORDER BY day, id').all().map((p) => ({
      id: p.id, day: p.day, by: p.user_id, url: `/api/photos/f/${p.file}`, thumb: `/api/photos/f/${p.thumb}`, w: p.width, h: p.height,
      bytes: p.bytes, caption: p.caption || '', takenAt: p.taken_at, at: p.created_at, likes: likes[p.id] || [] }));
  };
  // ---- stays ----
  const listStays = () => db.prepare('SELECT * FROM stays WHERE deleted_at IS NULL ORDER BY COALESCE(start_day, \'0\'), created_at').all()
    .map((s) => ({ id: s.id, name: s.name, address: s.address || '', lat: s.lat, lng: s.lng, startDay: s.start_day, endDay: s.end_day, notes: s.notes || '', by: s.created_by }));
  const broadcastStays = () => broadcast({ t: 'stays', stays: listStays() });
  const gifCache = new Map(), gifCount = new Map(); // GIF search: short-lived results, per-person limit
  const activeUsers = () => db.prepare('SELECT id, name FROM users WHERE removed_at IS NULL').all();
  const photoBytes = () => db.prepare('SELECT COALESCE(SUM(bytes), 0) n FROM daily_photos WHERE deleted_at IS NULL').get().n;
  const broadcastPhotos = () => broadcast({ t: 'photos', list: photoList(), bytes: photoBytes(), limit: PHOTO_LIMIT });
  const isReaction = (s) => REACTIONS.includes(s)
    || (/^:[a-z0-9_]{2,24}:$/.test(s) && !!db.prepare('SELECT 1 FROM custom_emojis WHERE name = ? AND deleted_at IS NULL').get(s.slice(1, -1)));
  const recentReactions = (uid) => db.prepare('SELECT * FROM reactions WHERE from_id = ? OR to_id = ? ORDER BY id DESC LIMIT 60').all(uid, uid)
    .map((r) => ({ id: r.id, from: r.from_id, to: r.to_id, emoji: r.emoji, ts: r.ts }));

  // ---------- accounts ----------
  function kickUser(id) {
    for (const c of clients) if (c.user.id === id) { sendTo(c, { t: 'kicked' }); c.ws.close(); }
  }
  function removeMember(target, by) {
    auth.revokeUser(target.id);
    db.prepare('UPDATE users SET removed_at = ?, removed_by = ?, share_location = 0, owntracks_token = NULL, is_admin = 0 WHERE id = ?').run(now(), by?.id ?? null, target.id);
    db.prepare('DELETE FROM votes WHERE user_id = ?').run(target.id);
    db.prepare('DELETE FROM locations WHERE user_id = ?').run(target.id);
    db.prepare('DELETE FROM subgroup_members WHERE user_id = ?').run(target.id);
    db.prepare('DELETE FROM password_resets WHERE user_id = ?').run(target.id);
    kickUser(target.id);
    broadcast({ t: 'users', users: listUsers() });
    broadcast({ t: 'loc', userId: target.id, loc: null });
    broadcastGroups();
    for (const id of db.prepare('SELECT DISTINCT place_id FROM votes').all().map((r) => r.place_id)) broadcastPlace(id); // vote counts changed
  }
  function makeResetLink(target, createdBy) {
    const token = newToken();
    const hash = crypto.createHash('sha256').update(token).digest('hex');
    db.prepare('DELETE FROM password_resets WHERE user_id = ? AND used_at IS NULL').run(target.id); // one live link at a time
    const expiresAt = now() + 24 * 3600e3;
    db.prepare('INSERT INTO password_resets(token_hash, user_id, created_by, created_at, expires_at) VALUES(?, ?, ?, ?, ?)').run(hash, target.id, createdBy, now(), expiresAt);
    devPush('op', { user: target.name, op: 'reset-link.create', ok: true, by: createdBy ? nameOf(createdBy) : 'developer console' });
    return { token, expiresAt, gate: auth.gateEnabled ? auth.gateToken : null };
  }

  // ---------- OwnTracks status (shown to each person in Settings) ----------
  function ownTracksStatus(u) {
    let info = {};
    try { info = JSON.parse(u.ot_info || '{}') || {}; } catch { /* ignore */ }
    return { result: u.ot_status || null, at: u.ot_status_at || null, okAt: u.ot_ok_at || null, info };
  }
  function recordOwnTracks(u, result, info) {
    const t = now();
    // A message that isn't a location (a region event, a waypoint list…) keeps the details of the last location.
    const keep = result.startsWith('ignored-') && result !== 'ignored-sharing-off';
    db.prepare(`UPDATE users SET ot_status = ?, ot_status_at = ?, ot_ok_at = CASE WHEN ? THEN ? ELSE ot_ok_at END, ot_info = CASE WHEN ? THEN ot_info ELSE ? END WHERE id = ?`)
      .run(result, t, result === 'stored' ? 1 : 0, t, keep && u.ot_info ? 1 : 0, JSON.stringify(info), u.id);
    const st = ownTracksStatus(db.prepare('SELECT * FROM users WHERE id = ?').get(u.id));
    for (const c of clients) if (c.user.id === u.id) sendTo(c, { t: 'owntracks.status', status: st });
  }

  const publicUser = (u) => ({
    id: u.id, name: u.name, color: u.color, isAdmin: !!u.is_admin, shareLocation: !!u.share_location, avatar: u.avatar ? `/api/avatars/${u.avatar}` : null,
    hasRecovery: !!u.recovery_hash,
    recoverySaved: !!u.recovery_hash && !u.recovery_pending && !!u.recovery_ack_at,
    ...(u.removed_at ? { removed: true, removedAt: u.removed_at } : {}),
  });
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
    return { name: t.name, start: t.start, end: t.end, timezone: t.timezone, autoConfirm: t.autoConfirm, vetoRule: t.vetoRule, currency: t.currency, photoReminder: t.photoReminder, joinCode: user ? t.joinCode : undefined };
  }

  function snapshot(user) {
    const me = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
    const admin = !!me.is_admin;
    return {
      t: 'state',
      me: { ...publicUser(me), owntracksToken: me.owntracks_token, notifyPrefs: prefsOf(me), owntracks: ownTracksStatus(me), recovery: recoveryInfo(me) },
      ...(me.is_admin ? { expenseReset: lastExpenseReset() } : {}),
      trip: tripForClient(user),
      users: listUsers(),
      places: db.prepare(`SELECT * FROM places ${admin ? '' : 'WHERE removed_at IS NULL'}`).all().map(placeRow),
      subgroups: listSubgroups(),
      stays: listStays(),
      chats: chat.listFor(me.id),
      expenses: db.prepare('SELECT * FROM expenses WHERE deleted_at IS NULL').all().map(expenseRow).filter((e) => canSeeExpense(me, e)),
      locations: listLocations(),
      online: onlineIds(),
      activity: recentActivity(),
      notifications: notifier.list(me.id),
      reactions: recentReactions(me.id),
      customEmojis: customEmojis(),
      photos: { list: photoList(), bytes: photoBytes(), limit: PHOTO_LIMIT },
      unread: notifier.unread(me.id),
      config: { ...CONFIG, version: VERSION, build: BUILD, server: env.HA_NODE || os.hostname(), reactions: REACTIONS, gifSearch: !!env.KLIPY_API_KEY, androidApp: androidPublic(), notifyKinds: Object.keys(NOTIFY_KINDS), gate: auth.gateEnabled ? auth.gateToken : null },
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
      // The page is stamped with the build it belongs to (see BUILD).
      const body = target === INDEX_FILE ? Buffer.from(fs.readFileSync(target, 'utf8').replace('{{BUILD}}', BUILD)) : null;
      if (COMPRESSIBLE.has(ext) && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
        const st = fs.statSync(target);
        const key = target + ':' + st.mtimeMs;
        let gz = gzCache.get(key);
        if (!gz) { gz = zlib.gzipSync(body || fs.readFileSync(target), { level: 9 }); gzCache.set(key, gz); }
        res.writeHead(200, { ...headers, 'Content-Encoding': 'gzip', 'Content-Length': gz.length });
        return res.end(req.method === 'HEAD' ? undefined : gz);
      }
      res.writeHead(200, headers);
      if (body) return res.end(req.method === 'HEAD' ? undefined : body);
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

  // Frankfurter moved to api.frankfurter.dev; the old host still answers, so it's the fallback.
  async function fxFetch(pathAndQuery) {
    let last;
    for (const host of ['https://api.frankfurter.dev/v1', 'https://api.frankfurter.app']) {
      try {
        const r = await fetch(host + pathAndQuery, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(8000) });
        if (!r.ok) throw new Error(`rates service returned ${r.status}`);
        return await r.json();
      } catch (e) { last = e; }
    }
    throw last;
  }

  const AVATAR_MAX_BYTES = 512 * 1024;
  // Old profile photos are deleted so they don't take up storage.
  function dropBlobIfUnused(key) {
    if (db.prepare('SELECT 1 FROM users WHERE avatar = ?').get(key) || db.prepare('SELECT 1 FROM attachments WHERE blob_key = ?').get(key)
      || db.prepare('SELECT 1 FROM custom_emojis WHERE file = ? AND deleted_at IS NULL').get(key)
      || db.prepare('SELECT 1 FROM daily_photos WHERE (file = ? OR thumb = ?) AND deleted_at IS NULL').get(key, key)
      || db.prepare('SELECT 1 FROM chat_messages WHERE (file = ? OR thumb = ?) AND deleted_at IS NULL').get(key, key)
      || androidApp()?.key === key) return;
    blobs.del?.(key).catch(() => {});
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
      // Android checks this to trust the Tabi app with the site's links. It has to be public (Google
      // fetches it without cookies), and only exists once an admin has uploaded the app.
      if (p === '/.well-known/assetlinks.json' && req.method === 'GET') {
        const a = androidApp() || (env.ANDROID_PACKAGE && env.ANDROID_CERT_SHA256 ? { package: env.ANDROID_PACKAGE, cert: env.ANDROID_CERT_SHA256.toUpperCase() } : null);
        if (!a) return send(res, 404, 'Not found');
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300', ...res._extraHeaders });
        return res.end(JSON.stringify(assetLinks(a)));
      }
      if (p === '/healthz') { const { servers, ...h } = getHealth(); return send(res, 200, { ok: true, ...h }); } // one "role" only: scripts read it

      // Developer console entry: /dev?devkey=<DEV_KEY> once per device, then /dev
      if (DEV_KEY && (p === '/dev' || p === '/dev/')) {
        const k = url.searchParams.get('devkey');
        if (k) {
          if (rateLimited(clientIp(req))) return send(res, 429, 'Too many attempts. Wait 10 minutes.');
          if (!auth.safeEqual(k, DEV_KEY)) { devPush('op', { user: '-', op: 'dev.login', ok: false, error: 'wrong dev key', ip: clientIp(req) }); return send(res, 404, 'Not found'); }
          addCookie(res, auth.makeCookie(req, 'tabi_dev', devToken, 30 * 86400));
          if (auth.gateEnabled) addCookie(res, auth.makeCookie(req, 'tabi_gate', auth.gateToken, 400 * 86400));
          console.log(`[dev] console unlocked from ${clientIp(req)}`);
          res.writeHead(302, { Location: '/dev', 'Cache-Control': 'no-store', ...res._extraHeaders });
          return res.end();
        }
        if (!isDev(req)) return send(res, 404, 'Not found');
        res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer', ...res._extraHeaders });
        return res.end(fs.readFileSync(path.join(root, 'public/dev.html')));
      }
      if (p.startsWith('/api/dev/')) {
        if (!isDev(req)) return send(res, 404, { error: 'Not found' });
        return devApi(req, res, url, p);
      }

      // Private-link gate. Without the key the site looks like nothing is there.
      const gate = isDev(req) ? { ok: true } : auth.checkGate(req, url);
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
        if (!trip.joinCode || String(b.code || '').trim().toUpperCase() !== trip.joinCode) {
          devPush('op', { user: String(b.name || '').slice(0, 30), op: 'join', ok: false, error: 'bad invite code', ip: clientIp(req) });
          return send(res, 403, { error: 'That invite code is not valid. Ask for a fresh invite link.' });
        }
        const name = validName(b.name);
        if (!name) return send(res, 400, { error: 'Enter a name up to 24 characters.' });
        if (String(b.password || '').length < 6) return send(res, 400, { error: 'Use a password with at least 6 characters.' });
        const taken = db.prepare('SELECT removed_at FROM users WHERE name = ?').get(name);
        if (taken?.removed_at) return send(res, 409, { error: `${name} is the name of someone who left the trip. If that's you, ask a trip admin to bring your account back, so your expenses stay with you. Otherwise pick another name.` });
        if (taken) return send(res, 409, { error: `Someone is already called ${name}. Pick another name, or sign in instead. Forgot your password? Use “Forgot password?” on the sign-in screen.` });
        const used = new Set(db.prepare('SELECT color FROM users').all().map((u) => u.color));
        const color = b.color || COLORS.find((c) => !used.has(c)) || COLORS[userCount() % COLORS.length];
        const r = db.prepare('INSERT INTO users(name, color, pass_hash, created_at, owntracks_token) VALUES(?, ?, ?, ?, ?)')
          .run(name, color, hashPassword(b.password), now(), newToken().slice(0, 20));
        const id = Number(r.lastInsertRowid);
        broadcast({ t: 'users', users: listUsers() });
        logActivity(id, `${name} joined the trip`);
        notifier.notify(listUsers().map((x) => ({ userId: x.id, kinds: ['people'], text: `${name} joined the trip` })), { actorId: id, ref: { type: 'user', id } });
        addCookie(res, auth.create(req, id).setCookie);
        return send(res, 200, { ok: true });
      }

      if (p === '/api/login' && req.method === 'POST') {
        if (rateLimited(clientIp(req))) return send(res, 429, { error: 'Too many attempts. Wait 10 minutes and try again.' });
        const b = await readBody(req);
        const u = db.prepare('SELECT * FROM users WHERE name = ?').get(String(b.name || '').trim());
        if (u?.removed_at && checkPassword(String(b.password || ''), u.pass_hash)) {
          return send(res, 403, { error: 'This account was removed from the trip. Ask a trip admin to bring it back.' });
        }
        if (!u || u.removed_at || !checkPassword(String(b.password || ''), u.pass_hash)) {
          devPush('op', { user: String(b.name || '').slice(0, 30), op: 'login', ok: false, error: u ? 'wrong password' : 'no such name', ip: clientIp(req) });
          return send(res, 401, { error: 'Name or password is wrong.' });
        }
        devPush('op', { user: u.name, op: 'login', ok: true, ip: clientIp(req) });
        addCookie(res, auth.create(req, u.id).setCookie);
        return send(res, 200, { ok: true });
      }

      // ---- forgotten passwords ----
      // 1. With a recovery code (set up in the app beforehand): name + code + new password.
      if (p === '/api/recover' && req.method === 'POST') {
        if (rateLimited(clientIp(req))) return send(res, 429, { error: 'Too many attempts. Wait 10 minutes and try again.' });
        const b = await readBody(req);
        if (String(b.password || '').length < 6) return send(res, 400, { error: 'Use a new password with at least 6 characters.' });
        const u = db.prepare('SELECT * FROM users WHERE name = ? AND removed_at IS NULL').get(String(b.name || '').trim());
        const f = u && recoverFails.get(u.id);
        if (f && now() - f.ts < 3600e3 && f.n >= 5) return send(res, 429, { error: 'Too many wrong codes for this name. Wait an hour, or ask a trip admin for a reset link.' });
        if (!u || !u.recovery_hash || !checkPassword(normRecoveryCode(b.code), u.recovery_hash)) {
          if (u) recoverFails.set(u.id, { n: (f && now() - f.ts < 3600e3 ? f.n : 0) + 1, ts: f && now() - f.ts < 3600e3 ? f.ts : now() });
          devPush('op', { user: String(b.name || '').slice(0, 30), op: 'recover', ok: false, error: !u ? 'no such name' : !u.recovery_hash ? 'no recovery code set' : 'wrong code', ip: clientIp(req) });
          return send(res, 401, { error: 'That name and recovery code don’t match. If you never saved a recovery code, ask a trip admin for a reset link.' });
        }
        recoverFails.delete(u.id);
        // The code is used up: set the new password and hand out a fresh code straight away.
        const code = newRecoveryCode();
        db.prepare('UPDATE users SET pass_hash = ?, recovery_hash = ?, recovery_set_at = ?, recovery_pending = ?, recovery_ack_at = NULL WHERE id = ?').run(hashPassword(b.password), hashPassword(normRecoveryCode(code)), now(), code, u.id);
        auth.revokeUser(u.id);
        kickUser(u.id);
        addCookie(res, auth.create(req, u.id).setCookie);
        notifier.notify([{ userId: u.id, kinds: ['security'], text: 'Your password was reset with your recovery code, and you were signed out on your other devices. You have a new recovery code.' }], { ref: { type: 'account', id: u.id } });
        devPush('op', { user: u.name, op: 'recover', ok: true, ip: clientIp(req) });
        return send(res, 200, { ok: true, code });
      }
      // 2. No recovery code: ask the trip admins for a reset link. Same answer whatever the name, so it can't be used to probe.
      if (p === '/api/recover/help' && req.method === 'POST') {
        if (rateLimited(clientIp(req))) return send(res, 429, { error: 'Too many attempts. Wait 10 minutes and try again.' });
        const b = await readBody(req);
        const u = db.prepare('SELECT * FROM users WHERE name = ? AND removed_at IS NULL').get(String(b.name || '').trim());
        if (u && now() - (helpAsked.get(u.id) || 0) > 30 * 60e3) {
          helpAsked.set(u.id, now());
          const admins = db.prepare('SELECT id FROM users WHERE is_admin = 1 AND removed_at IS NULL AND id != ?').all(u.id);
          notifier.notify(admins.map((a) => ({ userId: a.id, kinds: ['help'], text: `${u.name} can’t sign in and asked for a password reset link. Open Settings → People → ${u.name} → Reset password.` })),
            { ref: { type: 'help', id: u.id } });
          devPush('op', { user: u.name, op: 'recover.help', ok: true, admins: admins.length, ip: clientIp(req) });
        }
        return send(res, 200, { ok: true });
      }
      // 3. A reset link from an admin (or the developer console): one use, 24 hours.
      if (p === '/api/reset' && (req.method === 'GET' || req.method === 'POST')) {
        if (rateLimited(clientIp(req))) return send(res, 429, { error: 'Too many attempts. Wait 10 minutes and try again.' });
        const b = req.method === 'POST' ? await readBody(req) : { token: url.searchParams.get('token') };
        const hash = crypto.createHash('sha256').update(String(b.token || '')).digest('hex');
        const r = db.prepare('SELECT r.*, u.name, u.removed_at FROM password_resets r JOIN users u ON u.id = r.user_id WHERE r.token_hash = ?').get(hash);
        if (!r || r.used_at || r.expires_at < now() || r.removed_at) {
          return send(res, 410, { error: r?.used_at ? 'This reset link has already been used. Ask a trip admin for a new one.' : 'This reset link has expired or isn’t valid. Ask a trip admin for a new one.' });
        }
        if (req.method === 'GET') return send(res, 200, { name: r.name, expiresAt: r.expires_at });
        if (String(b.password || '').length < 6) return send(res, 400, { error: 'Use a password with at least 6 characters.' });
        db.prepare('UPDATE users SET pass_hash = ? WHERE id = ?').run(hashPassword(b.password), r.user_id);
        db.prepare('UPDATE password_resets SET used_at = ? WHERE token_hash = ?').run(now(), hash);
        auth.revokeUser(r.user_id);
        kickUser(r.user_id);
        addCookie(res, auth.create(req, r.user_id).setCookie);
        notifier.notify([{ userId: r.user_id, kinds: ['security'], text: 'You set a new password with a reset link, and were signed out on your other devices.' }], { ref: { type: 'account', id: r.user_id } });
        if (r.created_by && r.created_by !== r.user_id) notifier.notify([{ userId: r.created_by, kinds: ['help', 'people'], text: `${r.name} set a new password with your reset link` }], { ref: { type: 'user', id: r.user_id } });
        devPush('op', { user: r.name, op: 'reset-link', ok: true, ip: clientIp(req) });
        return send(res, 200, { ok: true });
      }

      // OwnTracks HTTP mode: Basic auth with <name>:<owntracks token>
      if (p === '/api/owntracks' && req.method === 'POST') {
        const h = String(req.headers.authorization || '');
        const [name, tok] = h.startsWith('Basic ') ? Buffer.from(h.slice(6), 'base64').toString().split(':') : [];
        // Usernames match without regard to case: "kenny" in OwnTracks is a common slip for "Kenny".
        const u = name && (db.prepare('SELECT * FROM users WHERE name = ?').get(name) || db.prepare('SELECT * FROM users WHERE name = ? COLLATE NOCASE').get(name));
        if (!u || !tok || !u.owntracks_token || tok !== u.owntracks_token) {
          devPush('owntracks', { user: name || '(none)', result: !h ? 'no-credentials' : !u ? 'unknown-user' : 'bad-token', ip: clientIp(req), ua: String(req.headers['user-agent'] || '').slice(0, 80) });
          if (u && tok) recordOwnTracks(u, 'bad-token', { ua: String(req.headers['user-agent'] || '').slice(0, 80) });
          return send(res, 401, { error: 'Bad OwnTracks credentials' }, { 'WWW-Authenticate': 'Basic realm="tabi"' });
        }
        const b = await readBody(req);
        const result = b._type !== 'location' ? `ignored-${b._type || 'unknown'}` : !u.share_location ? 'ignored-sharing-off' : 'stored';
        devPush('owntracks', {
          user: u.name, userId: u.id, result, type: b._type, lat: b.lat, lon: b.lon, acc: b.acc, batt: b.batt, vel: b.vel, conn: b.conn,
          trigger: b.t, tst: b.tst ? b.tst * 1000 : null, device: String(req.headers['x-limit-d'] || b.tid || ''), ip: clientIp(req), ua: String(req.headers['user-agent'] || '').slice(0, 80),
        });
        if (result === 'stored') {
          updateLocation(u, { lat: b.lat, lng: b.lon, acc: b.acc, heading: b.cog, speed: b.vel != null ? b.vel / 3.6 : null, batt: b.batt, ts: b.tst ? b.tst * 1000 : now() }, 'owntracks');
        }
        recordOwnTracks(u, result, {
          type: b._type, batt: b.batt, acc: b.acc, trigger: b.t, fix: b.tst ? b.tst * 1000 : null, conn: b.conn,
          device: String(req.headers['x-limit-d'] || b.tid || '').slice(0, 40), ua: String(req.headers['user-agent'] || '').slice(0, 80),
        });
        // For the Tabi Android app: is there a newer version, and is sharing switched off in Tabi?
        const app = androidApp();
        if (app) res.setHeader('X-Tabi-App-Latest', String(app.versionCode));
        res.setHeader('X-Tabi-Sharing', u.share_location ? 'on' : 'off');
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
      // Activity history (the last 500 things), newest first, with optional search. before = id to page from.
      if (p === '/api/activity' && req.method === 'GET') {
        const q = String(url.searchParams.get('q') || '').trim().slice(0, 80);
        const before = parseInt(url.searchParams.get('before'), 10) || Number.MAX_SAFE_INTEGER;
        const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit'), 10) || 20, 1), 100);
        const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
        const rows = db.prepare(`SELECT * FROM activity WHERE id < ? ${q ? "AND text LIKE ? ESCAPE '\\'" : ''} ORDER BY id DESC LIMIT ?`)
          .all(...(q ? [before, like, limit + 1] : [before, limit + 1]));
        const total = q ? db.prepare("SELECT COUNT(*) n FROM activity WHERE text LIKE ? ESCAPE '\\'").get(like).n : null;
        return send(res, 200, { items: rows.slice(0, limit).map((a) => ({ id: a.id, ts: a.ts, userId: a.user_id, text: a.text })), more: rows.length > limit, total });
      }
      // Confirm the recovery code was saved (used by the "You're back in" screen, before the app connects)
      if (p === '/api/recovery/ack' && req.method === 'POST') {
        if (user.recovery_hash) db.prepare('UPDATE users SET recovery_pending = NULL, recovery_ack_at = ? WHERE id = ?').run(now(), user.id);
        pushRecovery(user.id);
        return send(res, 200, { ok: true });
      }
      // Errors from people's browsers, so they show up in the developer console
      // ---- Web Push (per device) ----
      if (p === '/api/push/key') return send(res, 200, { publicKey: pusher.publicKey() });
      if (p === '/api/push/status' && req.method === 'POST') {
        const b = await readBody(req).catch(() => ({}));
        return send(res, 200, { on: pusher.has(user.id, b.endpoint), devices: pusher.devicesOf(user.id).length });
      }
      if (p === '/api/push/subscribe' && req.method === 'POST') {
        const b = await readBody(req).catch(() => ({}));
        try { pusher.subscribe(user.id, b.subscription, req.headers['user-agent']); } catch (e) { return send(res, 400, { error: e.expose ? e.message : 'Couldn’t turn on notifications.' }); }
        pusher.noteOrigin(`${req.headers['x-forwarded-proto'] === 'https' || TRUST_PROXY ? 'https' : 'http'}://${req.headers.host}`);
        devPush('op', { user: user.name, op: 'push.subscribe', ok: true });
        return send(res, 200, { ok: true });
      }
      if (p === '/api/push/unsubscribe' && req.method === 'POST') {
        const b = await readBody(req).catch(() => ({}));
        pusher.unsubscribe(user.id, b.endpoint);
        devPush('op', { user: user.name, op: 'push.unsubscribe', ok: true });
        return send(res, 200, { ok: true });
      }
      if (p === '/api/push/test' && req.method === 'POST') {
        const b = await readBody(req).catch(() => ({}));
        if (!pusher.has(user.id, b.endpoint)) return send(res, 400, { error: 'Notifications aren’t on for this device yet.' });
        const gate = auth.gateEnabled ? `gate=${auth.gateToken}&` : '';
        const [r] = await pusher.send(user.id, { title: getTrip().name || 'Tabi', body: 'Notifications work on this device. You’ll get them here when Tabi is closed.', tag: 'test', url: `/?${gate}` }, { endpoint: b.endpoint, ttl: 300 });
        if (!r?.ok) return send(res, 502, { error: r?.gone ? 'The browser cancelled notifications for this device. Turn them on again.' : `The push service didn’t accept it (${r?.status || r?.error || 'no answer'}).` });
        return send(res, 200, { ok: true });
      }
      if (p === '/api/clientlog' && req.method === 'POST') {
        const b = await readBody(req).catch(() => ({}));
        const n = (clientLogCount.get(user.id) || 0) + 1;
        clientLogCount.set(user.id, n);
        if (n <= 30) devPush('client', { user: user.name, msg: String(b.msg || '').slice(0, 400), where: String(b.where || '').slice(0, 200), ua: String(req.headers['user-agent'] || '').slice(0, 160), build: String(b.build || '').slice(0, 30), screen: String(b.screen || '').slice(0, 40) });
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

      // An address (or a map link) to a spot on the map, for stays. Japanese addresses with building
      // numbers often aren't in OpenStreetMap, so we retry with less detail and say it's approximate.
      if (p === '/api/address' && req.method === 'GET') {
        const q = String(url.searchParams.get('q') || '').trim().slice(0, 200);
        if (!q) return send(res, 200, { results: [] });
        if (/^https?:\/\//i.test(q)) {
          const r = await resolveLink(q, cache);
          return send(res, 200, { results: r?.ok ? [{ name: r.name || 'Pinned spot', lat: r.lat, lng: r.lng, address: r.address || '' }] : [], fromLink: true });
        }
        const tries = [q];
        const noPost = q.replace(/〒?\s*\d{3}[-‐－ー]?\d{4}/g, '').replace(/,\s*Japan$/i, '').trim();
        if (noPost && noPost !== q) tries.push(noPost);
        const noNum = noPost.replace(/[\s,]*[0-9０-９]+([-‐－−ー〜の][0-9０-９]+)*\s*(丁目|番地?|号)?\s*$/u, '').replace(/[0-9０-９]+[-‐－−ー][0-9０-９]+([-‐－−ー][0-9０-９]+)?/gu, '').replace(/\s{2,}/g, ' ').trim();
        if (noNum && !tries.includes(noNum)) tries.push(noNum);
        for (const [i, t] of tries.entries()) {
          try {
            const results = await photon(`/api?limit=5&lang=en&bbox=122.9,24.0,146.0,45.6&q=${encodeURIComponent(t)}`);
            if (results.length) return send(res, 200, { results, approximate: i > 0, used: t });
          } catch { return send(res, 502, { error: 'Address search is unavailable right now. Paste a Google Maps link, or set it on the map.' }); }
        }
        return send(res, 200, { results: [] });
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
          const j = await fxFetch(`/latest?base=${from}&symbols=${to}`);
          const rate = j.rates?.[to];
          if (!rate) throw new Error('no rate');
          const out = { rate, date: j.date };
          cache.set(key, out);
          return send(res, 200, out);
        } catch { return send(res, 502, { error: 'Could not look up the exchange rate. Type it in instead.' }); }
      }

      // All rates against EUR (ECB via Frankfurter), for the converter. Cached for 6 hours.
      if (p === '/api/rates' && req.method === 'GET') {
        const hit = cache.get('fx:table', 6 * 3600e3);
        if (hit) return send(res, 200, hit);
        try {
          const j = await fxFetch('/latest');
          const rates = { EUR: 1 };
          for (const [k, v] of Object.entries(j.rates || {})) if (k in CURRENCIES) rates[k] = v;
          const out = { base: 'EUR', date: j.date, rates, fetchedAt: now() };
          cache.set('fx:table', out);
          return send(res, 200, out);
        } catch {
          const old = cache.get('fx:table', 365 * 864e5);
          if (old) return send(res, 200, { ...old, stale: true });
          return send(res, 502, { error: 'Could not look up exchange rates right now.' });
        }
      }

      // Profile photos: square, at most 640×640, already cropped and resized in the browser.
      if (p === '/api/avatar' && (req.method === 'POST' || req.method === 'DELETE')) {
        const old = user.avatar;
        let key = null;
        if (req.method === 'POST') {
          const mime = String(req.headers['content-type'] || '').split(';')[0];
          const ext = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }[mime];
          if (!ext) return send(res, 415, { error: 'Use a JPEG, PNG or WebP image.' });
          const buf = await readRaw(req, AVATAR_MAX_BYTES);
          const size = imageSize(buf);
          if (!size || size.type !== ext) return send(res, 400, { error: 'That image could not be read.' });
          if (size.width !== size.height) return send(res, 400, { error: 'Profile photos have to be square.' });
          if (size.width > 640 || size.width < 64) return send(res, 400, { error: 'Profile photos must be between 64 and 640 pixels wide.' });
          key = await blobs.put(buf, ext);
        }
        db.prepare('UPDATE users SET avatar = ? WHERE id = ?').run(key, user.id);
        broadcast({ t: 'users', users: listUsers() });
        if (old && old !== key) dropBlobIfUnused(old);
        return send(res, 200, { ok: true, avatar: key ? `/api/avatars/${key}` : null });
      }
      const av = p.match(/^\/api\/avatars\/([a-f0-9]{64}\.(?:jpg|png|webp))$/);
      if (av && req.method === 'GET') {
        if (!db.prepare('SELECT 1 FROM users WHERE avatar = ?').get(av[1])) return send(res, 404, { error: 'Not found' });
        const buf = await blobs.get(av[1]);
        if (!buf) return send(res, 404, { error: 'Not found' });
        const type = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' }[av[1].split('.').pop()];
        res.writeHead(200, { 'Content-Type': type, 'Content-Length': buf.length, 'Cache-Control': 'private, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff', ...res._extraHeaders });
        return res.end(buf);
      }

      // Custom emojis: square, at most 128×128 and 64 KB, already cropped and shrunk in the browser.
      if (p === '/api/emoji' && req.method === 'POST') {
        const name = String(url.searchParams.get('name') || '').toLowerCase();
        if (!EMOJI_NAME.test(name)) return send(res, 400, { error: 'Names are 2 to 24 letters, numbers or _ (like ramen or kai_wave).' });
        if (db.prepare('SELECT 1 FROM custom_emojis WHERE name = ? AND deleted_at IS NULL').get(name)) return send(res, 409, { error: `There’s already a :${name}:. Pick another name.` });
        if (db.prepare('SELECT COUNT(*) n FROM custom_emojis WHERE deleted_at IS NULL').get().n >= EMOJI_MAX) return send(res, 400, { error: `The trip already has ${EMOJI_MAX} custom emojis. Remove one first.` });
        const mime = String(req.headers['content-type'] || '').split(';')[0];
        const ext = { 'image/png': 'png', 'image/webp': 'webp', 'image/jpeg': 'jpg' }[mime];
        if (!ext) return send(res, 415, { error: 'Use a PNG or WebP image.' });
        let buf;
        try { buf = await readRaw(req, EMOJI_BYTES); } catch { return send(res, 413, { error: 'Emojis can be 64 KB at most.' }); }
        const size = imageSize(buf);
        if (!size || size.type !== ext) return send(res, 400, { error: 'That image could not be read.' });
        if (size.width !== size.height || size.width > EMOJI_PX || size.width < 16) return send(res, 400, { error: `Emojis must be square, ${EMOJI_PX}×${EMOJI_PX} pixels at most.` });
        const file = await blobs.put(buf, ext);
        db.prepare('INSERT INTO custom_emojis(name, file, created_by, created_at) VALUES(?, ?, ?, ?)').run(name, file, user.id, now());
        broadcast({ t: 'emojis', list: customEmojis() });
        logActivity(user.id, `${user.name} added the emoji :${name}:`);
        devPush('op', { user: user.name, op: 'emoji.add', ok: true, name, bytes: buf.length });
        return send(res, 200, { ok: true, name });
      }
      const em = p.match(/^\/api\/emoji\/([a-z0-9_]{2,24})$/);
      if (em && req.method === 'DELETE') {
        const e = db.prepare('SELECT * FROM custom_emojis WHERE name = ? AND deleted_at IS NULL').get(em[1]);
        if (!e) return send(res, 404, { error: 'That emoji is already gone.' });
        if (e.created_by !== user.id && !user.is_admin) return send(res, 403, { error: 'Only whoever added it, or a trip admin, can remove it.' });
        db.prepare('UPDATE custom_emojis SET deleted_at = ? WHERE id = ?').run(now(), e.id);
        dropBlobIfUnused(e.file);
        broadcast({ t: 'emojis', list: customEmojis() });
        logActivity(user.id, `${user.name} removed the emoji :${e.name}:`);
        return send(res, 200, { ok: true });
      }
      const emf = p.match(/^\/api\/emoji\/([a-f0-9]{64}\.(?:png|webp|jpg))$/);
      if (emf && req.method === 'GET') {
        if (!db.prepare('SELECT 1 FROM custom_emojis WHERE file = ?').get(emf[1])) return send(res, 404, { error: 'Not found' });
        const buf = await blobs.get(emf[1]);
        if (!buf) return send(res, 404, { error: 'Not found' });
        res.writeHead(200, { 'Content-Type': { png: 'image/png', webp: 'image/webp', jpg: 'image/jpeg' }[emf[1].split('.').pop()], 'Content-Length': buf.length, 'Cache-Control': 'private, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff', ...res._extraHeaders });
        return res.end(buf);
      }

      // ---- group chat: photos and GIFs ----
      // Same envelope as picture a day: [4-byte length][thumbnail][photo]. The "photo" can also be an
      // animated GIF from the phone (kept as it is, 5 MB at most); the thumbnail is its first frame.
      if (p === '/api/chat/photo' && req.method === 'POST') {
        let meta = {};
        try { meta = JSON.parse(decodeURIComponent(String(req.headers['x-chat-meta'] || '{}'))); } catch { /* checked below */ }
        if (!chat.canSee(user.id, String(meta.chat || ''))) return send(res, 403, { error: 'You’re not in that chat.' });
        let buf;
        try { buf = await readRaw(req, 6 * 1024 * 1024); } catch { return send(res, 413, { error: 'That’s too big (5 MB at most).' }); }
        const tl = buf.length > 4 ? buf.readUInt32BE(0) : 0;
        const thumbBuf = buf.subarray(4, 4 + tl), fullBuf = buf.subarray(4 + tl);
        const ts = imageSize(thumbBuf), fsz = imageSize(fullBuf);
        if (!tl || !ts || !fsz || ts.type === 'gif') return send(res, 400, { error: 'That picture could not be read.' });
        if (fsz.type === 'gif' ? fullBuf.length > 5 * 1024 * 1024 : Math.max(fsz.width, fsz.height) > 2560) return send(res, 400, { error: 'The picture wasn’t shrunk properly. Reload Tabi and try again.' });
        if (Math.max(ts.width, ts.height) > 640 || thumbBuf.length > 300 * 1024) return send(res, 400, { error: 'The preview is too big.' });
        const limit = (+env.CHAT_MEDIA_LIMIT_MB || 3072) * 1048576;
        if (chat.mediaBytes() + buf.length > limit) return send(res, 507, { error: 'The chat’s space for pictures is full. An admin can delete old pictures, or raise CHAT_MEDIA_LIMIT_MB on the server.' });
        const file = await blobs.put(fullBuf, fsz.type), thumb = await blobs.put(thumbBuf, ts.type);
        try {
          const m = chat.post(user, { chat: meta.chat, clientId: meta.clientId, kind: 'photo', text: meta.text, replyTo: meta.replyTo, file, thumb,
            width: fsz.width, height: fsz.height, bytes: fullBuf.length + thumbBuf.length, mime: { gif: 'image/gif', webp: 'image/webp', jpg: 'image/jpeg', png: 'image/png' }[fsz.type] });
          return send(res, 200, { ok: true, m });
        } catch (e) { dropBlobIfUnused(file); dropBlobIfUnused(thumb); return send(res, 400, { error: e.expose ? e.message : 'Couldn’t send it.' }); }
      }
      // The Android app: admins upload each build (from GitHub's android-build release); everyone signed in can download it
      if (p === '/api/app/apk' && req.method === 'POST') {
        if (!user.is_admin) return send(res, 403, { error: 'Only trip admins can upload the app.' });
        let buf;
        try { buf = await readRaw(req, APK_MAX); } catch { return send(res, 413, { error: `That file is over ${APK_MAX / 1048576} MB. Is it the right one?` }); }
        const info = appInfo(buf);
        if (info.error) return send(res, 400, { error: info.error });
        const prev = androidApp();
        const warnings = [];
        const here = String(req.headers.host || '').split(':')[0];
        if (info.host && here && !/^(localhost|127\.|\[)/.test(here) && info.host.toLowerCase() !== here.toLowerCase()) warnings.push(`It was built for ${info.host}, but this site is ${here}. Set the TABI_HOST variable on GitHub and build again.`);
        if (info.test) warnings.push('This is a test build, signed with a throwaway key. Phones that install it will have to uninstall it before a properly signed version can be installed.');
        if (prev && info.versionCode < prev.versionCode) warnings.push(`It’s older than the one it replaces (${prev.versionName}). Phones that already have the newer one won’t take it.`);
        if (prev && info.versionCode === prev.versionCode && prev.cert === info.cert && prev.commit !== info.commit) warnings.push('It has the same version number as the last one, so phones won’t see it as an update. Raise versionCode in android/version.properties.');
        if (prev && prev.cert !== info.cert) warnings.push('It’s signed with a different key than the last one. Phones must uninstall the old app before installing this one.');
        const key = await blobs.put(buf, 'apk');
        const app = { ...info, key, size: buf.length, at: now(), by: user.id };
        setSetting('androidApp', app);
        if (prev?.key && prev.key !== key) dropBlobIfUnused(prev.key);
        devPush('op', { user: user.name, op: 'android.upload', ok: true, version: info.versionName, code: info.versionCode, test: info.test });
        broadcast({ t: 'app', app: androidPublic(app) });
        return send(res, 200, { ok: true, app: androidPublic(app), warnings });
      }
      if (p === '/api/app/apk' && req.method === 'DELETE') {
        if (!user.is_admin) return send(res, 403, { error: 'Only trip admins can remove the app.' });
        const prev = androidApp();
        db.prepare("DELETE FROM settings WHERE key = 'androidApp'").run();
        if (prev?.key) dropBlobIfUnused(prev.key);
        broadcast({ t: 'app', app: null });
        return send(res, 200, { ok: true });
      }
      if (p === '/api/app/tabi.apk' && (req.method === 'GET' || req.method === 'HEAD')) {
        const app = androidApp();
        const buf = app && await blobs.get(app.key);
        if (!buf) return send(res, 404, { error: 'The Android app hasn’t been uploaded yet.' });
        res.writeHead(200, { 'Content-Type': 'application/vnd.android.package-archive', 'Content-Length': buf.length,
          'Content-Disposition': `attachment; filename="Tabi-${app.versionName}${app.test ? '-test' : ''}.apk"`, 'Cache-Control': 'private, no-cache', 'X-Content-Type-Options': 'nosniff', ...res._extraHeaders });
        return res.end(req.method === 'HEAD' ? undefined : buf);
      }
      const cf = p.match(/^\/api\/chat\/f\/([a-f0-9]{64}\.(?:jpg|png|webp|gif))$/);
      if (cf && req.method === 'GET') {
        if (!chat.canSeeFile(user.id, cf[1])) return send(res, 404, { error: 'Not found' });
        const buf = await blobs.get(cf[1]);
        if (!buf) return send(res, 404, { error: 'Not found' });
        res.writeHead(200, { 'Content-Type': { png: 'image/png', webp: 'image/webp', jpg: 'image/jpeg', gif: 'image/gif' }[cf[1].split('.').pop()], 'Content-Length': buf.length, 'Cache-Control': 'private, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff', ...res._extraHeaders });
        return res.end(buf);
      }
      // GIF search through KLIPY (Tenor's API closed in June 2026). The key stays on the server and no
      // one's identity is sent; the GIFs themselves load straight from KLIPY, as its terms require.
      if (p === '/api/gifs' && req.method === 'GET') {
        if (!env.KLIPY_API_KEY) return send(res, 200, { available: false, results: [] });
        const q = String(url.searchParams.get('q') || '').trim().slice(0, 80);
        const page = Math.max(1, Math.min(20, +url.searchParams.get('page') || 1));
        const n = (gifCount.get(user.id) || []).filter((t) => now() - t < 60e3);
        if (n.length >= 30) return send(res, 429, { error: 'Searching too fast. Try again in a moment.' });
        gifCount.set(user.id, [...n, now()]);
        const key = `${q}|${page}`;
        const hit = gifCache.get(key);
        if (hit && now() - hit.at < 10 * 60e3) return send(res, 200, hit.out);
        try {
          const path2 = q ? `gifs/search?q=${encodeURIComponent(q)}&` : 'gifs/trending?';
          const r = await fetch(`https://api.klipy.com/api/v1/${encodeURIComponent(env.KLIPY_API_KEY)}/${path2}page=${page}&per_page=24&content_filter=medium&locale=en`, { signal: AbortSignal.timeout(8000) });
          if (!r.ok) throw new Error(`KLIPY ${r.status}`);
          const j = await r.json();
          const items = (j?.data?.data || []).map((g) => {
            const f = g.file || {};
            const pick = (sizes, fmt) => { for (const s of sizes) { const x = f[s]?.[fmt]; if (x?.url && isKlipyMedia(x.url)) return x; } return null; };
            const send1 = pick(['md', 'hd', 'sm'], 'webp') || pick(['md', 'hd', 'sm'], 'gif');
            const prev = pick(['sm', 'xs', 'md'], 'webp') || pick(['sm', 'xs', 'md'], 'gif');
            const mp4 = pick(['md', 'hd', 'sm'], 'mp4');
            return send1 && prev ? { id: String(g.id || g.slug || ''), title: String(g.title || '').slice(0, 120), url: send1.url, w: send1.width, h: send1.height, preview: prev.url, pw: prev.width, ph: prev.height, mp4: mp4?.url || null } : null;
          }).filter(Boolean);
          const out = { available: true, results: items, more: !!j?.data?.has_next, page };
          gifCache.set(key, { at: now(), out });
          if (gifCache.size > 300) gifCache.delete(gifCache.keys().next().value);
          return send(res, 200, out);
        } catch (e) {
          console.log(new Date().toISOString(), 'gif search failed', { error: String(e.message || e).replace(env.KLIPY_API_KEY, '…') });
          return send(res, 502, { available: true, error: 'GIF search isn’t answering right now. Try again, or send a GIF from your phone.' });
        }
      }

      // Picture a day. The browser sends both sizes in one body: [4-byte length][thumbnail][photo],
      // already resized (photo ≤ 2560 px, thumbnail ≤ 640 px) with location data stripped.
      if (p === '/api/photos' && req.method === 'POST') {
        let meta = {};
        try { meta = JSON.parse(decodeURIComponent(String(req.headers['x-photo-meta'] || '{}'))); } catch { /* checked below */ }
        const day = String(meta.day || '');
        const t = getTrip(), today = tripToday();
        if (!isDay(day) || !day) return send(res, 400, { error: 'Which day is this photo for?' });
        if (day > today) return send(res, 400, { error: 'Photos can be added for today or earlier days.' });
        if (t.start && day < t.start) return send(res, 400, { error: 'That day is before the trip starts.' });
        if (t.end && day > t.end) return send(res, 400, { error: 'That day is after the trip ends.' });
        let buf;
        try { buf = await readRaw(req, 4 * 1024 * 1024); } catch { return send(res, 413, { error: 'That photo is too big (4 MB at most after shrinking).' }); }
        const tl = buf.length > 4 ? buf.readUInt32BE(0) : 0;
        const thumbBuf = buf.subarray(4, 4 + tl), fullBuf = buf.subarray(4 + tl);
        const ts = imageSize(thumbBuf), fs2 = imageSize(fullBuf);
        if (!tl || !ts || !fs2) return send(res, 400, { error: 'That photo could not be read.' });
        if (Math.max(fs2.width, fs2.height) > 2560 || Math.max(ts.width, ts.height) > 640 || thumbBuf.length > 300 * 1024) return send(res, 400, { error: 'The photo wasn’t shrunk properly. Reload Tabi and try again.' });
        if (photoBytes() + buf.length > PHOTO_LIMIT) return send(res, 507, { error: `The trip’s photo space is full (${PHOTO_LIMIT >= 1073741824 ? `${+(PHOTO_LIMIT / 1073741824).toFixed(1)} GB` : `${+(PHOTO_LIMIT / 1048576).toFixed(1)} MB`}). An admin can remove some photos, or raise PHOTO_LIMIT_MB on the server.` });
        const caption = str(meta.caption, 140);
        const [file, thumb] = [await blobs.put(fullBuf, fs2.type), await blobs.put(thumbBuf, ts.type)];
        // Checked again right before saving: two people adding the 5th photo at once
        const n = db.prepare('SELECT COUNT(*) n FROM daily_photos WHERE day = ? AND deleted_at IS NULL').get(day).n;
        if (n >= PHOTOS_PER_DAY) { dropBlobIfUnused(file); dropBlobIfUnused(thumb); return send(res, 409, { error: `This day already has ${PHOTOS_PER_DAY} photos. Remove one to add another.` }); }
        const id = Number(db.prepare('INSERT INTO daily_photos(day, user_id, file, thumb, width, height, bytes, caption, taken_at, created_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .run(day, user.id, file, thumb, fs2.width, fs2.height, fullBuf.length + thumbBuf.length, caption || null, Number.isFinite(+meta.takenAt) ? +meta.takenAt : null, now()).lastInsertRowid);
        broadcastPhotos();
        const nice = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(day + 'T00:00:00Z'));
        logActivity(user.id, `${user.name} added a photo for ${nice}`);
        notifier.notify(activeUsers().filter((u) => u.id !== user.id).map((u) => ({ userId: u.id, kinds: ['photos'], merge: 'count',
          text: (k) => (k > 1 ? `${k} new photos for ${day === today ? 'today' : nice}` : `${user.name} added ${n === 0 ? 'the first' : 'a'} photo for ${day === today ? 'today' : nice}`) })),
        { ref: { type: 'photos', id: day } }); // no actor: photos from different people merge into one "3 new photos" per day
        devPush('op', { user: user.name, op: 'photo.add', ok: true, day, bytes: buf.length });
        return send(res, 200, { ok: true, id });
      }
      const ph = p.match(/^\/api\/photos\/(\d+)$/);
      if (ph && req.method === 'DELETE') {
        const row = db.prepare('SELECT * FROM daily_photos WHERE id = ? AND deleted_at IS NULL').get(+ph[1]);
        if (!row) return send(res, 404, { error: 'That photo is already gone.' });
        if (row.user_id !== user.id && !user.is_admin) return send(res, 403, { error: 'Only whoever added it, or a trip admin, can remove it.' });
        db.prepare('UPDATE daily_photos SET deleted_at = ? WHERE id = ?').run(now(), row.id);
        db.prepare('DELETE FROM photo_likes WHERE photo_id = ?').run(row.id);
        dropBlobIfUnused(row.file); dropBlobIfUnused(row.thumb);
        broadcastPhotos();
        logActivity(user.id, `${user.name} removed a photo from ${row.day}`);
        return send(res, 200, { ok: true });
      }
      const phf = p.match(/^\/api\/photos\/f\/([a-f0-9]{64}\.(?:jpg|png|webp))$/);
      if (phf && req.method === 'GET') {
        if (!db.prepare('SELECT 1 FROM daily_photos WHERE (file = ? OR thumb = ?) AND deleted_at IS NULL').get(phf[1], phf[1])) return send(res, 404, { error: 'Not found' });
        const buf = await blobs.get(phf[1]);
        if (!buf) return send(res, 404, { error: 'Not found' });
        res.writeHead(200, { 'Content-Type': { png: 'image/png', webp: 'image/webp', jpg: 'image/jpeg' }[phf[1].split('.').pop()], 'Content-Length': buf.length, 'Cache-Control': 'private, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff', ...res._extraHeaders });
        return res.end(buf);
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

  // A notification goes to every open app of theirs; if none of them is on screen, also as a push
  // to the devices where they turned that on (so it reaches the lock screen).
  const pusher = createPusher({ db, getSetting, setSetting, env, log: (...a) => console.log(new Date().toISOString(), ...a) });
  const pushNotification = (userId, item, unread) => {
    const gate = auth.gateEnabled ? `gate=${auth.gateToken}&` : '';
    pusher.send(userId, { title: getTrip().name || 'Tabi', body: item.text, tag: `n${item.id}`, url: `/?${gate}n=${item.id}`, unread, ts: item.ts, kind: item.kind },
      { topic: `n${item.id}`, urgency: item.kind === 'security' ? 'high' : 'normal' })
      .then((rs) => { if (rs.length) devPush('op', { user: nameOf(userId), op: 'push.send', ok: rs.some((r) => r.ok), devices: rs.length, error: rs.find((r) => !r.ok)?.error || undefined }); })
      .catch(() => {});
  };
  const chat = createChat({
    db, nameOf: (id) => nameOf(id), activeUsers: () => activeUsers(), membersOf: (gid) => membersOf(gid),
    subgroupName: (gid) => db.prepare('SELECT name FROM subgroups WHERE id = ?').get(gid)?.name || null,
    sendToUsers: (ids, msg) => { const set = new Set(ids); const data = JSON.stringify(msg); for (const c of clients) if (set.has(c.user.id)) sendTo(c, data); },
    viewersOf: (ch) => new Set([...clients].filter((c) => c.visible !== false && c.chatOpen === ch).map((c) => c.user.id)),
    notifier: { notify: (...a) => notifier.notify(...a) }, isReaction: (e) => isReaction(e),
  });
  const notifier = createNotifier({ db, deliver: (userId, item, unread) => {
    let onScreen = false;
    for (const c of clients) if (c.user.id === userId) { sendTo(c, { t: 'notif', item, unread }); if (c.visible !== false) onScreen = true; }
    if (!onScreen) pushNotification(userId, item, unread);
  } });
  const notifyUnread = (userId) => { const n = notifier.unread(userId); for (const c of clients) if (c.user.id === userId) sendTo(c, { t: 'notif.unread', unread: n }); };

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
  // Subgroups changing changes who's in which chat
  const broadcastGroups = () => { broadcast({ t: 'subgroups', subgroups: listSubgroups() }); chat.sendChatList(onlineIds()); };
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
      const client = { ws, user: session.user, sessionHash: session.hash, alive: true, since: Date.now(), ip: clientIp(req), ua: String(req.headers['user-agent'] || '').slice(0, 160),
        build: String(url.searchParams.get('build') || '').slice(0, 40) }; // which build the page was loaded from
      clients.add(client);
      devPush('ws', { user: session.user.name, event: 'connected', ip: client.ip, build: client.build || undefined, outdated: client.build && client.build !== BUILD ? true : undefined });
      sendTo(client, snapshot(session.user));
      broadcastPresence();
      ws.on('pong', () => { client.alive = true; });
      ws.on('message', (raw) => {
        let msg;
        try { msg = JSON.parse(raw); } catch { return; }
        if (msg.t === 'ping') return ws.send('{"t":"pong"}');
        if (msg.t === 'vis') { client.visible = !!msg.v; return; } // is the app on screen? (decides push vs. in-app only)
        if (msg.t === 'chatview') { client.chatOpen = typeof msg.chat === 'string' ? msg.chat.slice(0, 80) : null; return; } // which chat is open (no notifications for it)
        if (msg.t !== 'op') return;
        const fresh = db.prepare('SELECT * FROM users WHERE id = ?').get(client.user.id);
        if (!fresh) { ws.send('{"t":"kicked"}'); return ws.close(); }
        client.user = fresh;
        let result;
        const t0 = Date.now();
        try {
          result = handleOp(fresh, msg.op, msg.data || {}, client) || { ok: true };
        } catch (e) {
          result = { ok: false, error: e.expose ? e.message : 'That change could not be saved.' };
          if (!e.expose) console.error(e);
        }
        if (msg.op !== 'loc.update') devPush('op', { user: fresh.name, op: String(msg.op).slice(0, 40), ok: result.ok !== false, error: result.error, ms: Date.now() - t0 });
        if (msg.id) ws.send(JSON.stringify({ t: 'ack', id: msg.id, ...result }));
      });
      ws.on('close', () => { clients.delete(client); broadcastPresence(); devPush('ws', { user: client.user.name, event: 'disconnected', ip: client.ip, seconds: Math.round((Date.now() - client.since) / 1000) }); });
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
  const purge = setInterval(() => { auth.purgeExpired(); notifier.purgeOld(); }, 6 * 3600e3);

  // The evening nudge for picture a day: once a day, at the trip's chosen time, if nobody has added one.
  function photoReminder(at = new Date()) {
    const t = getTrip();
    if (!t.photoReminder || t.photoReminder === 'off') return false;
    const today = tripToday();
    if ((t.start && today < t.start) || (t.end && today > t.end)) return false;
    const hm = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: t.timezone || 'Asia/Tokyo' }).format(at);
    if (hm < t.photoReminder || hm > '23:30') return false;
    if (getSetting('photoRemindedOn', null) === today) return false;
    setSetting('photoRemindedOn', today);
    if (db.prepare('SELECT 1 FROM daily_photos WHERE day = ? AND deleted_at IS NULL').get(today)) return false;
    notifier.notify(activeUsers().map((u) => ({ userId: u.id, kinds: ['photos'], text: 'No photo of the day yet. Got a good one from today? Anyone can add it (up to 5).' })), { ref: { type: 'photos', id: today } });
    devPush('op', { user: '-', op: 'photo.reminder', ok: true, day: today });
    return true;
  }
  const reminderTimer = setInterval(() => { try { photoReminder(); } catch (e) { console.error(e); } }, +env.PHOTO_REMINDER_EVERY_MS || 5 * 60e3);
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
    devPush('loc', { userId: user.id, user: user.name, source, lat: loc.lat, lng: loc.lng, acc: loc.acc, batt: loc.batt, speed: loc.speed, at: loc.ts, lagMs: Date.now() - loc.ts });
  }

  // ---------- notification wording ----------
  const nameOf = (id) => db.prepare('SELECT name FROM users WHERE id = ?').get(id)?.name || 'Someone';
  const allUserIds = () => db.prepare('SELECT id FROM users').all().map((u) => u.id);
  const membersOf = (gid) => db.prepare('SELECT user_id FROM subgroup_members WHERE subgroup_id = ?').all(gid).map((m) => m.user_id);
  const fmtMoney = (minor, cur) => {
    const d = CURRENCIES[cur] ?? 2;
    return new Intl.NumberFormat('en', { style: 'currency', currency: cur, minimumFractionDigits: d, maximumFractionDigits: d }).format(minor / 10 ** d);
  };
  const fmtDay = (d) => new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(d + 'T00:00:00Z'));
  const fmtRange = (a, b) => (!a ? '' : !b || a === b ? fmtDay(a) : `${fmtDay(a)} to ${fmtDay(b)}`);
  const tripToday = () => { try { return new Intl.DateTimeFormat('en-CA', { timeZone: getTrip().timezone || 'Asia/Tokyo' }).format(new Date()); } catch { return new Date().toISOString().slice(0, 10); } };

  // A place changed from `b` to `a` (raw rows; b null for a new place). Tells the person who added it,
  // admins when it's removed, and anyone whose plan (a confirmed stop from today on) it touches.
  function placeNews(actor, b, a) {
    if (!a) return;
    const t = tripToday();
    const inPlan = (r) => !!r && !r.removed_at && r.status === 'confirmed' && !!r.day && r.day >= t;
    const sees = (r, uid) => !r.group_id || membersOf(r.group_id).includes(uid);
    const who = actor?.name;
    const n = a.name;
    let mine = null, removed = null, plan = null;
    if (b && !b.removed_at && a.removed_at) {
      mine = `${who} removed ${n}, which you added`;
      removed = `${who} removed ${n}. It’s in Previously interested.`;
    } else if (b?.removed_at && !a.removed_at) mine = `${who} brought back ${n}`;
    else if (b && a.status !== b.status && (a.status === 'confirmed' || a.status === 'vetoed')) {
      mine = who ? `${who} ${a.status} ${n}, which you added` : `${n}, which you added, was ${a.status} by votes`;
    }
    const wasP = inPlan(b), isP = inPlan(a);
    const at = (r) => `${fmtDay(r.day)}${r.time ? ` at ${r.time}` : ''}`;
    if (!wasP && isP) plan = who ? `${who} added ${n} to the plan for ${at(a)}` : `${n} is on the plan for ${at(a)}, confirmed by votes`;
    else if (wasP && !isP) {
      if (a.removed_at) plan = `${who} removed ${n} from the plan for ${fmtDay(b.day)}`;
      else if (a.status === 'vetoed') plan = `${who || 'Votes'} vetoed ${n}. It’s off the plan for ${fmtDay(b.day)}.`;
      else if (a.status === 'visited' || a.status === 'skipped') plan = null;
      else if (!a.day) plan = `${who} unscheduled ${n}`;
      else plan = `${who} took ${n} off the plan for ${fmtDay(b.day)}`;
    } else if (wasP && isP) {
      if (a.day !== b.day) plan = `${who} moved ${n} to ${at(a)}`;
      else if (a.time !== b.time) plan = a.time ? `${who} set ${n} for ${at(a)}` : `${who} cleared the time for ${n} on ${fmtDay(a.day)}`;
    }
    if (!mine && !removed && !plan) return;
    const admins = new Set(db.prepare('SELECT id FROM users WHERE is_admin = 1').all().map((u) => u.id));
    const out = [];
    for (const uid of allUserIds()) {
      const kinds = [], text = {};
      if (mine && a.created_by === uid) { kinds.push('myPlaces'); text.myPlaces = mine; }
      if (removed && admins.has(uid)) { kinds.push('removed'); text.removed = removed; }
      if (plan && ((b && wasP && sees(b, uid)) || (isP && sees(a, uid)))) { kinds.push('plan'); text.plan = plan; }
      if (kinds.length) out.push({ userId: uid, kinds, text });
    }
    notifier.notify(out, { actorId: actor?.id ?? null, ref: { type: 'place', id: a.id } });
  }

  // How an expense leaves someone: >0 they're owed (they paid), <0 they owe.
  const position = (e, uid) => {
    if (!e) return 0;
    const share = e.shares.find((x) => x.userId === uid)?.amount || 0;
    return e.paidBy === uid ? e.amount - share : -share;
  };
  const involved = (e) => (e ? [e.paidBy, ...e.shares.map((x) => x.userId)] : []);

  function moneyNews(actor, b, a, { deleted = false } = {}) {
    const e = a || b;
    if (!e) return;
    const who = actor.name;
    const out = [];
    const people = [...new Set([...involved(b), ...involved(a)])];
    if (e.kind === 'payment') {
      const from = e.paidBy, to = e.shares[0]?.userId, amt = fmtMoney(e.amount, e.currency);
      for (const uid of people) {
        let text;
        if (deleted) text = `${who} deleted the ${amt} payment between you and ${nameOf(uid === from ? to : from)}`;
        else if (b) { if (b.amount === a.amount && b.paidBy === a.paidBy) continue; text = `${who} changed a payment between you and ${nameOf(uid === from ? to : from)} to ${amt}`; }
        else if (uid === to) text = actor.id === from ? `${who} paid you ${amt}` : `${who} recorded that ${nameOf(from)} paid you ${amt}`;
        else text = actor.id === to ? `${who} recorded your payment of ${amt}` : `${who} recorded that you paid ${nameOf(to)} ${amt}`;
        out.push({ userId: uid, kinds: ['payments'], text });
      }
    } else {
      const payerName = (x) => (x.paidBy === actor.id ? 'them' : nameOf(x.paidBy));
      for (const uid of people) {
        const pos = deleted ? 0 : position(a, uid), was = position(b, uid);
        let text;
        if (deleted) text = `${who} deleted ${e.title}`;
        else if (!b) {
          if (uid === a.paidBy) text = `${who} added ${a.title}, which you paid for${pos > 0 ? `. You’re owed ${fmtMoney(pos, a.currency)}.` : ''}`;
          else if (!pos) continue;
          else text = `${who} added ${a.title}. You owe ${payerName(a)} ${fmtMoney(-pos, a.currency)}.`;
        } else {
          if (pos === was && a.paidBy === b.paidBy && a.currency === b.currency) continue;
          if (!involved(a).includes(uid)) text = `${who} took you out of ${a.title}`;
          else if (pos > 0) text = `${who} changed ${a.title}. You’re now owed ${fmtMoney(pos, a.currency)}.`;
          else if (pos < 0) text = `${who} changed ${a.title}. You now owe ${payerName(a)} ${fmtMoney(-pos, a.currency)}.`;
          else text = `${who} changed ${a.title}. You don’t owe anything for it now.`;
        }
        out.push({ userId: uid, kinds: ['expenses'], text });
      }
    }
    notifier.notify(out, { actorId: actor.id, ref: { type: 'expense', id: e.id } });
  }

  const STATUS_WORDS = { suggested: 'moved back to suggested', maybe: 'marked as maybe', confirmed: 'confirmed', visited: 'marked as visited', skipped: 'skipped', vetoed: 'vetoed' };
  const tx = (fn) => { db.exec('BEGIN'); try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } };

  function handleOp(user, op, d) {
    const requireAdmin = () => { if (!user.is_admin) fail('Only trip admins can do that.'); };
    switch (op) {
      // ---- places ----
      case 'place.add': {
        const place = insertPlace(user, d.place || {});
        if (place) {
          broadcastPlace(place.id);
          logActivity(user.id, `${user.name} added ${place.name}`);
          notifier.notify(allUserIds().map((uid) => ({ userId: uid, kinds: ['newPlaces'], merge: 'count', text: (k) => (k > 1 ? `${user.name} added ${k} places` : `${user.name} added ${place.name}`) })),
            { actorId: user.id, ref: { type: 'adds', id: null } });
          placeNews(user, null, db.prepare('SELECT * FROM places WHERE id = ?').get(place.id));
        }
        return { ok: true };
      }
      case 'place.bulk': {
        const list = Array.isArray(d.places) ? d.places.slice(0, 2000) : [];
        const added = tx(() => list.map((item) => { try { return insertPlace(user, item); } catch { return null; } }).filter(Boolean));
        if (added.length) {
          broadcastPlaces(added);
          const what = `${user.name} imported ${added.length} place${added.length === 1 ? '' : 's'}${d.source ? ` from ${String(d.source).slice(0, 80)}` : ''}`;
          logActivity(user.id, what);
          notifier.notify(allUserIds().map((uid) => ({ userId: uid, kinds: ['newPlaces'], text: what })), { actorId: user.id, ref: { type: 'import', id: null } });
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
        placeNews(user, row, db.prepare('SELECT * FROM places WHERE id = ?').get(d.id));
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
        placeNews(user, row, db.prepare('SELECT * FROM places WHERE id = ?').get(d.id));
        return { ok: true };
      }
      case 'place.restore': {
        requireAdmin();
        const row = db.prepare('SELECT * FROM places WHERE id = ?').get(d.id);
        if (!row) fail('That place was deleted for good.');
        db.prepare('UPDATE places SET removed_at = NULL, removed_by = NULL, status = CASE WHEN status = \'vetoed\' THEN \'suggested\' ELSE status END, updated_at = ? WHERE id = ?').run(now(), d.id);
        broadcastPlace(d.id);
        logActivity(user.id, `${user.name} brought back ${row.name}`);
        placeNews(user, row, db.prepare('SELECT * FROM places WHERE id = ?').get(d.id));
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
        if (changed) placeNews(changed === 'vetoed' ? user : null, row, db.prepare('SELECT * FROM places WHERE id = ?').get(d.id));
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
        const before = existed ? membersOf(g.id) : [];
        tx(() => {
          if (existed) db.prepare('UPDATE subgroups SET name = ?, color = ?, start_day = ?, end_day = ? WHERE id = ?').run(name, color, start, end, g.id);
          else db.prepare('INSERT INTO subgroups(id, name, color, start_day, end_day, created_by, created_at) VALUES(?, ?, ?, ?, ?, ?, ?)').run(g.id, name, color, start, end, user.id, now());
          db.prepare('DELETE FROM subgroup_members WHERE subgroup_id = ?').run(g.id);
          const ins = db.prepare('INSERT INTO subgroup_members(subgroup_id, user_id) VALUES(?, ?)');
          members.forEach((m) => ins.run(g.id, m));
        });
        broadcastGroups();
        logActivity(user.id, existed ? `${user.name} updated the subgroup ${name}` : `${user.name} made a subgroup: ${name}`);
        const range = fmtRange(start, end);
        const changed = existed && (existed.name !== name || existed.start_day !== start || existed.end_day !== end);
        notifier.notify(members.filter((m) => !before.includes(m)).map((uid) => ({ userId: uid, kinds: ['groups'], text: `${user.name} added you to ${name}${range ? ` for ${range}` : ''}` }))
          .concat(before.filter((m) => !members.includes(m)).map((uid) => ({ userId: uid, kinds: ['groups'], text: `${user.name} took you out of ${name}` })))
          .concat(changed ? members.filter((m) => before.includes(m)).map((uid) => ({ userId: uid, kinds: ['groups'], text: `${user.name} changed ${name}${range ? `: now ${range}` : ''}` })) : []),
        { actorId: user.id, ref: { type: 'group', id: g.id } });
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
        const range = fmtRange(g.start_day, g.end_day);
        notifier.notify([{ userId: target.id, kinds: ['groups'], text: d.on ? `${user.name} added you to ${g.name}${range ? ` for ${range}` : ''}` : `${user.name} took you out of ${g.name}` }],
          { actorId: user.id, ref: { type: 'group', id: g.id } });
        return { ok: true };
      }
      case 'group.delete': {
        const g = db.prepare('SELECT * FROM subgroups WHERE id = ?').get(d.id);
        if (!g) return { ok: true };
        const affected = db.prepare('SELECT id FROM places WHERE group_id = ?').all(g.id).map((r) => r.id);
        const wereIn = membersOf(g.id);
        tx(() => {
          db.prepare('UPDATE places SET group_id = NULL WHERE group_id = ?').run(g.id);
          db.prepare('UPDATE expenses SET group_id = NULL WHERE group_id = ?').run(g.id);
          db.prepare('DELETE FROM subgroups WHERE id = ?').run(g.id);
        });
        broadcastGroups();
        if (affected.length) broadcastPlaces(affected.map(getPlace).filter(Boolean));
        logActivity(user.id, `${user.name} ended the subgroup ${g.name}`);
        notifier.notify(wereIn.map((uid) => ({ userId: uid, kinds: ['groups'], text: `${user.name} ended the subgroup ${g.name}` })), { actorId: user.id, ref: { type: 'group', id: g.id } });
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
        moneyNews(user, existing, getExpense(e.id));
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
        moneyNews(user, e, null, { deleted: true });
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
      // Removing someone (or leaving) keeps their account as a former member: they can't sign in, but
      // every expense they paid or shared still counts, so everyone's balances stay right.
      case 'user.remove': {
        requireAdmin();
        if (+d.id === user.id) fail('To remove yourself, use “Leave the trip” in Settings.');
        const target = db.prepare('SELECT * FROM users WHERE id = ?').get(+d.id);
        if (!target || target.removed_at) return { ok: true };
        removeMember(target, user);
        logActivity(user.id, `${user.name} removed ${target.name} from the trip. Their expenses still count.`);
        return { ok: true };
      }
      case 'user.leave': {
        const others = db.prepare('SELECT COUNT(*) n FROM users WHERE is_admin = 1 AND removed_at IS NULL AND id != ?').get(user.id).n;
        if (user.is_admin && !others) fail('You’re the only admin. Make someone else an admin first, then you can leave.');
        logActivity(user.id, `${user.name} left the trip. Their expenses still count.`);
        setTimeout(() => removeMember(user, user), 150); // let this reply reach them first
        return { ok: true };
      }
      case 'user.restore': {
        requireAdmin();
        const target = db.prepare('SELECT * FROM users WHERE id = ? AND removed_at IS NOT NULL').get(+d.id);
        if (!target) fail('That person isn’t a former member.');
        db.prepare('UPDATE users SET removed_at = NULL, removed_by = NULL WHERE id = ?').run(target.id);
        broadcast({ t: 'users', users: listUsers() });
        logActivity(user.id, `${user.name} brought ${target.name} back to the trip`);
        return { ok: true, canSignIn: /^[0-9a-f]{32}:[0-9a-f]{128}$/.test(target.pass_hash) }; // restored pre-1.5 members have no password yet
      }
      // Someone was removed and rejoined under a new name: move the old account's expenses, places and
      // activity onto their current account, then drop the old entry. Balances add up exactly as before.
      case 'user.merge': {
        requireAdmin();
        const from = db.prepare('SELECT * FROM users WHERE id = ? AND removed_at IS NOT NULL').get(+d.from);
        const to = db.prepare('SELECT * FROM users WHERE id = ? AND removed_at IS NULL').get(+d.into);
        if (!from) fail('Only a former member can be merged.');
        if (!to) fail('Choose someone who’s on the trip.');
        const touched = db.prepare('SELECT DISTINCT expense_id id FROM expense_shares WHERE user_id = ? UNION SELECT id FROM expenses WHERE paid_by = ?').all(from.id, from.id).map((r) => r.id);
        tx(() => {
          // A share for both people on one expense becomes one share with both amounts
          for (const s of db.prepare('SELECT * FROM expense_shares WHERE user_id = ?').all(from.id)) {
            const both = db.prepare('SELECT * FROM expense_shares WHERE expense_id = ? AND user_id = ?').get(s.expense_id, to.id);
            if (both) {
              db.prepare('UPDATE expense_shares SET amount = amount + ?, weight = COALESCE(weight, 1) + COALESCE(?, 1) WHERE expense_id = ? AND user_id = ?').run(s.amount, s.weight, s.expense_id, to.id);
              db.prepare('DELETE FROM expense_shares WHERE expense_id = ? AND user_id = ?').run(s.expense_id, from.id);
            } else db.prepare('UPDATE expense_shares SET user_id = ? WHERE expense_id = ? AND user_id = ?').run(to.id, s.expense_id, from.id);
          }
          for (const it of db.prepare("SELECT rowid, user_ids FROM expense_items WHERE user_ids LIKE ?").all(`%${from.id}%`)) {
            const ids = JSON.parse(it.user_ids).map((x) => (x === from.id ? to.id : x));
            db.prepare('UPDATE expense_items SET user_ids = ? WHERE rowid = ?').run(JSON.stringify([...new Set(ids)]), it.rowid);
          }
          for (const [t, c] of [['expenses', 'paid_by'], ['expenses', 'created_by'], ['expenses', 'updated_by'], ['places', 'created_by'], ['places', 'removed_by'], ['activity', 'user_id'], ['attachments', 'created_by']]) {
            db.prepare(`UPDATE ${t} SET ${c} = ? WHERE ${c} = ?`).run(to.id, from.id);
          }
          // A payment between the two accounts is now a payment to yourself: drop it
          db.prepare("UPDATE expenses SET deleted_at = ? WHERE kind = 'payment' AND deleted_at IS NULL AND paid_by = ? AND id IN (SELECT expense_id FROM expense_shares WHERE user_id = ?) AND (SELECT COUNT(*) FROM expense_shares WHERE expense_id = expenses.id) = 1").run(now(), to.id, to.id);
          db.prepare('DELETE FROM users WHERE id = ?').run(from.id);
        });
        broadcast({ t: 'users', users: listUsers() });
        for (const id of touched) broadcastExpense(id);
        logActivity(user.id, `${user.name} merged ${from.name}’s old account into ${to.name}. Their expenses now count for ${to.name}.`);
        notifier.notify([{ userId: to.id, kinds: ['people', 'expenses'], text: `${user.name} moved the expenses from your old account (${from.name}) onto this one` }], { actorId: user.id, ref: { type: 'user', id: to.id } });
        return { ok: true, expenses: touched.length };
      }
      case 'user.resetLink': {
        requireAdmin();
        if (+d.id === user.id) fail('Change your own password in Settings → Your account.');
        const target = db.prepare('SELECT * FROM users WHERE id = ? AND removed_at IS NULL').get(+d.id);
        if (!target) fail('That person isn’t on the trip.');
        const link = makeResetLink(target, user.id);
        logActivity(user.id, `${user.name} made a password reset link for ${target.name}`);
        notifier.notify([{ userId: target.id, kinds: ['security'], text: `${user.name} made a password reset link for your account. If you didn’t ask for one, let them know.` }], { actorId: user.id, ref: { type: 'account', id: target.id } });
        return { ok: true, ...link };
      }

      // ---- emoji reactions between people ----
      case 'react.send': {
        const emoji = String(d.emoji || '');
        if (!isReaction(emoji)) fail('Pick one of the reaction emoji.');
        const targets = d.to === 'all'
          ? db.prepare('SELECT * FROM users WHERE removed_at IS NULL AND id != ?').all(user.id)
          : [db.prepare('SELECT * FROM users WHERE id = ? AND removed_at IS NULL').get(+d.to)].filter(Boolean);
        if (!targets.length || targets.some((t) => t.id === user.id)) fail('Choose someone on the trip.');
        const recent = db.prepare('SELECT COUNT(*) n FROM reactions WHERE from_id = ? AND ts > ?').get(user.id, now() - 60e3).n;
        if (recent + targets.length > 40) fail('That’s a lot of reactions. Try again in a minute.');
        const ts = now();
        const out = targets.map((t) => {
          const id = Number(db.prepare('INSERT INTO reactions(from_id, to_id, emoji, ts) VALUES(?, ?, ?, ?)').run(user.id, t.id, emoji, ts).lastInsertRowid);
          return { id, from: user.id, to: t.id, emoji, ts };
        });
        db.prepare('DELETE FROM reactions WHERE id <= (SELECT id FROM reactions ORDER BY id DESC LIMIT 1 OFFSET 5000)').run();
        for (const r of out) for (const c of clients) if (c.user.id === r.to || c.user.id === user.id) sendTo(c, { t: 'reaction', r, all: d.to === 'all' });
        notifier.notify(out.map((r) => ({ userId: r.to, kinds: ['reactions'], merge: 'count',
          text: (k) => (d.to === 'all' ? `${user.name} sent everyone ${emoji}` : k > 1 ? `${user.name} sent you ${emoji} (${k} reactions)` : `${user.name} sent you ${emoji}`) })),
        { actorId: user.id, ref: { type: 'reaction', id: user.id } });
        return { ok: true, sent: out.length };
      }

      // ---- account recovery code ----
      case 'recovery.setup': {
        const code = newRecoveryCode();
        const had = !!user.recovery_hash;
        // Works straight away, and stays viewable in Settings until confirmed as saved
        db.prepare('UPDATE users SET recovery_hash = ?, recovery_set_at = ?, recovery_snooze = NULL, recovery_pending = ?, recovery_ack_at = NULL WHERE id = ?').run(hashPassword(normRecoveryCode(code)), now(), code, user.id);
        pushRecovery(user.id);
        if (had) notifier.notify([{ userId: user.id, kinds: ['security'], text: 'A new recovery code was made for your account. The old one no longer works.' }], { ref: { type: 'account', id: user.id } });
        devPush('op', { user: user.name, op: 'recovery.setup', ok: true, replaced: had });
        return { ok: true, code };
      }
      case 'recovery.view': {
        const u = db.prepare('SELECT recovery_pending FROM users WHERE id = ?').get(user.id);
        if (!u.recovery_pending) fail('Your recovery code was saved and hidden. If you’ve lost it, make a new one.');
        return { ok: true, code: u.recovery_pending };
      }
      case 'recovery.ack': {
        if (!user.recovery_hash) fail('Set up a recovery code first.');
        db.prepare('UPDATE users SET recovery_pending = NULL, recovery_ack_at = ? WHERE id = ?').run(now(), user.id);
        pushRecovery(user.id);
        devPush('op', { user: user.name, op: 'recovery.ack', ok: true });
        return { ok: true };
      }
      case 'recovery.snooze': {
        db.prepare('UPDATE users SET recovery_snooze = ? WHERE id = ?').run(now() + 3 * 864e5, user.id);
        const fresh = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
        for (const c of clients) if (c.user.id === user.id) sendTo(c, { t: 'me.recovery', recovery: recoveryInfo(fresh) });
        return { ok: true };
      }
      case 'user.admin': {
        requireAdmin();
        if (+d.id === user.id && !d.on) fail('Make someone else an admin first, then they can remove your admin role.');
        db.prepare('UPDATE users SET is_admin = ? WHERE id = ?').run(d.on ? 1 : 0, +d.id);
        broadcast({ t: 'users', users: listUsers() });
        refreshClientsOf(+d.id); // they gain or lose "Previously interested"
        notifier.notify([{ userId: +d.id, kinds: ['people'], text: d.on ? `${user.name} made you a trip admin` : `${user.name} removed your trip admin role` }], { actorId: user.id, ref: { type: 'user', id: +d.id } });
        return { ok: true };
      }

      // ---- clearing all expenses (admins) ----
      case 'expense.resetPreview': {
        requireAdmin();
        return { ok: true, counts: expenseCounts(), last: lastExpenseReset() };
      }
      case 'expense.reset': {
        requireAdmin();
        if (d.confirm !== 'CLEAR') fail('Type CLEAR to confirm.');
        return { ok: true, ...resetExpenses({ actor: user, scope: d.scope === 'shared' ? 'shared' : 'all' }) };
      }
      case 'expense.restoreReset': {
        requireAdmin();
        const r = restoreExpenseReset(String(d.batch || ''), user);
        if (!r.count) fail('There’s nothing left to bring back from that clear.');
        return { ok: true, ...r };
      }

      // ---- notifications ----
      case 'notif.read': {
        const n = notifier.markRead(user.id, Array.isArray(d.ids) ? d.ids : undefined);
        notifyUnread(user.id);
        return { ok: true, unread: n };
      }
      case 'notif.dismiss': {
        const ids = (Array.isArray(d.ids) ? d.ids : []).map(Number).filter(Number.isFinite).slice(0, 500);
        notifier.dismiss(user.id, ids);
        for (const c of clients) if (c.user.id === user.id) sendTo(c, { t: 'notif.gone', ids }); // their other phones/tabs too
        notifyUnread(user.id);
        return { ok: true, unread: notifier.unread(user.id) };
      }
      case 'notif.clearAll': {
        notifier.clearAll(user.id);
        for (const c of clients) if (c.user.id === user.id) sendTo(c, { t: 'notif.reset', notifications: [], unread: 0 });
        return { ok: true };
      }
      case 'notif.older': {
        const lim = Math.min(Math.max(+d.limit || 40, 1), 100);
        if (Number.isFinite(+d.beforeTs) && Number.isFinite(+d.beforeId)) return { ok: true, notifications: notifier.older(user.id, { ts: +d.beforeTs, id: +d.beforeId }, lim) };
        return { ok: true, notifications: notifier.older(user.id, +d.before || Number.MAX_SAFE_INTEGER, lim) };
      }
      case 'notif.clear': {
        notifier.clear(user.id);
        return { ok: true, notifications: notifier.list(user.id), unread: notifier.unread(user.id) };
      }
      case 'notif.prefs': {
        const prefs = cleanPrefs(d.prefs, prefsOf(user));
        db.prepare('UPDATE users SET notify_prefs = ? WHERE id = ?').run(JSON.stringify(prefs), user.id);
        for (const c of clients) if (c.user.id === user.id) sendTo(c, { t: 'notif.prefs', prefs });
        return { ok: true, prefs };
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
        if ('photoReminder' in d) { if (!(d.photoReminder === 'off' || /^([01]\d|2[0-3]):[0-5]\d$/.test(d.photoReminder))) fail('Pick a time for the photo reminder, or off.'); t.photoReminder = d.photoReminder; }
        if ('currency' in d && d.currency !== t.currency) {
          if (!(d.currency in CURRENCIES)) fail('Unsupported currency');
          if (db.prepare('SELECT 1 FROM expenses WHERE deleted_at IS NULL LIMIT 1').get()) fail('The trip currency can’t change once expenses have been added.');
          t.currency = d.currency;
        }
        setSetting('trip', t);
        for (const c of clients) sendTo(c, { t: 'trip', trip: tripForClient(c.user) });
        return { ok: true };
      }
      // ---- group chat ----
      case 'chat.send': {
        const kind = d.gif ? 'gif' : 'text';
        const m = chat.post(user, { chat: d.chat, clientId: d.clientId, kind, text: kind === 'gif' ? String(d.gif.title || '').slice(0, 120) : d.text, replyTo: d.replyTo,
          gifUrl: d.gif?.url, gifMp4: d.gif?.mp4, width: Math.min(+d.gif?.w || 0, 4000) || null, height: Math.min(+d.gif?.h || 0, 4000) || null });
        return { ok: true, m };
      }
      case 'chat.history': return { ok: true, ...chat.history(user.id, String(d.chat || ''), d) };
      case 'chat.delete': {
        const r = chat.remove(user, d.id);
        if (r.file) dropBlobIfUnused(r.file);
        if (r.thumb) dropBlobIfUnused(r.thumb);
        return { ok: true };
      }
      case 'chat.react': chat.react(user, d.id, String(d.emoji || ''), !!d.on); return { ok: true };
      case 'chat.read': chat.markRead(user.id, String(d.chat || ''), d.id); return { ok: true };
      case 'stay.save': {
        const s = d.stay || {};
        if (!/^[\w-]{6,64}$/.test(String(s.id || ''))) fail('Bad stay id');
        const name = str(s.name, 80);
        if (!name) fail('Give the stay a name, like the hotel’s.');
        const lat = +s.lat, lng = +s.lng;
        if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) fail('Find the address or set it on the map first.');
        const start = s.startDay || null, end = s.endDay || s.startDay || null;
        if (!isDay(start) || !isDay(end)) fail('Dates must look like 2026-03-14');
        if (start && end && end < start) fail('The last night has to be on or after the first.');
        const prev = db.prepare('SELECT * FROM stays WHERE id = ? AND deleted_at IS NULL').get(s.id);
        if (prev) db.prepare('UPDATE stays SET name = ?, address = ?, lat = ?, lng = ?, start_day = ?, end_day = ?, notes = ?, updated_at = ? WHERE id = ?')
          .run(name, str(s.address, 200), lat, lng, start, end, str(s.notes, 400), now(), s.id);
        else {
          if (db.prepare('SELECT COUNT(*) n FROM stays WHERE deleted_at IS NULL').get().n >= 30) fail('That’s a lot of stays. Remove an old one first.');
          db.prepare('INSERT INTO stays(id, name, address, lat, lng, start_day, end_day, notes, created_by, created_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
            .run(s.id, name, str(s.address, 200), lat, lng, start, end, str(s.notes, 400), user.id, now());
        }
        broadcastStays();
        const when = start ? ` (${start === end ? start : `${start} to ${end}`})` : '';
        logActivity(user.id, prev ? `${user.name} updated the stay ${name}` : `${user.name} added where we’re staying: ${name}${when}`);
        if (!prev || prev.lat !== lat || prev.lng !== lng || prev.start_day !== start || prev.end_day !== end) {
          notifier.notify(activeUsers().map((u) => ({ userId: u.id, kinds: ['plan'], text: prev ? `${user.name} changed the stay ${name}${when}` : `${user.name} added where we’re staying: ${name}${when}` })),
            { actorId: user.id, ref: { type: 'stay', id: s.id } });
        }
        return { ok: true };
      }
      case 'stay.delete': {
        const prev = db.prepare('SELECT * FROM stays WHERE id = ? AND deleted_at IS NULL').get(String(d.id || ''));
        if (!prev) fail('That stay is already gone.');
        db.prepare('UPDATE stays SET deleted_at = ? WHERE id = ?').run(now(), prev.id);
        broadcastStays();
        logActivity(user.id, `${user.name} removed the stay ${prev.name}`);
        return { ok: true };
      }
      case 'photo.like': {
        const row = db.prepare('SELECT id FROM daily_photos WHERE id = ? AND deleted_at IS NULL').get(+d.id);
        if (!row) fail('That photo is gone.');
        if (d.on) db.prepare('INSERT OR IGNORE INTO photo_likes(photo_id, user_id) VALUES(?, ?)').run(row.id, user.id);
        else db.prepare('DELETE FROM photo_likes WHERE photo_id = ? AND user_id = ?').run(row.id, user.id);
        broadcastPhotos();
        return { ok: true };
      }
      case 'photo.caption': {
        const row = db.prepare('SELECT * FROM daily_photos WHERE id = ? AND deleted_at IS NULL').get(+d.id);
        if (!row) fail('That photo is gone.');
        if (row.user_id !== user.id && !user.is_admin) fail('Only whoever added it can change the caption.');
        db.prepare('UPDATE daily_photos SET caption = ? WHERE id = ?').run(str(d.caption, 140) || null, row.id);
        broadcastPhotos();
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

  // ---------- developer console API (read-only) ----------
  function devApi(req, res, url, p) {
    const count = (sql) => db.prepare(sql).get().n;
    const names = Object.fromEntries(db.prepare('SELECT id, name FROM users').all().map((u) => [u.id, u.name]));
    if (p === '/api/dev/stream') return devSubscribe(req, res);
    // The only actions in the console: clearing all expenses, and undoing the last clear.
    if (p === '/api/dev/expenses' && req.method === 'GET') return send(res, 200, { counts: expenseCounts(), last: lastExpenseReset() });
    // Accounts: a one-time password reset link for anyone (e.g. when the only admin is the one locked out).
    if (p === '/api/dev/reset-link' && req.method === 'POST') {
      if (!sameOrigin(req)) return send(res, 403, { error: 'Cross-site request refused.' });
      if (!DEV_RESET_LINKS) return send(res, 403, { error: 'Reset links are off. Set DEV_RESET_LINKS=on in .env and restart to turn them on.' });
      return readBody(req).then((b) => {
        const target = db.prepare('SELECT * FROM users WHERE id = ? AND removed_at IS NULL').get(+b.userId);
        if (!target) return send(res, 404, { error: 'No such person on the trip.' });
        const link = makeResetLink(target, null);
        notifier.notify([{ userId: target.id, kinds: ['security'], text: 'A password reset link was made for your account from the developer console.' }], { ref: { type: 'account', id: target.id } });
        return send(res, 200, { ok: true, ...link });
      }).catch((e) => send(res, 400, { error: e.message }));
    }
    if ((p === '/api/dev/expenses/reset' || p === '/api/dev/expenses/restore') && req.method === 'POST') {
      if (!sameOrigin(req)) return send(res, 403, { error: 'Cross-site request refused.' });
      return readBody(req).then((b) => {
        if (p.endsWith('/reset')) {
          if (b.confirm !== 'CLEAR') return send(res, 400, { error: 'Type CLEAR to confirm.' });
          return send(res, 200, { ok: true, ...resetExpenses({ scope: b.scope === 'shared' ? 'shared' : 'all' }) });
        }
        const r = restoreExpenseReset(String(b.batch || ''));
        return r.count ? send(res, 200, { ok: true, ...r }) : send(res, 400, { error: 'There’s nothing left to bring back from that clear.' });
      }).catch((e) => send(res, 400, { error: e.message }));
    }
    if (p === '/api/dev/events') {
      const kind = url.searchParams.get('kind') || 'log';
      return send(res, 200, { events: devRecent(kind, { since: +url.searchParams.get('since') || 0, limit: 1000 }) });
    }
    if (p === '/api/dev/overview') {
      const fileSize = (f) => { try { return fs.statSync(path.join(dataDir, f)).size; } catch { return 0; } };
      const statusCounts = Object.fromEntries(db.prepare('SELECT status, COUNT(*) n FROM places WHERE removed_at IS NULL GROUP BY status').all().map((r) => [r.status, r.n]));
      const mem = process.memoryUsage();
      return send(res, 200, {
        version: VERSION, node: process.version, host: os.hostname(), health: getHealth(),
        uptimeSec: Math.round((Date.now() - startedAt) / 1000), memory: { rss: mem.rss, heapUsed: mem.heapUsed }, load: os.loadavg(),
        systemMemory: { total: os.totalmem(), free: os.freemem() },
        db: { bytes: fileSize('tabi.db') + fileSize('tabi.db-wal') },
        counts: {
          users: count('SELECT COUNT(*) n FROM users'), sessions: count('SELECT COUNT(*) n FROM sessions'),
          places: count('SELECT COUNT(*) n FROM places WHERE removed_at IS NULL'), removed: count('SELECT COUNT(*) n FROM places WHERE removed_at IS NOT NULL'),
          byStatus: statusCounts, votes: count('SELECT COUNT(*) n FROM votes'), subgroups: count('SELECT COUNT(*) n FROM subgroups'),
          expenses: count("SELECT COUNT(*) n FROM expenses WHERE deleted_at IS NULL AND kind = 'expense'"),
          privateExpenses: count("SELECT COUNT(*) n FROM expenses WHERE deleted_at IS NULL AND visibility = 'private'"),
          payments: count("SELECT COUNT(*) n FROM expenses WHERE deleted_at IS NULL AND kind = 'payment'"),
          attachments: count('SELECT COUNT(*) n FROM attachments'), attachmentBytes: db.prepare('SELECT COALESCE(SUM(bytes),0) n FROM attachments').get().n,
          geocache: count('SELECT COUNT(*) n FROM geocache'), activity: count('SELECT COUNT(*) n FROM activity'),
          notifications: count('SELECT COUNT(*) n FROM notifications'), unreadNotifications: count('SELECT COUNT(*) n FROM notifications WHERE read_at IS NULL'),
          profilePhotos: count('SELECT COUNT(*) n FROM users WHERE avatar IS NOT NULL'),
          push: pusher.stats(),
          chat: { ...chat.stats(), mediaBytes: chat.mediaBytes() },
        },
        clients: [...clients].map((c) => ({ user: c.user.name, since: c.since, ip: c.ip, ua: c.ua, build: c.build || null, current: !c.build || c.build === BUILD })),
        build: BUILD,
        trip: { ...tripForClient(null), joinCode: undefined },
        config: CONFIG,
        features: { privateLinkGate: auth.gateEnabled, tunnel: !!env.TUNNEL_TOKEN, durableStorage: !!blobs.durable, ha: /^(1|true|on|yes)$/i.test(env.HA_MODE || ''), trustProxy: TRUST_PROXY, sessionDays: +(env.SESSION_DAYS || 180), resetLinks: DEV_RESET_LINKS },
      });
    }
    if (p === '/api/dev/people') {
      const lastOt = {};
      for (const e of devRecent('owntracks', { limit: 300 })) if (e.userId) lastOt[e.userId] = e;
      const locs = Object.fromEntries(db.prepare('SELECT * FROM locations').all().map((l) => [l.user_id, l]));
      return send(res, 200, { resetLinks: DEV_RESET_LINKS, people: db.prepare('SELECT * FROM users ORDER BY id').all().map((u) => ({
        id: u.id, name: u.name, color: u.color, admin: !!u.is_admin, sharing: !!u.share_location, createdAt: u.created_at,
        removedAt: u.removed_at || null, recoverySet: !!u.recovery_hash, recoveryStatus: recoveryStatus(u), hasPassword: /^[0-9a-f]{32}:[0-9a-f]{128}$/.test(u.pass_hash),
        resetLink: db.prepare('SELECT created_at, expires_at FROM password_resets WHERE user_id = ? AND used_at IS NULL AND expires_at > ? ORDER BY created_at DESC LIMIT 1').get(u.id, now()) || null,
        owntracksConfigured: !!u.owntracks_token, lastOwnTracks: lastOt[u.id] ? { ts: lastOt[u.id].ts, result: lastOt[u.id].result } : null,
        location: locs[u.id] ? { lat: locs[u.id].lat, lng: locs[u.id].lng, acc: locs[u.id].acc, batt: locs[u.id].batt, ts: locs[u.id].ts, source: locs[u.id].source } : null,
        sessions: db.prepare('SELECT COUNT(*) n, MAX(last_seen) last FROM sessions WHERE user_id = ?').get(u.id),
        online: [...clients].some((c) => c.user.id === u.id),
        groups: listSubgroups().filter((g) => g.memberIds.includes(u.id)).map((g) => g.name),
      })) });
    }
    if (p === '/api/dev/places') {
      return send(res, 200, { places: db.prepare('SELECT * FROM places ORDER BY day, sort').all().map((r) => {
        const pl = placeRow(r);
        return { ...pl, createdByName: names[pl.createdBy] || null, removedByName: names[pl.removedBy] || null,
          votesByName: Object.fromEntries(Object.entries(pl.votes).map(([k, v]) => [names[k] || k, v])) };
      }), subgroups: listSubgroups() });
    }
    return send(res, 404, { error: 'Not found' });
  }

  return {
    server,
    userCount,
    close() { for (const c of clients) c.ws.terminate(); clearInterval(heartbeat); clearInterval(purge); clearInterval(reminderTimer); return new Promise((r) => server.close(r)); },
    photoReminder, // for tests
  };
}
