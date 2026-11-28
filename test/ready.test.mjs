// TA-36: Ready for Japan. The checks, the card's words, and the server: phones reporting, admins
// seeing everyone's check live, and Nudge reaching only that person (repeats merge).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { readiness, cleanReport, sinceWords, LOCATION_FRESH_MS } from '../server/ready.js';
import { readyModel, cardHidden, memberLine, promptDue } from '../public/js/readycheck.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const NOW = Date.UTC(2026, 11, 20, 12);
const HOUR = 3600e3;

// ---------- the checks ----------
const person = (o = {}) => ({ id: 2, share_location: 0, avatar: null, ot_status: null, ot_status_at: null, ...o });
const device = (o = {}) => ({ device_id: 'phone-aaaaaaaa', installed: 0, android: 0, endpoint: null, blocked: 0, maps: 'none', maps_at: null, updated_at: NOW - HOUR, ...o });
const EP = 'https://web.push.apple.com/abc';
const allSet = () => ({
  user: person({ share_location: 1, avatar: 'a.jpg' }), recovery: 'saved', now: NOW,
  devices: [device({ installed: 1, endpoint: EP, maps: 'fresh', maps_at: NOW - HOUR })],
  subs: [{ endpoint: EP, fails: 0, last_ok_at: NOW - HOUR }], loc: { ts: NOW - 10 * 60e3, source: 'owntracks' },
});

test('a fresh account misses every required check, and says so in plain words', () => {
  const r = readiness({ user: person(), now: NOW });
  assert.equal(r.ready, false);
  assert.deepEqual(r.missing, ['no phone checked in yet', 'location sharing off', 'no recovery code']);
  assert.deepEqual(r.suggested, ['no profile photo']);
});

test('a fresh iPhone in Safari: not on the home screen and no lock-screen notifications', () => {
  const r = readiness({ user: person(), devices: [device()], now: NOW });
  assert.deepEqual(r.missing, ['not on the home screen', 'no lock-screen notifications', 'location sharing off', 'no recovery code']);
  assert.deepEqual(r.suggested, ['no profile photo', 'offline maps not saved']);
});

test('everything set is ready; a profile photo and offline maps never block it', () => {
  assert.equal(readiness(allSet()).ready, true);
  const s = allSet();
  s.user.avatar = null;
  s.devices[0].maps = 'stale';
  const r = readiness(s);
  assert.equal(r.ready, true);
  assert.deepEqual(r.missing, []);
  assert.deepEqual(r.suggested, ['no profile photo', 'offline maps out of date']);
});

test('one ready device is enough, and it speaks for the person', () => {
  const s = allSet();
  s.devices = [device({ device_id: 'laptop-bbbbbbbb', updated_at: NOW }), ...s.devices]; // a newer laptop with nothing set up
  const r = readiness(s);
  assert.equal(r.ready, true);
  assert.equal(r.best, 'phone-aaaaaaaa');
  assert.equal(r.devices.find((d) => d.id === 'laptop-bbbbbbbb').ok, false);
});

test('lock-screen notifications: failing, blocked, or on another device do not count', () => {
  const s = allSet();
  s.subs[0].fails = 2;
  assert.deepEqual(readiness(s).missing, ['lock-screen notifications failing']);
  const b = allSet();
  b.devices[0] = device({ installed: 1, blocked: 1 });
  assert.deepEqual(readiness(b).missing, ['notifications blocked on the phone']);
  const other = allSet();
  other.subs = [{ endpoint: 'https://fcm.googleapis.com/other', fails: 0 }];
  assert.deepEqual(readiness(other).missing, ['no lock-screen notifications']);
});

test('location: the OwnTracks status words, and how long it has been', () => {
  const s = allSet();
  assert.equal(readiness(s).person.location.label, 'Working');
  s.loc = { ts: NOW - 2 * 864e5 - HOUR, source: 'app' };
  const r = readiness(s);
  assert.equal(r.person.location.label, 'Not heard lately');
  assert.deepEqual(r.missing, ['location not heard for 2 days']);
  s.loc = { ts: NOW - LOCATION_FRESH_MS + 60e3 };
  assert.equal(readiness(s).ready, true, 'a location from earlier today still counts');
  s.loc = null;
  assert.deepEqual(readiness(s).missing, ['no location yet']);
  const f = allSet();
  f.user.ot_status = 'bad-token';
  f.user.ot_status_at = NOW;
  assert.equal(readiness(f).person.location.label, 'Failing');
  assert.equal(sinceWords(30 * HOUR), '30 hours');
  assert.equal(sinceWords(3 * 864e5), '3 days');
});

