// The dev stack: production's layout on one computer, without Docker.
//
//   browser ─▶ edge (stand-in for Cloudflare, :8080) ─▶ whichever node is leader
//                                                        ├─ primary (:8101)   ┐ same server code as
//                                                        └─ backup  (:8102)   ┘ production, HA on
//                                         both share ─▶ s3 (stand-in for R2, :9000): lease, snapshots, photos
//                                                    └▶ cold (stand-in for Backblaze B2, :9002): older files, long-term snapshots
//
// Like production, a node that loses the lease exits and is started again as standby (Docker's
// "restart: always"), the primary takes back over from the backup, and data lives in "R2".
//
//   node dev/stack.mjs              start (keeps the data from last time)
//   node dev/stack.mjs --fresh      start from nothing
//   node dev/stack.mjs --seed       add a demo trip once it's up (see dev/seed.mjs)
//   node dev/stack.mjs --single     one node, no failover (the simple hosting setup)
//   node dev/stack.mjs --no-cold    no cold store (R2 only, like before tiered storage)
//   node dev/stack.mjs --src DIR    run the code in DIR (a pull request's checkout, see dev/pr.mjs)
//   node dev/stack.mjs --prod-timings   production's lease timings (failover takes ~45 s instead of ~10 s)
//   node dev/stack.mjs --phone      also open a temporary public https address for phones (needs cloudflared)
//
// Settings come from dev/.env if it exists (ACCESS_KEY, KLIPY_API_KEY, ...; see dev/.env.example).
// While it runs: type "k" + Enter to kill the primary (failover), "s" to start it again,
// "d"/"u" to take R2 down/up, "q" to quit.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline';

const DEV = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.dirname(DEV);
const has = (f) => process.argv.includes(`--${f}`);
const arg = (name, def) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : def; };
const SRC = path.resolve(arg('src', REPO));
const DATA = path.resolve(arg('data', process.env.TABI_DEV_DATA || path.join(DEV, '.data')));
const EDGE_PORT = +arg('port', 8080);
const S3_PORT = +arg('s3-port', 9000);
const COLD_PORT = +arg('cold-port', 9002);
const COLD = !has('no-cold');
const SINGLE = has('single');

