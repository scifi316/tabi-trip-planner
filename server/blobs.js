// Content-addressed file storage (photos, chat pictures, receipts, emojis, the Android app), in tiers:
//
//   this node's disk (a cache)  →  R2, "hot" (shared by all nodes; the first 10 GB are free)  →  the cold store (Backblaze B2)
//
// - Every file is named by its SHA-256, so any copy can be checked, and copies can never disagree.
// - Saving: the file goes to R2 at once, and to the cold store in the background, so it ends up
//   with two copies away from this computer. If R2 is down it goes to the cold store at once instead.
// - Reading: this node's disk, then R2, then the cold store. A copy whose fingerprint doesn't match
//   is skipped; a store that keeps failing is skipped for a minute.
// - Moving cold (the leader, every 10 minutes): full-size pictures nobody has opened for a while
//   leave R2 once the cold store has a copy; when R2 passes STORAGE_HOT_LIMIT_MB the stalest go
//   first. Thumbnails, emojis, profile photos and the app always stay in R2. A cold picture that's
//   opened again is copied back to R2.
// - Checking: files missing a copy get one; a few cold copies are downloaded and checked each run.
//
// Without a cold store it behaves as before: this disk plus R2. Without R2, just this disk.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const MIME = { png: 'image/png', webp: 'image/webp', gif: 'image/gif', apk: 'application/vnd.android.package-archive' };
const DAY = 864e5;
const MB = 1048576;
// What a file is decides how long it stays hot. These never leave R2.
export const PINNED = ['thumb', 'avatar', 'emoji', 'apk'];
const NOT_IN_R2 = 'not in R2 yet';
const LOST = 'no copy found anywhere';
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const intact = (key, buf) => key.startsWith(`${sha(buf)}.`);

