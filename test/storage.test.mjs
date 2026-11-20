// Tiered storage: R2 (hot) + a cold store (Backblaze B2 in production), with the dev stand-in
// (dev/s3.mjs) playing both. Covers copies, moving cold, failover between the two, damaged
// copies, files saved before the index existed, and how long database snapshots are kept.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createBlobStore } from '../server/blobs.js';
import { s3FromEnv, coldFromEnv } from '../server/s3.js';
import { createHA, longTermKeepers } from '../server/ha.js';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'tabi-storage-'));
const HOT_PORT = 19400 + Math.floor(Math.random() * 300), COLD_PORT = HOT_PORT + 400;
const procs = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 3000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await sleep(30); } return false; };
const hit = (port, p, method = 'GET') => fetch(`http://localhost:${port}${p}`, { method });

let hot, cold;
before(async () => {
  for (const [port, name] of [[HOT_PORT, 'hot'], [COLD_PORT, 'cold']]) {
    procs.push(spawn(process.execPath, ['dev/s3.mjs', '--port', String(port), '--dir', path.join(ROOT, name)], { stdio: 'ignore' }));
  }
  assert.ok(await until(async () => (await hit(HOT_PORT, '/__list').catch(() => null))?.ok && (await hit(COLD_PORT, '/__list').catch(() => null))?.ok, 5000), 'stand-ins started');
  hot = s3FromEnv({ S3_ENDPOINT: `http://localhost:${HOT_PORT}`, S3_BUCKET: 'r2', S3_ACCESS_KEY_ID: 'x', S3_SECRET_ACCESS_KEY: 'x' });
  cold = coldFromEnv({ COLD_S3_ENDPOINT: `http://localhost:${COLD_PORT}`, COLD_S3_BUCKET: 'b2', COLD_S3_ACCESS_KEY_ID: 'x', COLD_S3_SECRET_ACCESS_KEY: 'x' });
});
after(() => { procs.forEach((p) => p.kill()); fs.rmSync(ROOT, { recursive: true, force: true }); });

// A fresh database with the real schema, and a store on top of it
let n = 0;
function setup(env = {}) {
  const dir = path.join(ROOT, `node${++n}`);
  fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(':memory:');
  db.exec(fs.readFileSync(new URL('../server/db.js', import.meta.url), 'utf8').match(/CREATE TABLE IF NOT EXISTS blob_index[\s\S]*?;\s*CREATE INDEX IF NOT EXISTS blob_index_hot[^;]*;/)[0]);
  const logs = [];
  const store = createBlobStore(dir, hot, { cold, db, env, log: (l) => logs.push(l) });
  return { dir, db, store, logs, row: (k) => db.prepare('SELECT * FROM blob_index WHERE key = ?').get(k) };
}
const pic = (label, size = 2000) => Buffer.concat([Buffer.from(label), crypto.randomBytes(size)]);
const has = async (s, key) => !!(await s.head(`blobs/${key}`));
// The disk copy's name: the hash and what's left of the extension (how 1.8 names them too)
const onDisk = (dir, key) => path.join(dir, 'blobs', key.replace(/[^a-f0-9.]/g, ''));
const dropLocal = (dir, key) => fs.rmSync(onDisk(dir, key), { force: true });

test('a new file is saved to R2 at once and copied to the cold store soon after', async () => {
  const { store, row } = setup();
  const key = await store.put(pic('a'), 'jpg', 'photo');
  assert.ok(await has(hot, key), 'in R2');
  assert.ok(await until(() => row(key).cold === 1), 'copied cold');
  assert.ok(await has(cold, key), 'in the cold store');
  assert.equal(row(key).hot, 1);
});