test('recovery code: made but not confirmed is not saved', () => {
  for (const st of ['pending', 'unconfirmed']) {
    assert.deepEqual(readiness({ ...allSet(), recovery: st }).missing, ['recovery code not saved']);
  }
});

test('device reports are checked before they are stored', () => {
  assert.equal(cleanReport({ id: 'x' }), null, 'id too short');
  assert.equal(cleanReport({ id: 'bad id with spaces' }), null);
  const d = cleanReport({ id: 'abcdef123456', installed: 'yes', endpoint: 'http://not-https', maps: 'weird', mapsAt: -4 });
  assert.deepEqual(d, { id: 'abcdef123456', installed: true, android: false, endpoint: null, blocked: false, maps: 'none', mapsAt: null });
  assert.equal(cleanReport({ id: 'abcdef123456', endpoint: EP, blocked: true }).blocked, false, 'subscribed means not blocked');
});

// ---------- the card's words ----------
const ios = { installed: false, inApp: false, platform: 'ios', androidApp: true, push: { support: 'ios-install', on: false }, maps: { state: 'none' } };
const when = () => '5 minutes ago';

test('the card on a fresh iPhone in Safari: every check missing, each with its fix', () => {
  const ready = readiness({ user: person(), devices: [device()], now: NOW });
  const m = readyModel(ready, 'phone-aaaaaaaa', ios, { when });
  assert.equal(m.done, 0);
  assert.equal(m.total, 4);
  assert.equal(m.deviceReady, false);
  const by = Object.fromEntries(m.items.map((i) => [i.key, i]));
  assert.deepEqual(m.items.map((i) => i.key), ['installed', 'push', 'location', 'recovery', 'photo', 'maps']);
  assert.equal(by.installed.action.id, 'install');
  assert.match(by.installed.text, /Share, then Add to Home Screen/);
  assert.equal(by.push.action, undefined, 'notifications wait for the home screen on iPhone');
  assert.match(by.push.text, /home screen first/);
  assert.equal(by.location.action.id, 'share-on');
  assert.equal(by.location.label, 'Not set up');
  assert.equal(by.recovery.action.id, 'recovery');
  assert.equal(by.photo.optional, 'Optional');
  assert.equal(by.maps.optional, 'Suggested');
  assert.equal(by.maps.action.id, 'maps');
});

test('Android phones get the Tabi app, and the card ticks as the server hears', () => {
  const android = { ...ios, platform: 'android', push: { support: 'ok', on: false } };
  const m = readyModel(null, 'x', android, { when });
  assert.equal(m.items[0].action.id, 'android');
  assert.equal(m.items[1].action.id, 'push-on');
  const s = allSet();
  const done = readyModel(readiness(s), 'phone-aaaaaaaa', { ...ios, installed: true }, { when });
  assert.equal(done.deviceReady, true);
  assert.equal(done.done, 4);
  assert.equal(done.items[2].text, 'Last location 5 minutes ago.');
});

test('ready on another phone: this one is told it can be set up too', () => {
  const m = readyModel(readiness(allSet()), 'tablet-cccccccc', ios, { when });
  assert.equal(m.personReady, true);
  assert.equal(m.otherDevice, true);
});

test('the card hides after the trip’s first day; the sign-in sheet shows once unless snoozed', () => {
  assert.equal(cardHidden({ start: '2027-01-09' }, '2027-01-09'), false, 'still on the first day');
  assert.equal(cardHidden({ start: '2027-01-09' }, '2027-01-10'), true);
  assert.equal(cardHidden({ start: null }, '2027-01-10'), false);
  assert.equal(promptDue(null), true);
  assert.equal(promptDue({ shown: NOW }), false);
  assert.equal(promptDue({ until: NOW + 1 }, NOW), false);
  assert.equal(promptDue({ until: NOW - 1 }, NOW), true);
});

test('what admins see in the member list', () => {
  assert.deepEqual(memberLine({ ready: true, missing: [] }), { tone: 'good', text: 'Ready for Japan' });
  assert.deepEqual(memberLine({ ready: false, missing: ['no lock-screen notifications', 'location not heard for 2 days'] }),
    { tone: 'warn', text: 'Not ready: no lock-screen notifications, location not heard for 2 days' });
  assert.equal(memberLine(undefined), null);
});

