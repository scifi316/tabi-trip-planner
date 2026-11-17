// Web Push: notifications that reach people when Tabi is closed (lock screen, notification centre).
//
// Every browser has its own push service (Google for Chrome and Android, Apple for Safari and iPhone
// home-screen apps, Mozilla for Firefox, Microsoft for Edge). A device that turns notifications on
// gives us an "endpoint" URL at its push service plus two keys. To notify it we encrypt the message
// for that device (RFC 8291, aes128gcm) and POST it to the endpoint, signed with our own key pair
// (VAPID, RFC 8292) so the push service knows it's us. Free, no accounts, no SDKs.
//
// Our key pair is made once and kept in the database (settings), so both servers in a failover pair
// use the same one: subscriptions keep working whichever machine is serving.
import crypto from 'node:crypto';

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const unb64u = (s) => Buffer.from(String(s || ''), 'base64url');

// Only real push services: the server POSTs to these URLs, so anything else would let someone make
// it send requests wherever they like.
const PUSH_HOSTS = [/(^|\.)googleapis\.com$/, /(^|\.)push\.apple\.com$/, /(^|\.)push\.services\.mozilla\.com$/, /(^|\.)notify\.windows\.com$/];

export function isPushEndpoint(endpoint, extraHosts = []) {
  try {
    const u = new URL(endpoint);
    if (extraHosts.includes(u.host)) return true; // tests run a local push service
    return u.protocol === 'https:' && !u.port && PUSH_HOSTS.some((re) => re.test(u.hostname));
  } catch { return false; }
}

export function newVapidKeys() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = privateKey.export({ format: 'jwk' });
  const pub = publicKey.export({ format: 'jwk' });
  return { publicKey: b64u(Buffer.concat([Buffer.from([4]), unb64u(pub.x), unb64u(pub.y)])), privateKey: jwk.d };
}

function privateKeyObject({ publicKey, privateKey }) {
  const raw = unb64u(publicKey);
  return crypto.createPrivateKey({ key: { kty: 'EC', crv: 'P-256', d: privateKey, x: b64u(raw.subarray(1, 33)), y: b64u(raw.subarray(33, 65)) }, format: 'jwk' });
}

// RFC 8291: encrypt `payload` for one subscription. Returns the request body.
export function encrypt(payload, { p256dh, auth }, { salt = crypto.randomBytes(16), serverKeys } = {}) {
  const uaPublic = unb64u(p256dh);
  const authSecret = unb64u(auth);
  if (uaPublic.length !== 65 || authSecret.length !== 16) throw new Error('bad subscription keys');
  const ecdh = crypto.createECDH('prime256v1');
  if (serverKeys) ecdh.setPrivateKey(serverKeys.privateKey); else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const shared = ecdh.computeSecret(uaPublic);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', shared, authSecret, keyInfo, 32));
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const plain = Buffer.concat([Buffer.from(payload), Buffer.from([2])]); // 0x02: last (and only) record
  const body = Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
  const rs = Buffer.alloc(4); rs.writeUInt32BE(4096);
  return Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, body]);
}

// RFC 8292: a signed token saying "this is Tabi" for one push service.
export function vapidAuth(endpoint, keys, subject, now = Date.now()) {
  const aud = new URL(endpoint).origin;
  const header = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const claims = b64u(JSON.stringify({ aud, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject }));
  const sig = crypto.sign('sha256', Buffer.from(`${header}.${claims}`), { key: privateKeyObject(keys), dsaEncoding: 'ieee-p1363' });
  return `vapid t=${header}.${claims}.${b64u(sig)}, k=${keys.publicKey}`;
}

