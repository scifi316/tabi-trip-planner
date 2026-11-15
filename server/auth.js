// Sessions (HttpOnly cookies, cached in memory) and the private-link access gate.
import crypto from 'node:crypto';

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const DAY = 864e5;

export function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function createAuth({ db, env = process.env, trustProxy = false }) {
  const SESSION_DAYS = +(env.SESSION_DAYS || 180);
  const CACHE_MS = 5 * 60e3;
  const accessKey = env.ACCESS_KEY || '';
  // The gate token is derived from the key so the raw key never needs to sit in a cookie or manifest.
  const gateToken = accessKey ? crypto.createHmac('sha256', accessKey).update('tabi-gate-v1').digest('base64url').slice(0, 32) : '';
  const cache = new Map(); // token hash -> { userId, checkedAt }

  const isSecure = (req) => env.COOKIE_SECURE === 'true' || (trustProxy && String(req.headers['x-forwarded-proto'] || '').startsWith('https'));
  const cookie = (req, name, value, maxAgeSec) =>
    `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${isSecure(req) ? '; Secure' : ''}`;

  function safeEqual(a, b) {
    const x = Buffer.from(String(a)), y = Buffer.from(String(b));
    return x.length === y.length && crypto.timingSafeEqual(x, y);
  }

  return {
    gateEnabled: !!accessKey,
    gateToken,

    // Returns { ok, setCookie?, cleanUrl? }. cleanUrl: same URL without the key, for a redirect.
    checkGate(req, url) {
      if (!accessKey) return { ok: true };
      const c = parseCookies(req).tabi_gate;
      if (c && safeEqual(c, gateToken)) return { ok: true };
      const key = url.searchParams.get('key');
      const gate = url.searchParams.get('gate');
      if ((key && safeEqual(key, accessKey)) || (gate && safeEqual(gate, gateToken))) {
        const clean = new URL(url);
        clean.searchParams.delete('key');
        clean.searchParams.delete('gate');
        return { ok: true, setCookie: cookie(req, 'tabi_gate', gateToken, 400 * 86400), cleanUrl: clean.pathname + clean.search };
      }
      return { ok: false };
    },

    create(req, userId) {
      const token = crypto.randomBytes(32).toString('base64url');
      const t = Date.now();
      db.prepare('INSERT INTO sessions(token_hash, user_id, created_at, last_seen, user_agent) VALUES(?, ?, ?, ?, ?)')
        .run(sha256(token), userId, t, t, String(req.headers['user-agent'] || '').slice(0, 200));
      cache.set(sha256(token), { userId, checkedAt: t });
      return { token, setCookie: cookie(req, 'tabi_session', token, SESSION_DAYS * 86400) };
    },

    tokenFrom(req, url) {
      const h = req.headers.authorization || '';
      if (h.startsWith('Bearer ')) return h.slice(7);
      return parseCookies(req).tabi_session || url?.searchParams.get('token') || null;
    },

    // Returns { user, hash, refreshCookie? } or null. Session rows are cached for 5 minutes.
    resolve(req, url) {
      const token = this.tokenFrom(req, url);
      if (!token) return null;
      const hash = sha256(token);
      const t = Date.now();
      let entry = cache.get(hash);
      if (!entry || t - entry.checkedAt > CACHE_MS) {
        const s = db.prepare('SELECT * FROM sessions WHERE token_hash = ?').get(hash);
        if (!s || t - s.last_seen > SESSION_DAYS * DAY) { cache.delete(hash); return null; }
        entry = { userId: s.user_id, checkedAt: t, lastSeen: s.last_seen };
        cache.set(hash, entry);
      }
      const user = db.prepare('SELECT * FROM users WHERE id = ?').get(entry.userId);
      if (!user) { cache.delete(hash); return null; }
      let refreshCookie;
      // Sliding expiry: touch the session (and re-issue the cookie) at most twice a day.
      if (!entry.lastSeen || t - entry.lastSeen > DAY / 2) {
        db.prepare('UPDATE sessions SET last_seen = ? WHERE token_hash = ?').run(t, hash);
        entry.lastSeen = t;
        refreshCookie = cookie(req, 'tabi_session', token, SESSION_DAYS * 86400);
      }
      // Older clients sent a bearer token; move them onto the cookie.
      if (!parseCookies(req).tabi_session) refreshCookie = cookie(req, 'tabi_session', token, SESSION_DAYS * 86400);
      return { user, hash, refreshCookie };
    },

    revoke(hash) { db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hash); cache.delete(hash); },
    revokeUser(userId, exceptHash) {
      for (const s of db.prepare('SELECT token_hash FROM sessions WHERE user_id = ?').all(userId)) {
        if (s.token_hash !== exceptHash) { db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(s.token_hash); cache.delete(s.token_hash); }
      }
    },
    list(userId, currentHash) {
      return db.prepare('SELECT token_hash, created_at, last_seen, user_agent FROM sessions WHERE user_id = ? ORDER BY last_seen DESC').all(userId)
        .map((s) => ({ id: s.token_hash.slice(0, 12), createdAt: s.created_at, lastSeen: s.last_seen, device: describeUA(s.user_agent), current: s.token_hash === currentHash }));
    },
    clearCookie: (req) => cookie(req, 'tabi_session', '', 0),
    purgeExpired() { db.prepare('DELETE FROM sessions WHERE last_seen < ?').run(Date.now() - SESSION_DAYS * DAY); },
  };
}

function describeUA(ua = '') {
  const os = /iPhone|iPad/.test(ua) ? 'iPhone/iPad' : /Android/.test(ua) ? 'Android' : /Mac OS X/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : 'Device';
  const br = /Edg\//.test(ua) ? 'Edge' : /CriOS|Chrome\//.test(ua) ? 'Chrome' : /FxiOS|Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : '';
  return br ? `${br} on ${os}` : os;
}
