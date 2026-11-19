// High availability: one leader at a time, chosen with a lease object in S3/R2.
//
//   lease.json            { holder, priority, epoch, expiresAt, reservedFor? }
//   handoff.json          written by the primary to ask a leading backup to hand back
//   db/latest.sqlite.gz   newest database snapshot (metadata: epoch, ts, node)
//   db/history/*.gz       hourly snapshots, for point-in-time recovery: R2 keeps the last 48 hours;
//                         older ones are kept one a day for 30 days and one a week for a year, in the
//                         cold store (Backblaze B2) when there is one, otherwise in R2. The cold store
//                         also gets a fresh one at least once a day, as an off-site copy.
//
// The leader renews the lease every RENEW ms and uploads a snapshot whenever data changed.
// If it can't renew in time it steps down (exits) before the lease runs out, so two nodes
// never serve at once. A standby takes over once the lease has expired (backups wait a bit
// longer than the primary). After a failover, the primary asks for its role back once it has
// been healthy for FAILBACK ms.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { DB_FILE } from './db.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const gzip = (buf) => new Promise((res, rej) => zlib.gzip(buf, { level: 6 }, (e, out) => (e ? rej(e) : res(out))));
const DAY = 864e5;

// db/history/2026-11-19T03-00-00-000Z.sqlite.gz → its time
const historyTime = (key) => {
  const m = /(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/.exec(key);
  return m ? Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`) : NaN;
};
// Which old snapshots are worth keeping: the first of each day for 30 days, the first of each week for a year
export function longTermKeepers(keys, now = Date.now()) {
  const keep = new Set();
  const days = new Set(), weeks = new Set();
  for (const { key, ts } of keys.map((key) => ({ key, ts: historyTime(key) })).filter((k) => k.ts).sort((a, b) => a.ts - b.ts)) {
    const age = now - ts;
    const day = Math.floor(ts / DAY), week = Math.floor((ts / DAY + 3) / 7); // weeks start on Monday
    if (age <= 30 * DAY && !days.has(day)) { days.add(day); keep.add(key); }
    if (age <= 365 * DAY && !weeks.has(week)) { weeks.add(week); keep.add(key); }
  }
  return keep;
}
const parse = (buf) => { try { return JSON.parse(buf.toString()); } catch { return null; } };

export function createHA({ s3, cold = null, dataDir, node, priority = 'primary', env = process.env, log = console.log }) {
  const TTL = +(env.HA_LEASE_TTL_MS || 30000);
  const RENEW = +(env.HA_RENEW_MS || 10000);
  const GRACE = +(env.HA_GRACE_MS || 15000);           // clock-skew allowance before anyone takes an expired lease
  const BACKUP_WAIT = +(env.HA_BACKUP_EXTRA_MS || 15000); // backups wait longer so the primary wins ties
  const FAILBACK = +(env.HA_FAILBACK_MS || 120000);
  const SNAPSHOT = +(env.HA_SNAPSHOT_MS || 15000);
  const stateFile = path.join(dataDir, 'ha-state.json');

  const st = {
    role: 'standby', epoch: 0, etag: null, acquiredAt: 0, lastRenewOk: 0,
    lastSnapshot: 0, lastSnapshotChanges: -1, lastHistory: 0, lastColdCopy: 0, holder: null, error: null,
  };
  let timers = [];
  let stopping = false;

  const LEASE_IO = Math.max(1000, Math.min(5000, RENEW)); // lease requests must finish well inside the TTL

  async function readLease() {
    const r = await s3.get('lease.json', { timeout: LEASE_IO });
    return r ? { lease: parse(r.body), etag: r.etag } : { lease: null, etag: null };
  }

  // Block until this node holds the lease.
  async function acquire() {
    const waitingSince = Date.now();
    let lastAsk = 0;
    for (;;) {
      try {
        const { lease, etag } = await readLease();
        const t = Date.now();
        st.holder = lease?.holder || null;
        let canTake = false;
        if (!lease) canTake = true;
        else if (lease.holder === node) canTake = true; // we restarted while holding it
        else if (lease.reservedFor) canTake = lease.reservedFor === node || lease.expiresAt + GRACE < t;
        else {
          const wait = GRACE + (priority === 'primary' ? 0 : BACKUP_WAIT);
          canTake = lease.expiresAt + wait < t;
        }

        if (!canTake && priority === 'primary' && lease?.priority === 'backup' && t - waitingSince > FAILBACK && t - lastAsk > FAILBACK) {
          await s3.put('handoff.json', JSON.stringify({ requestedBy: node, at: t }), { contentType: 'application/json' });
          lastAsk = t;
          log(`[ha] ${lease.holder} is serving as backup; asked it to hand back to ${node}`);
        }

        if (canTake) {
          const next = { holder: node, priority, epoch: (lease?.epoch || 0) + 1, acquiredAt: t, expiresAt: t + TTL };
          const r = await s3.put('lease.json', JSON.stringify(next), { contentType: 'application/json', timeout: LEASE_IO, ...(etag ? { ifMatch: etag } : { ifNoneMatch: true }) });
          if (!r.ok) log(`[ha] someone else changed the lease first (HTTP ${r.status}); retrying`);
          if (r.ok) {
            Object.assign(st, { role: 'leader', epoch: next.epoch, etag: r.etag, lease: next, acquiredAt: t, lastRenewOk: t, holder: node, error: null });
            log(`[ha] ${node} is now the leader (epoch ${next.epoch})`);
            if (priority === 'primary') await s3.del('handoff.json').catch(() => {});
            return st.epoch;
          }
        }
        st.error = null;
      } catch (e) {
        st.error = e.message;
        const hint = /\b403\b/.test(e.message) ? ' (check S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY and that the token can use this bucket)'
          : /\b404\b/.test(e.message) ? ' (check S3_BUCKET matches the bucket name)'
          : /fetch failed|ENOTFOUND|EAI_AGAIN/.test(e.message) ? ' (check S3_ENDPOINT and that this machine has internet)' : '';
        log(`[ha] lease check failed: ${e.message}${hint}`);
      }
      await sleep(RENEW / 2 + Math.random() * 1000);
    }
  }

  // Make the local database the newest copy before opening it.
  async function prepareData() {
    fs.mkdirSync(dataDir, { recursive: true });
    const dbPath = path.join(dataDir, DB_FILE);
    const local = (() => { try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { return {}; } })();
    const head = await s3.head('db/latest.sqlite.gz');
    const snapEpoch = head ? +(head.meta.epoch || 0) : -1;
    const haveLocal = fs.existsSync(dbPath);
    if (head && !(haveLocal && (local.epoch || 0) >= snapEpoch)) {
      const r = await s3.get('db/latest.sqlite.gz');
      for (const f of [dbPath, dbPath + '-wal', dbPath + '-shm']) fs.rmSync(f, { force: true });
      fs.writeFileSync(dbPath, zlib.gunzipSync(r.body));
      log(`[ha] restored snapshot from ${r.meta.node || '?'} (epoch ${snapEpoch}, ${new Date(+r.meta.ts).toISOString()})`);
    } else {
      log(`[ha] keeping local database${head ? ` (local epoch ${local.epoch} ≥ snapshot epoch ${snapEpoch})` : ' (no snapshot yet)'}`);
    }
    fs.writeFileSync(stateFile, JSON.stringify({ epoch: st.epoch, node }));
  }

  async function snapshot(db, { force = false } = {}) {
    // One at a time: compressing is asynchronous now, so a slow one could overlap the next
    while (st.snapshotting) { if (!force) return false; await sleep(50); }
    st.snapshotting = true;
    try { return await snapshotNow(db, force); } finally { st.snapshotting = false; }
  }
  async function snapshotNow(db, force) {
    const changes = db.prepare('SELECT total_changes() AS n').get().n;
    if (!force && changes === st.lastSnapshotChanges) return false;
    if (st.role === 'leader' && Date.now() - st.lastRenewOk > TTL - GRACE / 3) throw new Error('lease not confirmed recently; refusing to upload');
    const tmp = path.join(dataDir, 'snapshot.tmp.db');
    fs.rmSync(tmp, { force: true });
    db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
    // Compressing happens off the main thread, so requests keep being answered meanwhile
    const gz = await gzip(await fs.promises.readFile(tmp));
    fs.rmSync(tmp, { force: true });
    const ts = Date.now();
    await s3.put('db/latest.sqlite.gz', gz, { contentType: 'application/gzip', meta: { epoch: st.epoch, ts, node } });
    if (ts - st.lastHistory > 3600e3) {
      const name = `db/history/${new Date(ts).toISOString().replace(/[:.]/g, '-')}.sqlite.gz`;
      await s3.put(name, gz, { contentType: 'application/gzip', meta: { epoch: st.epoch, ts, node } });
      st.lastHistory = ts;
      // At least once a day, a copy away from R2 too
      if (cold && ts - st.lastColdCopy > DAY) {
        try { await cold.put(name, gz, { contentType: 'application/gzip', meta: { epoch: st.epoch, ts, node } }); st.lastColdCopy = ts; }
        catch (e) { log(`[backup] copy to ${cold.name || 'the cold store'} failed: ${e.message}`); }
      }
    }
    st.lastSnapshot = ts;
    st.lastSnapshotChanges = changes;
    return true;
  }

  // Leader duties: renew, watch for hand-back requests, snapshot. Calls onStepDown when leadership is lost.
  function runLeader(db, { onStepDown }) {
    const stepDown = async (why, { handoffTo } = {}) => {
      if (stopping) return;
      stopping = true;
      timers.forEach(clearInterval);
      log(`[ha] stepping down: ${why}`);
      if (handoffTo) {
        try {
          await snapshot(db, { force: true });
          const { lease, etag } = await readLease();
          if (lease?.holder === node) {
            await s3.put('lease.json', JSON.stringify({ ...lease, holder: null, reservedFor: handoffTo, expiresAt: Date.now() + 60000 }), { contentType: 'application/json', ifMatch: etag });
          }
          await s3.del('handoff.json').catch(() => {});
        } catch (e) { log(`[ha] hand-back cleanup failed: ${e.message}`); }
      }
      st.role = 'standby';
      onStepDown(why);
    };

    // Snapshot right away so the snapshot's epoch marks this leadership term.
    snapshot(db, { force: true }).catch((e) => log(`[ha] first snapshot failed: ${e.message}`));

    // Watchdog: independent of any request in flight, give up before the lease can expire.
    timers.push(setInterval(() => {
      if (Date.now() - st.lastRenewOk > TTL - GRACE / 2) stepDown('could not renew the lease in time');
    }, 500));

    let renewing = false;
    timers.push(setInterval(async () => {
      if (renewing) return;
      renewing = true;
      try {
        if (priority === 'backup') {
          const h = await s3.get('handoff.json', { timeout: LEASE_IO });
          const req = h && parse(h.body);
          if (req && req.at > st.acquiredAt) return stepDown(`primary ${req.requestedBy} is back`, { handoffTo: req.requestedBy });
        }
        // Renew against the version we wrote last; only a real takeover changes it.
        const t = Date.now();
        const next = { ...st.lease, expiresAt: t + TTL };
        let r = await s3.put('lease.json', JSON.stringify(next), { contentType: 'application/json', ifMatch: st.etag, timeout: LEASE_IO });
        if (!r.ok) {
          const { lease, etag } = await readLease();
          if (!lease || lease.holder !== node || lease.epoch !== st.epoch) return stepDown(`lease now held by ${lease?.holder || 'nobody'}`);
          // Still ours: the stored version tag didn't match (storage quirk). Retry once with the current one.
          log(`[ha] lease version mismatch (HTTP ${r.status}, had ${st.etag}, storage has ${etag}); retrying`);
          r = await s3.put('lease.json', JSON.stringify(next), { contentType: 'application/json', ifMatch: etag, timeout: LEASE_IO });
          if (!r.ok) return stepDown(`storage refused the conditional lease update (HTTP ${r.status}); see docs/HOSTING.md troubleshooting`);
        }
        st.etag = r.etag;
        st.lease = next;
        st.lastRenewOk = t;
        st.error = null;
      } catch (e) {
        st.error = e.message;
        log(`[ha] renew failed: ${e.message}`);
      } finally { renewing = false; }
    }, RENEW));

    timers.push(setInterval(() => {
      snapshot(db).catch((e) => { st.error = e.message; log(`[ha] snapshot failed: ${e.message}`); });
    }, SNAPSHOT));

    // Tidy old snapshots a few minutes after taking over, then hourly
    const tidy = () => keepHistory().catch((e) => log(`[backup] tidying old snapshots failed: ${e.message}`));
    timers.push(setTimeout(tidy, +(env.HA_TIDY_FIRST_MS || 5 * 60e3)));
    timers.push(setInterval(tidy, 3600e3));
  }

  // Old snapshots: R2 keeps 48 hours of hourly ones; the long-term keepers go to the cold store
  // (copied first), or stay in R2 when there is no cold store. Everything else is deleted.
  async function keepHistory() {
    const now = Date.now();
    const hot = await s3.list('db/history/');
    const coldList = cold ? await cold.list('db/history/') : [];
    const inCold = new Set(coldList.map((o) => o.key));
    const keepers = longTermKeepers([...hot.map((o) => o.key), ...coldList.map((o) => o.key)], now);
    let moved = 0, deleted = 0;
    for (const { key } of hot) {
      const ts = historyTime(key);
      if (!ts || now - ts <= 2 * DAY) continue;
      if (keepers.has(key)) {
        if (!cold) continue; // no cold store: R2 keeps it
        if (!inCold.has(key)) {
          const r = await s3.get(key);
          if (!r) continue;
          await cold.put(key, r.body, { contentType: 'application/gzip', meta: r.meta });
          inCold.add(key); moved++;
        }
      }
      await s3.del(key); deleted++;
    }
    for (const { key } of coldList) {
      const ts = historyTime(key);
      if (ts && now - ts > 2 * DAY && !keepers.has(key)) { await cold.del(key); deleted++; }
    }
    if (moved || deleted) log(`[backup] old snapshots: ${moved} moved to ${cold?.name || 'cold storage'}, ${deleted} deleted`);
    return { moved, deleted };
  }

  async function shutdown(db) {
    timers.forEach(clearInterval);
    if (st.role !== 'leader' || !db) return;
    try { await snapshot(db, { force: true }); log('[ha] final snapshot uploaded'); }
    catch (e) { log(`[ha] final snapshot failed: ${e.message}`); }
    // The lease is kept: a quick restart (deploys) re-acquires it; a crash lets it expire.
  }

  return {
    acquire, prepareData, runLeader, shutdown, snapshot, keepHistory,
    status: () => ({ role: st.role, node, priority, epoch: st.epoch, holder: st.holder, lastSnapshot: st.lastSnapshot || null, lastRenewOk: st.lastRenewOk || null, error: st.error }),
  };
}

// Plain backups (no failover): snapshot to S3 when data changes.
export function startBackups({ s3, cold = null, dataDir, node, db, env = process.env, log = console.log }) {
  const ha = createHA({ s3, cold, dataDir, node, priority: 'primary', env, log });
  const every = +(env.BACKUP_EVERY_MS || 60000);
  const t = setInterval(() => ha.snapshot(db).catch((e) => log(`[backup] failed: ${e.message}`)), every);
  t.unref();
  const tidy = () => ha.keepHistory().catch((e) => log(`[backup] tidying old snapshots failed: ${e.message}`));
  setTimeout(tidy, +(env.HA_TIDY_FIRST_MS || 5 * 60e3)).unref();
  setInterval(tidy, 3600e3).unref();
  return ha;
}