export function createBlobStore(dataDir, s3, { cold = null, db = null, env = {}, log = () => {} } = {}) {
  const dir = path.join(dataDir, 'blobs');
  fs.mkdirSync(dir, { recursive: true });
  const local = (key) => path.join(dir, key.replace(/[^a-f0-9.]/g, ''));
  const num = (v, d) => (v === undefined || v === null || String(v).trim() === '' || Number.isNaN(+v) ? d : +v);
  const HOT_LIMIT = num(env.STORAGE_HOT_LIMIT_MB, 8192) * MB;
  const LOCAL_LIMIT = num(env.LOCAL_CACHE_MB, 4096) * MB;
  const coldAfter = (kind) => (kind === 'chat' ? num(env.COLD_CHAT_AFTER_DAYS, 14) : num(env.COLD_AFTER_DAYS, 30)) * DAY;
  // STORAGE_ALL_HOT=1: stop moving files cold and copy every cold-only file back into R2 (before removing the cold
  // store, or rolling back to 1.8, which only reads R2)
  const ALL_HOT = /^(1|true|on|yes)$/i.test(String(env.STORAGE_ALL_HOT || ''));
  const HOT = s3 ? { name: 'R2', store: s3, col: 'hot' } : null;
  const COLD = cold ? { name: cold.name || 'cold storage', store: cold, col: 'cold' } : null;
  const tiers = [HOT, COLD].filter(Boolean);

  // A store that keeps failing is skipped for a minute, so one outage doesn't slow every request
  const health = new Map();
  const usable = (t) => (health.get(t.name)?.until || 0) < Date.now();
  const failed = (t, e) => {
    const h = health.get(t.name) || { n: 0 };
    h.n++; h.last = String(e?.message || e).slice(0, 200); h.at = Date.now();
    if (h.n >= 3) { h.until = Date.now() + 60e3; if (h.n === 3) log(`[storage] ${t.name} keeps failing (${h.last}); skipping it for a minute`); }
    health.set(t.name, h);
  };
  const worked = (t) => { if (health.get(t.name)?.n >= 3) log(`[storage] ${t.name} is working again`); health.delete(t.name); };

  // ---------- the index (where each file has copies) ----------
  const q = db && {
    get: db.prepare('SELECT * FROM blob_index WHERE key = ?'),
    // Files on disk are named <sha256>. plus what's left of the extension (1.8's naming, kept so old disks still work)
    byHash: db.prepare("SELECT * FROM blob_index WHERE key > ? || '.' AND key < ? || '/' LIMIT 1"),
    add: db.prepare(`INSERT INTO blob_index (key, kind, size, created_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET kind = COALESCE(blob_index.kind, excluded.kind), size = MAX(blob_index.size, excluded.size)`),
    // One problem note per file. R2's notes mention R2; a store clears only its own notes when it's fine again.
    hot: db.prepare(`UPDATE blob_index SET hot = ?1,
      problem = CASE WHEN ?2 IS NOT NULL THEN ?2 WHEN problem LIKE '%R2%' OR problem = '${LOST}' THEN NULL ELSE problem END WHERE key = ?3`),
    cold: db.prepare(`UPDATE blob_index SET cold = ?1, checked_at = COALESCE(?2, checked_at),
      problem = CASE WHEN ?3 IS NOT NULL THEN ?3 WHEN problem LIKE '%R2%' THEN problem ELSE NULL END WHERE key = ?4`),
    read: db.prepare('UPDATE blob_index SET reads = reads + ?, last_read_at = MAX(COALESCE(last_read_at, 0), ?) WHERE key = ?'),
    del: db.prepare('DELETE FROM blob_index WHERE key = ?'),
    keys: db.prepare('SELECT key FROM blob_index'),
    hotBytes: db.prepare('SELECT COALESCE(SUM(size), 0) AS n FROM blob_index WHERE hot = 1'),
  };
  const mark = (t, key, on, problem = null) => {
    if (!q) return;
    if (t.col === 'hot') q.hot.run(on ? 1 : 0, problem, key);
    else q.cold.run(on ? 1 : 0, on ? Date.now() : null, problem, key);
  };
  const row = (key) => q?.get.get(key) || null;

  // Reads are counted in memory and written once a minute, not on every request
  const reads = new Map();
  const touch = (key) => { const r = reads.get(key) || { n: 0, at: 0 }; r.n++; r.at = Date.now(); reads.set(key, r); };
  function flushReads() {
    if (!q || !reads.size) return;
    const batch = [...reads]; reads.clear();
    db.exec('BEGIN');
    try { for (const [key, r] of batch) q.read.run(r.n, r.at, key); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); log(`[storage] couldn’t record reads: ${e.message}`); }
  }

  // Skips the upload when the store already has the file, unless we're replacing a damaged copy
  const putTo = async (t, key, buf, { repair = false } = {}) => {
    if (repair || !(await t.store.head(`blobs/${key}`))) await t.store.put(`blobs/${key}`, buf, { contentType: MIME[key.split('.').pop()] || 'image/jpeg' });
  };
  // A copy of the file from wherever one is: this disk, then R2
  async function fetchAny(key) {
    try { return fs.readFileSync(local(key)); } catch { /* not here */ }
    if (HOT && usable(HOT)) {
      try {
        const r = await HOT.store.get(`blobs/${key}`); worked(HOT);
        if (r && intact(key, r.body)) return r.body;
        mark(HOT, key, false, r ? 'damaged copy in R2' : 'missing from R2');
      } catch (e) { failed(HOT, e); }
    }
    return null;
  }

  // Copies to the cold store happen in the background, one at a time
  const toCold = new Set();
  let copying = false;
  async function drainCold() {
    if (copying || !COLD) return;
    copying = true;
    try {
      for (const key of toCold) {
        toCold.delete(key);
        if (!usable(COLD)) break;
        const buf = await fetchAny(key);
        if (!buf) continue;
        try { await putTo(COLD, key, buf); worked(COLD); mark(COLD, key, true); } catch (e) { failed(COLD, e); }
      }
    } finally { copying = false; }
  }

  // Copy a picture that came back from the cold store into R2 again, while R2 has room
  let hotBytesCache = { at: 0, n: 0 };
  const hotBytes = () => {
    if (!q) return 0;
    if (Date.now() - hotBytesCache.at > 60e3) hotBytesCache = { at: Date.now(), n: q.hotBytes.get().n };
    return hotBytesCache.n;
  };
  async function rewarm(key, buf) {
    if (!HOT || !usable(HOT) || hotBytes() + buf.length > HOT_LIMIT * 0.9) return;
    try { await putTo(HOT, key, buf, { repair: true }); worked(HOT); mark(HOT, key, true); hotBytesCache.n += buf.length; } catch (e) { failed(HOT, e); }
  }

  const store = {
    durable: tiers.length > 0,
    tiers: tiers.map((t) => t.name),

    async put(buf, ext = 'jpg', kind = 'file') {
      const key = `${sha(buf)}.${ext}`;
      const file = local(key);
      if (!fs.existsSync(file)) fs.writeFileSync(file, buf);
      if (!tiers.length) return key;
      q?.add.run(key, kind, buf.length, Date.now());
      const was = row(key);
      let offsite = !!(was && (was.hot || was.cold));
      // R2 first: it's the shared copy every node reads
      if (HOT && !was?.hot) {
        try {
          if (!usable(HOT)) throw new Error('skipped: it has been failing');
          await putTo(HOT, key, buf); worked(HOT); mark(HOT, key, true); offsite = true;
        } catch (e) { if (!/^skipped/.test(e.message)) failed(HOT, e); q?.hot.run(0, NOT_IN_R2, key); }
      }
      if (COLD && !was?.cold) {
        if (offsite) { toCold.add(key); setImmediate(drainCold); } else {
          // R2 is down: the cold copy has to be made now, so the file is safe off this computer
          try { await putTo(COLD, key, buf); worked(COLD); mark(COLD, key, true); offsite = true; } catch (e) { failed(COLD, e); }
        }
      }
      if (!offsite) throw new Error('Couldn’t save the file to storage. Try again in a minute.');
      return key;
    },

    async get(key) {
      const file = local(key);
      if (fs.existsSync(file)) { touch(key); return fs.readFileSync(file); }
      const r0 = row(key);
      // Skip R2 when the index says the file has moved cold
      const order = tiers.filter((t) => !(t === HOT && COLD && r0 && !r0.hot && r0.cold));
      let hotMissed = !order.includes(HOT);
      for (const t of order) {
        if (!usable(t)) continue;
        let r;
        try { r = await t.store.get(`blobs/${key}`, { timeout: 20000 }); worked(t); } catch (e) { failed(t, e); continue; }
        if (!r) { if (r0?.[t.col]) mark(t, key, false, `missing from ${t.name}`); if (t === HOT) hotMissed = true; continue; }
        if (!intact(key, r.body)) {
          log(`[storage] the copy of ${key} in ${t.name} is damaged; using another`);
          mark(t, key, false, `damaged copy in ${t.name}`);
          if (t === HOT) hotMissed = true;
          continue;
        }
        try { fs.writeFileSync(file, r.body); } catch { /* disk full: serve it anyway */ }
        touch(key);
        if (t === COLD && hotMissed) rewarm(key, r.body);
        return r.body;
      }
      return null;
    },

    async del(key) {
      try { fs.unlinkSync(local(key)); } catch { /* already gone */ }
      toCold.delete(key);
      for (const t of tiers) await t.store.del(`blobs/${key}`).catch(() => {});
      q?.del.run(key);
    },

    // ---------- the leader's upkeep ----------
    lastRun: null,
    async maintain(refs = () => []) {
      if (!q || !tiers.length || store.running) return null;
      store.running = true;
      const did = { at: Date.now(), indexed: 0, copiedCold: 0, copiedHot: 0, movedCold: 0, checked: 0, damaged: 0, missing: 0, evicted: 0 };
      try {
        flushReads();
        const MAX = 200; // work per run, so a big backlog doesn't hog the server
        // 1. Files saved before the index existed: add them, and find out which stores have them
        const known = new Set(q.keys.all().map((r) => r.key));
        for (const ref of refs()) {
          if (known.has(ref.key) || did.indexed >= MAX) continue;
          known.add(ref.key);
          let size = 0; try { size = fs.statSync(local(ref.key)).size; } catch { /* only remote */ }
          q.add.run(ref.key, ref.kind, size, ref.at || Date.now());
          for (const t of tiers) {
            if (!usable(t)) continue;
            try { const h = await t.store.head(`blobs/${ref.key}`); worked(t); if (h) { mark(t, ref.key, true); if (!size && h.size) q.add.run(ref.key, ref.kind, h.size, ref.at || Date.now()); } } catch (e) { failed(t, e); }
          }
          did.indexed++;
        }

        // 2. Every file needs a copy in each store
        if (COLD && usable(COLD)) {
          for (const r of db.prepare(`SELECT key, problem FROM blob_index WHERE cold = 0 AND COALESCE(problem, '') != '${LOST}' ORDER BY created_at LIMIT ?`).all(MAX)) {
            const buf = await fetchAny(r.key);
            if (!buf) { if (!row(r.key)?.hot) { q.hot.run(0, LOST, r.key); did.missing++; } continue; } // still marked in R2: R2 was unreachable, try next time
            try { await putTo(COLD, r.key, buf, { repair: !!r.problem }); worked(COLD); mark(COLD, r.key, true); did.copiedCold++; } catch (e) { failed(COLD, e); break; }
          }
        }
        if (HOT && usable(HOT)) {
          // Files that belong in R2 but aren't there: saved while R2 was down, a damaged or missing R2 copy, or a
          // pinned kind (thumbnails, profile photos...) that lost its R2 copy. Files moved cold on purpose stay cold.
          const pinned = PINNED.map(() => '?').join(',');
          const want = db.prepare(`SELECT key, cold FROM blob_index WHERE hot = 0 AND COALESCE(problem, '') != '${LOST}'
            AND (${ALL_HOT ? '1' : `cold = 0 OR problem IS NOT NULL OR COALESCE(kind, 'file') IN (${pinned})`}) ORDER BY created_at LIMIT ?`).all(...(ALL_HOT ? [] : PINNED), MAX);
          for (const r of want) {
            let buf = null; try { buf = fs.readFileSync(local(r.key)); } catch { /* not here */ }
            if (!buf && r.cold && COLD && usable(COLD)) {
              try { const got = await COLD.store.get(`blobs/${r.key}`); worked(COLD); if (got && intact(r.key, got.body)) buf = got.body; } catch (e) { failed(COLD, e); continue; }
            }
            if (!buf) { if (!r.cold) { q.hot.run(0, LOST, r.key); did.missing++; } continue; }
            try { await putTo(HOT, r.key, buf, { repair: true }); worked(HOT); mark(HOT, r.key, true); did.copiedHot++; } catch (e) { failed(HOT, e); break; }
          }
          hotBytesCache.at = 0;
        }

        // 3. Moving cold: only files the cold store has, never the pinned kinds
        if (HOT && COLD && !ALL_HOT && usable(HOT) && usable(COLD)) {
          const pinned = PINNED.map(() => '?').join(',');
          const candidates = db.prepare(`SELECT key, kind, size, created_at, COALESCE(last_read_at, created_at) AS used FROM blob_index
            WHERE hot = 1 AND cold = 1 AND COALESCE(kind, 'file') NOT IN (${pinned}) ORDER BY used ASC, size DESC`).all(...PINNED);
          let bytes = q.hotBytes.get().n;
          const now = Date.now();
          for (const c of candidates) {
            const stale = now - c.used > coldAfter(c.kind);
            const crowded = bytes > HOT_LIMIT * 0.9;
            if (!stale && !crowded) continue;
            if (did.movedCold >= MAX) break;
            // Make sure the cold copy is really there before removing the R2 one
            try {
              const h = await COLD.store.head(`blobs/${c.key}`); worked(COLD);
              if (!h || (c.size && h.size && h.size !== c.size)) { mark(COLD, c.key, false, 'cold copy missing or wrong size'); continue; }
              await HOT.store.del(`blobs/${c.key}`); worked(HOT);
              q.hot.run(0, null, c.key);
              bytes -= c.size; did.movedCold++;
            } catch (e) { failed(COLD, e); break; }
          }
          hotBytesCache = { at: Date.now(), n: bytes };
        }

        // 4. Spot checks: download a few cold copies, oldest-checked first, and check their fingerprints
        if (COLD && usable(COLD)) {
          for (const r of db.prepare('SELECT key FROM blob_index WHERE cold = 1 ORDER BY COALESCE(checked_at, 0) ASC LIMIT 3').all()) {
            try {
              const got = await COLD.store.get(`blobs/${r.key}`); worked(COLD);
              did.checked++;
              if (got && intact(r.key, got.body)) q.cold.run(1, Date.now(), null, r.key);
              else { did.damaged++; mark(COLD, r.key, false, got ? 'damaged copy in the cold store' : 'missing from the cold store'); log(`[storage] the cold copy of ${r.key} is ${got ? 'damaged' : 'missing'}; it will be copied again`); }
            } catch (e) { failed(COLD, e); break; }
          }
        }

        // 5. This node's disk is a cache: keep it under LOCAL_CACHE_MB, dropping the least-read files that have copies elsewhere
        const files = fs.readdirSync(dir).map((f) => { try { const s = fs.statSync(path.join(dir, f)); return { key: f, size: s.size }; } catch { return null; } }).filter(Boolean);
        let localBytes = files.reduce((a, f) => a + f.size, 0);
        if (localBytes > LOCAL_LIMIT) {
          const ranked = files.map((f) => ({ ...f, r: q.byHash.get(f.key.slice(0, 64), f.key.slice(0, 64)) })).filter((f) => f.r && (f.r.hot || f.r.cold))
            .sort((a, b) => (a.r.last_read_at || a.r.created_at) - (b.r.last_read_at || b.r.created_at));
          for (const f of ranked) {
            if (localBytes <= LOCAL_LIMIT * 0.9) break;
            try { fs.unlinkSync(path.join(dir, f.key)); localBytes -= f.size; did.evicted++; } catch { /* in use */ }
          }
        }
        store.localBytes = localBytes;
        const moved = did.copiedCold + did.copiedHot + did.movedCold + did.damaged + did.missing + did.evicted;
        if (moved) log(`[storage] upkeep: ${Object.entries(did).filter(([k, v]) => k !== 'at' && v).map(([k, v]) => `${k} ${v}`).join(', ')}`);
      } catch (e) {
        did.error = e.message;
        log(`[storage] upkeep failed: ${e.message}`);
      } finally {
        store.running = false;
        store.lastRun = did;
      }
      return did;
    },

    // For the developer console
    stats() {
      if (!q) return { tiers: store.tiers };
      const one = (sql) => db.prepare(sql).get();
      return {
        tiers: store.tiers,
        hot: { ...one('SELECT COUNT(*) AS files, COALESCE(SUM(size), 0) AS bytes FROM blob_index WHERE hot = 1'), limit: HOT ? HOT_LIMIT : null },
        cold: COLD ? one('SELECT COUNT(*) AS files, COALESCE(SUM(size), 0) AS bytes FROM blob_index WHERE cold = 1') : null,
        allHot: ALL_HOT,
        // Cold-only files with no cold store configured can't be read: put COLD_S3_* back and set STORAGE_ALL_HOT=1
        stranded: !COLD ? one('SELECT COUNT(*) AS files, COALESCE(SUM(size), 0) AS bytes FROM blob_index WHERE cold = 1 AND hot = 0') : null,
        coldOnly: COLD ? one('SELECT COUNT(*) AS files, COALESCE(SUM(size), 0) AS bytes FROM blob_index WHERE cold = 1 AND hot = 0') : null,
        waitingForCold: COLD ? one('SELECT COUNT(*) AS n FROM blob_index WHERE cold = 0').n + toCold.size : 0,
        problems: db.prepare('SELECT key, kind, problem FROM blob_index WHERE problem IS NOT NULL LIMIT 20').all(),
        local: { bytes: store.localBytes ?? null, limit: LOCAL_LIMIT },
        stores: tiers.map((t) => ({ name: t.name, ...(health.get(t.name) ? { failures: health.get(t.name).n, lastError: health.get(t.name).last, skippedUntil: health.get(t.name).until || null } : { ok: true }) })),
        lastRun: store.lastRun,
      };
    },
    flushReads,
  };
  return store;
}