// dev/.env: KEY=value lines, like production's .env
const fileEnv = {};
for (const f of [path.join(DEV, '.env')]) {
  if (!fs.existsSync(f)) continue;
  for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !line.trim().startsWith('#')) fileEnv[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

if (has('fresh')) { fs.rmSync(DATA, { recursive: true, force: true }); console.log(`[stack] started fresh (removed ${path.relative(process.cwd(), DATA)})`); }
fs.mkdirSync(DATA, { recursive: true });
if (!fs.existsSync(path.join(SRC, 'server/index.js'))) { console.error(`[stack] ${SRC} doesn't look like Tabi (no server/index.js)`); process.exit(1); }
if (!fs.existsSync(path.join(SRC, 'node_modules')) && !fs.existsSync(path.join(REPO, 'node_modules'))) { console.error('[stack] run "npm install" first'); process.exit(1); }

const COLORS = { s3: 90, cold: 34, primary: 36, backup: 35, edge: 33, tunnel: 32, seed: 32, stack: 1 };
const say = (who, line) => process.stdout.write(`\x1b[${COLORS[who] || 0}m${who.padEnd(7)}\x1b[0m ${line}\n`);

// Faster than production so a failover drill takes seconds, not a minute; --prod-timings for the real ones
const timings = has('prod-timings') ? {} : {
  HA_LEASE_TTL_MS: '8000', HA_RENEW_MS: '2000', HA_GRACE_MS: '3000', HA_BACKUP_EXTRA_MS: '3000', HA_FAILBACK_MS: '20000', HA_SNAPSHOT_MS: '5000',
};
// Storage upkeep runs sooner and more often than production's (1 min, then every 10) so you can watch it
const storage = { STORAGE_UPKEEP_FIRST_MS: '10000', STORAGE_UPKEEP_MS: '60000' };
const coldEnv = COLD ? { COLD_S3_ENDPOINT: `http://localhost:${COLD_PORT}`, COLD_S3_BUCKET: 'tabi-dev-cold', COLD_S3_ACCESS_KEY_ID: 'dev', COLD_S3_SECRET_ACCESS_KEY: 'dev' } : {};
const nodeEnv = (name, port, priority) => ({
  ...process.env, ...storage, ...fileEnv, ...coldEnv,
  PORT: String(port), DATA_DIR: path.join(DATA, name), TRUST_PROXY: 'true',
  HA_MODE: SINGLE ? 'off' : 'on', HA_NODE: name, HA_PRIORITY: priority,
  S3_ENDPOINT: `http://localhost:${S3_PORT}`, S3_BUCKET: 'tabi-dev', S3_ACCESS_KEY_ID: 'dev', S3_SECRET_ACCESS_KEY: 'dev',
  ...(SINGLE ? {} : timings),
  TUNNEL_TOKEN: '', // the edge stands in for the tunnel; set TUNNEL_TOKEN in dev/.env only for a real dev tunnel
  ...(fileEnv.TUNNEL_TOKEN ? { TUNNEL_TOKEN: fileEnv.TUNNEL_TOKEN } : {}),
});

const procs = {};
const held = new Set(); // nodes we stopped on purpose: not restarted until asked
let quitting = false;
function run(name, args, env, { cwd = SRC, restart = false } = {}) {
  const p = spawn(process.execPath, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  procs[name] = p;
  const out = (d) => String(d).split(/\r?\n/).filter(Boolean).forEach((l) => say(name, l));
  p.stdout.on('data', out); p.stderr.on('data', out);
  p.on('exit', (code, sig) => {
    if (procs[name] === p) delete procs[name];
    if (quitting) return;
    if (restart && !held.has(name)) {
      say(name, `exited (${sig || code}); starting it again, as Docker's restart: always does`);
      setTimeout(() => !quitting && !held.has(name) && restart(), 1000);
    } else if (!held.has(name)) say(name, `exited (${sig || code})`);
  });
  return p;
}
const NODE_ARGS = ['--disable-warning=ExperimentalWarning', 'server/index.js'];
const startPrimary = () => run('primary', NODE_ARGS, nodeEnv('primary', 8101, 'primary'), { restart: startPrimary });
const startBackup = () => run('backup', NODE_ARGS, nodeEnv('backup', 8102, 'backup'), { restart: startBackup });

run('s3', [path.join(DEV, 's3.mjs'), '--port', String(S3_PORT), '--dir', path.join(DATA, 's3')], process.env, { cwd: REPO });
if (COLD) run('cold', [path.join(DEV, 's3.mjs'), '--port', String(COLD_PORT), '--dir', path.join(DATA, 's3-cold')], process.env, { cwd: REPO });
await new Promise((r) => setTimeout(r, 400));
startPrimary();
if (!SINGLE) setTimeout(startBackup, 1500); // like production: the backup starts as standby
run('edge', [path.join(DEV, 'edge.mjs'), '--port', String(EDGE_PORT), '--nodes', SINGLE ? 'primary=http://localhost:8101' : 'primary=http://localhost:8101,backup=http://localhost:8102'], process.env, { cwd: REPO });

const URL0 = `http://localhost:${EDGE_PORT}`;
const KEY = fileEnv.ACCESS_KEY;
async function waitForLeader() {
  for (let i = 0; i < 90; i++) {
    try { const j = await (await fetch(`${URL0}/__edge`)).json(); if (j.serving) return j.serving; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return null;
}
const serving = await waitForLeader();
say('stack', serving ? `\x1b[1mTabi dev is up: ${URL0}${KEY ? `/?key=${KEY}` : ''}\x1b[0m (served by ${serving})` : 'no node took the lead after 90 s: see the messages above');
say('stack', `which node is serving: ${URL0}/__edge   ·   what's in "R2": http://localhost:${S3_PORT}/__list${COLD ? `   ·   in "B2": http://localhost:${COLD_PORT}/__list` : ''}`);
if (!SINGLE) say('stack', 'type k + Enter to kill the primary (failover drill), s to start it again, d/u to take R2 down/up, cd/cu for the cold store, q to quit');

if (has('seed') && serving) {
  run('seed', [path.join(DEV, 'seed.mjs'), URL0], { ...process.env, ...fileEnv }, { cwd: REPO });
}

// --phone: a temporary public https address through Cloudflare (no account needed), so phones get
// a secure page: service worker, location and lock-screen notifications need https off localhost
if (has('phone')) {
  const bin = fileEnv.CLOUDFLARED_BIN || 'cloudflared';
  const t = spawn(bin, ['tunnel', '--no-autoupdate', '--url', URL0], { stdio: ['ignore', 'pipe', 'pipe'] });
  procs.tunnel = t;
  t.on('error', () => say('tunnel', 'cloudflared isn’t installed: see docs/DEVELOPMENT.md, "Testing on a phone"'));
  const look = (d) => { const m = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(String(d)); if (m) say('tunnel', `\x1b[1mfor phones: ${m[0]}${KEY ? `/?key=${KEY}` : ''}\x1b[0m (changes each time)`); };
  t.stdout.on('data', look); t.stderr.on('data', look);
}

const stopAll = () => {
  if (quitting) return;
  quitting = true;
  say('stack', 'stopping');
  for (const p of Object.values(procs)) p.kill('SIGTERM');
  setTimeout(() => process.exit(0), 2500).unref();
};
process.on('SIGINT', stopAll);
process.on('SIGTERM', stopAll);

// Drill controls on the terminal (also used by dev/failover.mjs through a control file)
const control = async (c) => {
  if (c === 'k' && procs.primary) { held.add('primary'); procs.primary.kill('SIGKILL'); say('stack', 'killed the primary (like the droplet going down); s to start it again'); }
  else if (c === 's') { held.delete('primary'); if (!procs.primary) { startPrimary(); say('stack', 'started the primary: it takes back over after the failback delay'); } }
  else if (c === 'd') await fetch(`http://localhost:${S3_PORT}/__down`).catch(() => {});
  else if (c === 'u') await fetch(`http://localhost:${S3_PORT}/__up`).catch(() => {});
  else if (c === 'cd') await fetch(`http://localhost:${COLD_PORT}/__down`).catch(() => {});
  else if (c === 'cu') await fetch(`http://localhost:${COLD_PORT}/__up`).catch(() => {});
  else if (c === 'q') stopAll();
};
if (process.stdin.isTTY) readline.createInterface({ input: process.stdin }).on('line', (l) => control(l.trim().toLowerCase()));
const CONTROL = path.join(DATA, 'control');
fs.rmSync(CONTROL, { force: true });
setInterval(() => {
  try { const c = fs.readFileSync(CONTROL, 'utf8').trim(); fs.rmSync(CONTROL, { force: true }); if (c) control(c); } catch { /* none */ }
}, 300).unref?.();
fs.writeFileSync(path.join(DATA, 'stack.json'), JSON.stringify({ pid: process.pid, url: URL0, src: SRC, single: SINGLE, accessKey: KEY || null,
  snapshotMs: +(timings.HA_SNAPSHOT_MS || 15000), failbackMs: +(timings.HA_FAILBACK_MS || 120000), startedAt: new Date().toISOString() }));