test('old files move cold, pinned kinds stay in R2, and moved files are still served', async () => {
  const { dir, store, row, db } = setup({ COLD_AFTER_DAYS: '0', COLD_CHAT_AFTER_DAYS: '0' });
  const photo = await store.put(pic('p'), 'jpg', 'photo');
  const thumb = await store.put(pic('t', 300), 'jpg', 'thumb');
  const avatar = await store.put(pic('v', 300), 'png', 'avatar');
  await until(() => row(photo).cold && row(thumb).cold && row(avatar).cold);
  db.prepare('UPDATE blob_index SET created_at = created_at - 1000').run();
  const did = await store.maintain(() => []);
  assert.equal(did.movedCold, 1, JSON.stringify(did));
  assert.equal(row(photo).hot, 0); assert.equal(row(photo).cold, 1);
  assert.equal(await has(hot, photo), false, 'gone from R2');
  assert.ok(await has(hot, thumb) && await has(hot, avatar), 'thumbnails and profile photos stay in R2');
  // Another node (empty disk) reads it: comes from the cold store, intact
  dropLocal(dir, photo);
  const got = await store.get(photo);
  assert.equal(crypto.createHash('sha256').update(got).digest('hex'), photo.split('.')[0]);
});

test('STORAGE_ALL_HOT=1 brings moved files back into R2 and stops moving them', async () => {
  const one = setup({ COLD_AFTER_DAYS: '0' });
  const key = await one.store.put(pic('back'), 'jpg', 'photo');
  await until(() => one.row(key).cold);
  one.db.prepare('UPDATE blob_index SET created_at = created_at - 1000').run();
  await one.store.maintain(() => []);
  assert.equal(await has(hot, key), false, 'moved cold first');
  // Same database and disk, restarted with the switch on
  const two = createBlobStore(one.dir, hot, { cold, db: one.db, env: { COLD_AFTER_DAYS: '0', STORAGE_ALL_HOT: '1' } });
  dropLocal(one.dir, key);
  const did = await two.maintain(() => []);
  assert.equal(did.copiedHot, 1, JSON.stringify(did));
  assert.equal(did.movedCold, 0);
  assert.ok(await has(hot, key), 'back in R2');
  assert.equal(two.stats().coldOnly.files, 0);
  // Without a cold store, a file only there is reported, not silently lost
  one.db.prepare('UPDATE blob_index SET hot = 0 WHERE key = ?').run(key);
  const r2only = createBlobStore(one.dir, hot, { db: one.db, env: {} });
  assert.equal(r2only.stats().stranded.files, 1);
  assert.ok(await r2only.get(key), 'still tries R2');
});

test('R2 filling up moves the least-used files cold first', async () => {
  const { store, row, db } = setup({ STORAGE_HOT_LIMIT_MB: String(5000 / 1048576) }); // about 5 KB
  const keys = [];
  for (let i = 0; i < 4; i++) keys.push(await store.put(pic(`f${i}`, 2000), 'jpg', 'receipt'));
  await until(() => keys.every((k) => row(k).cold));
  // keys[3] was read recently; keys[0] never
  db.prepare('UPDATE blob_index SET last_read_at = ? WHERE key = ?').run(Date.now(), keys[3]);
  db.prepare('UPDATE blob_index SET created_at = created_at - 5000 WHERE key = ?').run(keys[0]);
  await store.maintain(() => []);
  assert.equal(row(keys[0]).hot, 0, 'oldest moved');
  assert.equal(row(keys[3]).hot, 1, 'recently read stays');
  const s = store.stats();
  assert.ok(s.hot.bytes <= 5000 * 0.9 + 2100, `R2 back under the limit (${s.hot.bytes})`);
});

test('when R2 is down, uploads go straight to the cold store and return to R2 afterwards', async () => {
  const { dir, store, row } = setup();
  await hit(HOT_PORT, '/__down');
  let key;
  try {
    key = await store.put(pic('down'), 'jpg', 'chat');
    assert.equal(row(key).hot, 0); assert.equal(row(key).cold, 1);
    assert.ok(await has(cold, key), 'cold copy made right away');
    dropLocal(dir, key);
    assert.ok(await store.get(key), 'served from the cold store while R2 is down');
  } finally { await hit(HOT_PORT, '/__up'); }

  const did = await store.maintain(() => []);
  assert.equal(did.copiedHot, 1, JSON.stringify(did));
  assert.equal(row(key).hot, 1); assert.equal(row(key).problem, null);
  assert.ok(await has(hot, key), 'back in R2');
});