test('the new scripts work offline and the nudge has somewhere to go', () => {
  const sw = read('public/sw.js');
  for (const f of ['ready.js', 'readycheck.js']) assert.ok(sw.includes(`'/js/${f}'`), `${f} is in sw.js SHELL`);
  assert.match(read('public/js/notifications.js'), /ref\.type === 'setup'/);
  assert.match(read('public/js/settings.js'), /readyCardHtml\(/);
});

// ---------- the server ----------
const { openDb } = await import('../server/db.js');
const { createBlobStore } = await import('../server/blobs.js');
const { createApp } = await import('../server/app.js');

async function startApp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tabi-ready-test-'));
  const db = openDb(dir);
  const app = createApp({ db, blobs: createBlobStore(dir, null), root: ROOT, dataDir: dir, env: { ...process.env, DEV_KEY: 'ready-test-dev' } });
  await new Promise((r) => app.server.listen(0, r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const stop = async () => { await app.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); };
  return { base, db, stop };
}
const cookieOf = (res) => res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
const post = (base, p, body, cookie) => fetch(`${base}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });

// A signed-in app: collects messages, sends ops and waits for their answers.
function client(base, cookie) {
  const ws = new WebSocket(`${base.replace('http', 'ws')}/ws`, { headers: { cookie } });
  const msgs = [];
  const waiters = [];
  ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    msgs.push(m);
    for (const w of [...waiters]) if (w.test(m)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(m); }
  });
  const next = (test, ms = 3000) => {
    const had = msgs.find(test);
    if (had) { msgs.splice(msgs.indexOf(had), 1); return Promise.resolve(had); }
    return new Promise((resolve, reject) => {
      const w = { test: (m) => { if (!test(m)) return false; msgs.splice(msgs.indexOf(m), 1); return true; }, resolve };
      waiters.push(w);
      setTimeout(() => reject(new Error('timed out waiting for a message')), ms).unref();
    });
  };
  let n = 0;
  const op = async (name, data) => { const id = `t${++n}`; ws.send(JSON.stringify({ t: 'op', id, op: name, data })); return next((m) => m.t === 'ack' && m.id === id); };
  const opened = new Promise((r) => ws.once('open', r));
  return { ws, msgs, next, op, opened, send: (m) => ws.send(JSON.stringify(m)), close: () => ws.close() };
}

test('phones report, admins see everyone’s check live, and Nudge reaches only that person', async () => {
  const { base, db, stop } = await startApp();
  const open = [];
  try {
    const setup = await post(base, '/api/setup', { tripName: 'Japan', name: 'Kai', password: 'secret123' });
    const adminCookie = cookieOf(setup);
    const code = JSON.parse(db.prepare("SELECT value FROM settings WHERE key = 'trip'").get().value).joinCode;
    const join = async (name) => { const r = await post(base, '/api/join', { code, name, password: 'secret123' }); assert.equal(r.status, 200); return cookieOf(r); };
    const aikoCookie = await join('Aiko');
    const benCookie = await join('Ben');
    const aikoId = db.prepare("SELECT id FROM users WHERE name = 'Aiko'").get().id;

    const admin = client(base, adminCookie); open.push(admin);
    const st = await admin.next((m) => m.t === 'state');
    assert.equal(st.ready.length, 3, 'admins get everyone in the first state');
    assert.deepEqual(st.ready.find((r) => r.id === aikoId).missing, ['no phone checked in yet', 'location sharing off', 'no recovery code']);
    assert.equal(st.me.ready.ready, false, 'each person gets their own check');

    const aiko = client(base, aikoCookie); open.push(aiko);
    const ben = client(base, benCookie); open.push(ben);
    const aikoState = await aiko.next((m) => m.t === 'state');
    assert.equal(aikoState.ready, undefined, 'only admins get the list');
    await ben.next((m) => m.t === 'state');

    // Aiko's iPhone, in Safari: the admin's list updates without a reload
    aiko.send({ t: 'device', id: 'iphone-aiko-1', installed: false, endpoint: null, maps: 'none' });
    let list = await admin.next((m) => m.t === 'ready' && m.list.find((r) => r.id === aikoId).missing[0] === 'not on the home screen');
    assert.deepEqual(list.list.find((r) => r.id === aikoId).missing, ['not on the home screen', 'no lock-screen notifications', 'location sharing off', 'no recovery code']);
    const mine = await aiko.next((m) => m.t === 'me.ready' && m.ready.devices.length === 1);
    assert.equal(mine.ready.devices[0].id, 'iphone-aiko-1');

    // She turns on sharing: the list follows
    assert.equal((await aiko.op('loc.share', { on: true })).ok, true);
    list = await admin.next((m) => m.t === 'ready' && m.list.find((r) => r.id === aikoId).missing.includes('no location yet'));
    assert.ok(!list.list.find((r) => r.id === aikoId).missing.includes('location sharing off'));

    // Nudge: admins only, not yourself, only to that person
    assert.match((await aiko.op('ready.nudge', { id: aikoId })).error, /Only trip admins/);
    const kaiId = db.prepare("SELECT id FROM users WHERE name = 'Kai'").get().id;
    assert.match((await admin.op('ready.nudge', { id: kaiId })).error, /That’s you/);
    assert.equal((await admin.op('ready.nudge', { id: aikoId })).ok, true);
    const n1 = await aiko.next((m) => m.t === 'notif');
    assert.equal(n1.item.kind, 'setup');
    assert.deepEqual(n1.item.ref, { type: 'setup', id: String(aikoId) });
    assert.match(n1.item.text, /^Kai asked you to finish getting ready for Japan: not on the home screen, no lock-screen notifications, no location yet, no recovery code\./);
    // Asking again within 15 minutes updates the same notification
    assert.equal((await admin.op('ready.nudge', { id: aikoId })).ok, true);
    const n2 = await aiko.next((m) => m.t === 'notif');
    assert.equal(n2.item.id, n1.item.id);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM notifications WHERE user_id = ? AND kind = 'setup'").get(aikoId).n, 1);
    await new Promise((r) => setTimeout(r, 300));
    assert.ok(!ben.msgs.some((m) => m.t === 'notif'), 'nobody else is told');
    assert.ok(!admin.msgs.some((m) => m.t === 'notif'));

    // Everything set: ready, and a nudge is refused
    db.prepare('INSERT INTO push_subs(user_id, endpoint, p256dh, auth, created_at, fails) VALUES(?, ?, ?, ?, ?, 0)').run(aikoId, EP, 'k', 'a', Date.now());
    db.prepare("UPDATE users SET recovery_hash = 'h', recovery_ack_at = ? WHERE id = ?").run(Date.now(), aikoId);
    aiko.send({ t: 'op', op: 'loc.update', data: { lat: 35.68, lng: 139.76, acc: 10 } });
    aiko.send({ t: 'device', id: 'iphone-aiko-1', installed: true, endpoint: EP, maps: 'fresh', mapsAt: Date.now() });
    list = await admin.next((m) => m.t === 'ready' && m.list.find((r) => r.id === aikoId).ready);
    assert.deepEqual(list.list.find((r) => r.id === aikoId).suggested, ['no profile photo']);
    assert.match((await admin.op('ready.nudge', { id: aikoId })).error, /Aiko is already ready/);

    // The developer console's Accounts tab has the same column
    const login = await fetch(`${base}/dev?devkey=ready-test-dev`, { redirect: 'manual' });
    const people = await (await fetch(`${base}/api/dev/people`, { headers: { cookie: cookieOf(login) } })).json();
    assert.equal(people.people.find((p) => p.id === aikoId).ready.ready, true);
    assert.equal(people.people.find((p) => p.name === 'Ben').ready.missing[0], 'no phone checked in yet');
  } finally {
    for (const c of open) c.close();
    await stop();
  }
});

test('a bad device report is ignored', async () => {
  const { base, db, stop } = await startApp();
  try {
    const setup = await post(base, '/api/setup', { tripName: 'Japan', name: 'Kai', password: 'secret123' });
    const c = client(base, cookieOf(setup));
    await c.next((m) => m.t === 'state');
    c.send({ t: 'device', id: 'no', installed: true });
    c.send({ t: 'device', id: 'x'.repeat(80), installed: true });
    await c.op('notif.read', {}); // a round trip, so the reports were handled
    assert.equal(db.prepare('SELECT COUNT(*) n FROM devices').get().n, 0);
    c.close();
  } finally { await stop(); }
});
