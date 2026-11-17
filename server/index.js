// Tabi server entry point.
//
// Single host:   node server/index.js
// HA pair:       HA_MODE=on with S3_* settings on two machines. Only the lease holder opens the
//                database and runs the Cloudflare Tunnel connector, so the tunnel always points
//                at exactly one live copy of the app.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.js';
import { createApp } from './app.js';
import { createBlobStore } from './blobs.js';
import { s3FromEnv } from './s3.js';
import { createHA, startBackups } from './ha.js';
import { installDevCapture } from './devlog.js';

installDevCapture(); // keeps recent logs and outbound calls in memory for the developer console

const env = process.env;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = +(env.PORT || 8080);
const DATA_DIR = path.resolve(env.DATA_DIR || path.join(ROOT, 'data'));
const NODE = env.HA_NODE || os.hostname();
const PRIORITY = env.HA_PRIORITY === 'backup' ? 'backup' : 'primary';
const HA_ON = /^(1|true|on|yes)$/i.test(env.HA_MODE || '');
const log = (...a) => console.log(new Date().toISOString(), ...a);
const VERSION = (() => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version; } catch { return '?'; } })();

// Each server notes its version in storage every couple of minutes, so the developer console (and
// the log) can say when the backup is still running older code. A backup that takes over while out
// of date serves the old app to whoever opens it then, which looks like "the update didn't arrive".
let servers = {};
let heartbeatRole = 'starting';
let warnedAbout = '';
async function heartbeat() {
  if (!s3) return;
  try {
    for (let i = 0; i < 2; i++) {
      const r = await s3.get('nodes.json', { timeout: 5000 });
      const cur = (() => { try { return r ? JSON.parse(r.body) : {}; } catch { return {}; } })();
      cur[NODE] = { version: VERSION, priority: PRIORITY, role: heartbeatRole, at: Date.now() };
      const w = await s3.put('nodes.json', JSON.stringify(cur), { contentType: 'application/json', timeout: 5000, ...(r ? { ifMatch: r.etag } : { ifNoneMatch: true }) });
      if (w.ok) { servers = cur; break; }
    }
    const behind = Object.entries(servers).filter(([n, s]) => n !== NODE && Date.now() - s.at < 15 * 60e3 && s.version !== VERSION);
    const key = behind.map(([n, s]) => n + s.version).join();
    if (key && key !== warnedAbout) log(`[ha] version mismatch: ${behind.map(([n, s]) => `${n} runs ${s.version}`).join(', ')}; this server (${NODE}) runs ${VERSION}. Run deploy/update.sh on every server.`);
    warnedAbout = key;
  } catch { /* storage unreachable: the lease code reports that */ }
}

let s3;
try { s3 = s3FromEnv(env); } catch (e) { console.error(`Storage settings problem: ${e.message}`); process.exit(1); }
if (HA_ON && !s3) {
  console.error('HA_MODE is on but S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY are not all set.');
  process.exit(1);
}

let ha = null;
let app = null;
let db = null;
let tunnel = null;
let shuttingDown = false;

// While waiting to become leader, answer health checks only.
function standbyServer() {
  const srv = http.createServer((req, res) => {
    if (req.url.startsWith('/healthz')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, ...(ha?.status() || {}) }));
    }
    res.writeHead(503, { 'Content-Type': 'text/plain', 'Retry-After': '10' });
    res.end('Standing by');
  });
  srv.listen(PORT);
  return srv;
}

// Cloudflare Tunnel connector, run only by the node that is serving.
function startTunnel() {
  if (!env.TUNNEL_TOKEN) return;
  const bin = env.CLOUDFLARED_BIN || 'cloudflared';
  log(`[tunnel] starting ${bin}`);
  tunnel = spawn(bin, ['tunnel', '--no-autoupdate', 'run'], { env: { ...env, TUNNEL_TOKEN: env.TUNNEL_TOKEN }, stdio: ['ignore', 'inherit', 'inherit'] });
  tunnel.on('exit', (code) => {
    tunnel = null;
    if (!shuttingDown) { log(`[tunnel] exited (${code}); restarting in 5s`); setTimeout(startTunnel, 5000); }
  });
  tunnel.on('error', (e) => log(`[tunnel] could not start: ${e.message}`));
}
function stopTunnel() { if (tunnel) { tunnel.removeAllListeners('exit'); tunnel.kill('SIGTERM'); tunnel = null; } }

async function shutdown(code, why) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`shutting down: ${why}`);
  stopTunnel();
  try { await app?.close(); } catch { /* ignore */ }
  if (ha && db) await ha.shutdown(db);
  try { db?.close(); } catch { /* ignore */ }
  process.exit(code);
}
process.on('SIGTERM', () => shutdown(0, 'SIGTERM'));
process.on('SIGINT', () => shutdown(0, 'SIGINT'));

async function main() {
  if (s3) { heartbeatRole = HA_ON ? 'standby' : 'single'; heartbeat(); setInterval(heartbeat, 120e3).unref(); }
  if (HA_ON) {
    ha = createHA({ s3, dataDir: DATA_DIR, node: NODE, priority: PRIORITY, env, log });
    log(`[ha] ${NODE} (${PRIORITY}) waiting for the lease`);
    const standby = standbyServer();
    await ha.acquire();
    await ha.prepareData();
    await new Promise((r) => standby.close(r));
  }

  db = openDb(DATA_DIR);
  const blobs = createBlobStore(DATA_DIR, s3);
  if (HA_ON) { heartbeatRole = 'leader'; heartbeat(); }
  app = createApp({ db, blobs, root: ROOT, dataDir: DATA_DIR, env, getHealth: () => ({ ...(ha ? ha.status() : { role: 'single', node: NODE }), version: VERSION, servers }) });
  await new Promise((r) => app.server.listen(PORT, r));
  log(`Tabi is running on http://localhost:${PORT} (data: ${DATA_DIR}${HA_ON ? `, ${NODE} is leader` : ''})`);
  if (app.userCount() === 0) log('No trip yet: open the app in a browser to create it.');
  if (env.ACCESS_KEY) log('Private link gate is on: share https://<your-domain>/?key=<ACCESS_KEY>');

  if (HA_ON) {
    // Losing the lease means another node may be serving: stop immediately and restart as standby.
    ha.runLeader(db, { onStepDown: (why) => { stopTunnel(); shutdown(75, `lost leadership (${why})`); } });
  } else if (s3) {
    startBackups({ s3, dataDir: DATA_DIR, node: NODE, db, env, log });
    log('[backup] snapshots to S3 enabled');
  }
  startTunnel();
}

main().catch((e) => { console.error(e); process.exit(1); });