test('when both stores are down, the upload fails instead of pretending it was saved', async () => {
  const { store } = setup();
  await hit(HOT_PORT, '/__down'); await hit(COLD_PORT, '/__down');
  try { await assert.rejects(store.put(pic('none'), 'jpg', 'photo'), /Try again/); }
  finally { await hit(HOT_PORT, '/__up'); await hit(COLD_PORT, '/__up'); }
});

test('when the cold store is down, copies wait and are made by the next upkeep', async () => {
  const { store, row } = setup();
  await hit(COLD_PORT, '/__down');
  let key;
  try {
    key = await store.put(pic('cd'), 'jpg', 'photo');
    await sleep(200);
    assert.equal(row(key).cold, 0);
    assert.ok(store.stats().waitingForCold >= 1);
  } finally { await hit(COLD_PORT, '/__up'); }
  const did = await store.maintain(() => []);
  assert.ok(did.copiedCold >= 1, JSON.stringify(did));
  assert.equal(row(key).cold, 1);
});

test('a damaged R2 copy is caught, the cold copy is served, and R2 gets a good copy back', async () => {
  const { dir, store, row } = setup();
  const buf = pic('dmg');
  const key = await store.put(buf, 'jpg', 'photo');
  await until(() => row(key).cold);
  await hit(HOT_PORT, `/__corrupt/r2/tabi/blobs/${key}`, 'PUT');
  dropLocal(dir, key);
  const got = await store.get(key);
  assert.ok(got.equals(buf), 'the good copy');
  assert.ok(await until(async () => row(key).hot === 1 && row(key).problem === null), 'R2 copy replaced');
  const again = await hot.get(`blobs/${key}`);
  assert.ok(again.body.equals(buf));
});

test('spot checks find a damaged cold copy and replace it', async () => {
  const { store, row, db } = setup();
  const buf = pic('spot');
  const key = await store.put(buf, 'jpg', 'photo');
  await until(() => row(key).cold);
  db.prepare('UPDATE blob_index SET checked_at = 0 WHERE key = ?').run(key); // first in line
  await hit(COLD_PORT, `/__corrupt/b2/tabi/blobs/${key}`, 'PUT');
  const did = await store.maintain(() => []);
  assert.equal(did.damaged, 1, JSON.stringify(did));
  await store.maintain(() => []);
  assert.equal(row(key).cold, 1);
  assert.ok((await cold.get(`blobs/${key}`)).body.equals(buf), 'cold copy replaced');
});

test('files saved before tiered storage (1.8 and earlier) are indexed and copied cold', async () => {
  // 1.8: a file on disk and in R2, nothing in the index
  const { dir, store, row } = setup();
  const buf = pic('old');
  const key = `${crypto.createHash('sha256').update(buf).digest('hex')}.jpg`;
  fs.writeFileSync(onDisk(dir, key), buf);
  await hot.put(`blobs/${key}`, buf);
  // and an old one, only in R2 (this node's disk never had it)
  const oldBuf = pic('older');
  const oldKey = `${crypto.createHash('sha256').update(oldBuf).digest('hex')}.jpg`;
  await hot.put(`blobs/${oldKey}`, oldBuf);
  const at = Date.now() - 2 * 86400e3, oldAt = Date.now() - 40 * 86400e3;
  const did = await store.maintain(() => [{ key, kind: 'photo', at }, { key: oldKey, kind: 'photo', at: oldAt }]);
  assert.equal(did.indexed, 2);
  assert.equal(row(key).hot, 1); assert.equal(row(key).kind, 'photo'); assert.equal(row(key).created_at, at);
  assert.equal(row(key).cold, 1, 'copied cold in the same run');
  assert.ok(await has(cold, key));
  // The 40-day-old one is copied cold, checked, then moved out of R2
  assert.equal(row(oldKey).size, oldBuf.length, 'size from R2');
  assert.equal(row(oldKey).cold, 1); assert.equal(row(oldKey).hot, 0);
  dropLocal(dir, oldKey);
  assert.ok((await store.get(oldKey)).equals(oldBuf));
});