export function createPusher({ db, getSetting, setSetting, env = process.env, log = () => {} }) {
  const extraHosts = String(env.PUSH_TEST_HOSTS || '').split(',').map((s) => s.trim()).filter(Boolean);
  function keys() {
    if (env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY) return { publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY };
    let k = getSetting('vapid', null);
    if (!k) { k = newVapidKeys(); setSetting('vapid', k); log('[push] made the Web Push key pair (kept in the database, shared by both servers)'); }
    return k;
  }
  // Apple wants a contact in the token: mailto: or https:. The site's own address will do.
  const subject = () => env.VAPID_SUBJECT || getSetting('pushSubject', null) || 'mailto:tabi@localhost';
  const noteOrigin = (origin) => {
    if (!env.VAPID_SUBJECT && /^https:\/\//.test(origin || '') && getSetting('pushSubject', null) !== origin) setSetting('pushSubject', origin);
  };

  const subsOf = (userId) => db.prepare('SELECT * FROM push_subs WHERE user_id = ?').all(userId);

  function subscribe(userId, sub, ua = '') {
    const endpoint = String(sub?.endpoint || '');
    const p256dh = String(sub?.keys?.p256dh || '');
    const auth = String(sub?.keys?.auth || '');
    if (!isPushEndpoint(endpoint, extraHosts)) throw Object.assign(new Error('That isn’t a push service Tabi can use.'), { expose: true });
    if (unb64u(p256dh).length !== 65 || unb64u(auth).length !== 16) throw Object.assign(new Error('The browser sent incomplete notification keys.'), { expose: true });
    // One row per device; re-subscribing (or another person signing in on the same browser) takes it over.
    db.prepare(`INSERT INTO push_subs(user_id, endpoint, p256dh, auth, ua, created_at, fails) VALUES(?, ?, ?, ?, ?, ?, 0)
      ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth, ua = excluded.ua, fails = 0`)
      .run(userId, endpoint, p256dh, auth, String(ua).slice(0, 160), Date.now());
    // Keep it tidy: at most 10 devices per person (oldest go first)
    db.prepare('DELETE FROM push_subs WHERE user_id = ? AND id NOT IN (SELECT id FROM push_subs WHERE user_id = ? ORDER BY id DESC LIMIT 10)').run(userId, userId);
  }
  const unsubscribe = (userId, endpoint) => db.prepare('DELETE FROM push_subs WHERE user_id = ? AND endpoint = ?').run(userId, String(endpoint || ''));
  const has = (userId, endpoint) => !!db.prepare('SELECT 1 FROM push_subs WHERE user_id = ? AND endpoint = ?').get(userId, String(endpoint || ''));

  async function sendOne(s, payload, { ttl = 24 * 3600, topic, urgency = 'normal' } = {}) {
    const k = keys();
    let res;
    try {
      res = await fetch(s.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream', 'Content-Encoding': 'aes128gcm', TTL: String(ttl), Urgency: urgency,
          ...(topic ? { Topic: topic } : {}), Authorization: vapidAuth(s.endpoint, k, subject()),
        },
        body: encrypt(JSON.stringify(payload), s),
        signal: AbortSignal.timeout(10000),
      });
    } catch (e) {
      db.prepare('UPDATE push_subs SET fails = fails + 1, last_error = ? WHERE id = ?').run(String(e.message).slice(0, 120), s.id);
      return { ok: false, error: e.message };
    }
    if (res.status === 404 || res.status === 410) { // unsubscribed, uninstalled, or expired: forget it
      db.prepare('DELETE FROM push_subs WHERE id = ?').run(s.id);
      return { ok: false, gone: true, status: res.status };
    }
    if (!res.ok) {
      const text = (await res.text().catch(() => '')).slice(0, 160);
      const fails = db.prepare('UPDATE push_subs SET fails = fails + 1, last_error = ? WHERE id = ? RETURNING fails').get(`${res.status} ${text}`, s.id)?.fails || 0;
      if (fails >= 20) db.prepare('DELETE FROM push_subs WHERE id = ?').run(s.id); // something's permanently wrong with it
      return { ok: false, status: res.status, error: text };
    }
    db.prepare('UPDATE push_subs SET fails = 0, last_ok_at = ?, last_error = NULL WHERE id = ?').run(Date.now(), s.id);
    return { ok: true, status: res.status };
  }

  // Send to all of someone's devices (or one). Payloads stay well under the 4 KB limit.
  async function send(userId, payload, opts = {}) {
    const list = opts.endpoint ? subsOf(userId).filter((s) => s.endpoint === opts.endpoint) : subsOf(userId);
    const body = { ...payload, title: String(payload.title || 'Tabi').slice(0, 80), body: String(payload.body || '').slice(0, 600) };
    return Promise.all(list.map((s) => sendOne(s, body, opts)));
  }

  const stats = () => db.prepare('SELECT COUNT(*) n, COUNT(DISTINCT user_id) people, MAX(last_ok_at) lastOk, SUM(fails > 0) failing FROM push_subs').get();
  const devicesOf = (userId) => subsOf(userId).map((s) => ({ ua: s.ua, createdAt: s.created_at, lastOk: s.last_ok_at, failing: s.fails > 0 }));

  return { publicKey: () => keys().publicKey, subscribe, unsubscribe, has, send, noteOrigin, stats, devicesOf };
}