test('a file with no copy anywhere is reported once, not retried forever', async () => {
  const { store, row, db } = setup();
  db.prepare('INSERT INTO blob_index (key, kind, size, created_at) VALUES (?, ?, ?, ?)').run('0'.repeat(64) + '.jpg', 'photo', 10, Date.now());
  const k = '0'.repeat(64) + '.jpg';
  const d1 = await store.maintain(() => []);
  assert.equal(d1.missing, 1);
  assert.equal(row(k).problem, 'no copy found anywhere');
  const d2 = await store.maintain(() => []);
  assert.equal(d2.missing, 0);
  assert.ok(store.stats().problems.some((p) => p.key === k));
});

test('deleting a file removes it from both stores and the index', async () => {
  const { store, row } = setup();
  const key = await store.put(pic('del'), 'jpg', 'photo');
  await until(() => row(key).cold);
  await store.del(key);
  assert.equal(row(key), undefined);
  assert.equal(await has(hot, key), false);
  assert.equal(await has(cold, key), false);
});

test('the local disk is a cache: least-read files with copies elsewhere are cleared', async () => {
  const { dir, store, row, db } = setup({ LOCAL_CACHE_MB: String(4500 / 1048576) });
  const keys = [];
  for (let i = 0; i < 3; i++) keys.push(await store.put(pic(`c${i}`, 2000), 'jpg', 'photo'));
  await until(() => keys.every((k) => row(k).cold));
  db.prepare('UPDATE blob_index SET last_read_at = ? WHERE key = ?').run(Date.now() + 1000, keys[2]);
  const did = await store.maintain(() => []);
  assert.ok(did.evicted >= 1, JSON.stringify(did));
  assert.ok(fs.existsSync(onDisk(dir, keys[2])), 'most recently read kept');
  assert.ok(await store.get(keys[0]), 'cleared files still load');
});

// ---------- database snapshots ----------
const iso = (t) => new Date(t).toISOString().replace(/[:.]/g, '-');
test('long-term snapshots: first of each day for 30 days, first of each week for a year', () => {
  const now = Date.parse('2026-11-19T12:00:00Z');
  const keys = [];
  for (let h = 0; h < 400 * 24; h += 6) keys.push(`db/history/${iso(now - h * 3600e3)}.sqlite.gz`);
  const keep = longTermKeepers(keys, now);
  const days = new Set([...keep].map((k) => k.slice(11, 21)));
  // ~31 daily (last 30 days) + ~48 weekly beyond that, nothing past a year
  assert.ok(keep.size > 70 && keep.size < 90, `kept ${keep.size}`);
  assert.ok([...keep].every((k) => now - Date.parse(k.slice(11, 21)) <= 366 * 86400e3));
  assert.ok(days.has('2026-11-19') && days.has('2026-11-01'));
  assert.ok(keep.has(`db/history/${iso(Date.parse('2026-11-19T00:00:00Z'))}.sqlite.gz`), 'the first one of the day');
});

test('old snapshots: recent kept in R2, keepers moved cold, the rest deleted', async () => {
  const pre = `db/history/`;
  const now = Date.now();
  const mk = (h) => `${pre}${iso(Math.floor((now - h * 3600e3) / 3600e3) * 3600e3)}.sqlite.gz`;
  const recent = [1, 5, 30].map(mk), old = [];
  for (let h = 49; h < 24 * 10; h += 1) old.push(mk(h));
  for (const k of [...recent, ...old]) await hot.put(k, Buffer.from(k));
  const ha = createHA({ s3: hot, cold, dataDir: path.join(ROOT, 'ha'), node: 't', env: {}, log: () => {} });
  const r = await ha.keepHistory();
  const inHot = (await hot.list(pre)).map((o) => o.key), inCold = (await cold.list(pre)).map((o) => o.key);
  for (const k of recent) assert.ok(inHot.includes(k), `recent ${k} stays in R2`);
  assert.equal(inHot.length, recent.length, 'nothing older than 48 hours left in R2');
  assert.ok(inCold.length >= 7 && inCold.length <= 10, `about one a day moved cold (${inCold.length})`);
  assert.equal(r.moved, inCold.length);
  assert.equal((await cold.get(inCold[0])).body.toString(), inCold[0], 'moved intact');
  // Running again changes nothing
  assert.deepEqual(await ha.keepHistory(), { moved: 0, deleted: 0 });
});
