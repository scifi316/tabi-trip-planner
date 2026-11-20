// Failover drill against the running dev stack (node dev/stack.mjs, in another terminal):
// the primary dies, the backup takes over, the primary comes back and takes over again. It checks
// that a signed-in person stays signed in throughout, and times each step.
//
//   node dev/failover.mjs            against node dev/stack.mjs
//   node dev/failover.mjs --docker   against the Docker stack (dev/docker-compose.yml)
//
// Production loses up to its snapshot interval of changes when a node dies without warning (15 s;
// 5 s in the dev stack), so the drill waits that long after signing in before pulling the plug.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const DEV = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(DEV, '.data');
const DOCKER = process.argv.includes('--docker');
let stack;
if (DOCKER) {
  const key = /^\s*ACCESS_KEY\s*=\s*(\S+)/m.exec(fs.existsSync(path.join(DEV, '.env')) ? fs.readFileSync(path.join(DEV, '.env'), 'utf8') : '');
  stack = { url: 'http://localhost:8080', accessKey: key?.[1] || null, snapshotMs: 5000, failbackMs: 20000 };
} else {
  try { stack = JSON.parse(fs.readFileSync(path.join(DATA, 'stack.json'), 'utf8')); } catch { console.log('Start the stack first: node dev/stack.mjs'); process.exit(1); }
}
if (stack.single) { console.log('The stack is running with --single: there is no backup to fail over to.'); process.exit(1); }
const B = stack.url;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const serving = async () => { try { return (await (await fetch(`${B}/__edge`)).json()).serving; } catch { return null; } };
// Kill (k) or start (s) the primary: in Docker a hard stop, like pulling the plug
const control = (c) => DOCKER
  ? spawnSync('docker', ['compose', '-f', path.join(DEV, 'docker-compose.yml'), ...(c === 'k' ? ['stop', '-t', '0', 'primary'] : ['start', 'primary'])], { stdio: 'ignore' })
  : fs.writeFileSync(path.join(DATA, 'control'), c);
let fail = 0;
const check = (ok, m) => { console.log(`${ok ? '  ✓' : '  ✗'} ${m}`); if (!ok) fail++; };

let gate = '';
if (stack.accessKey) gate = ((await fetch(`${B}/?key=${stack.accessKey}`, { redirect: 'manual' })).headers.getSetCookie()[0] || '').split(';')[0];
const r = await fetch(`${B}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: B, Cookie: gate }, body: JSON.stringify({ name: 'Sam', password: 'tabitest' }) });
if (r.status !== 200) { console.log('Couldn’t sign in as Sam. Start the stack with --seed (or --fresh --seed) for the demo trip.'); process.exit(1); }
const cookie = [gate, r.headers.getSetCookie().find((c) => c.startsWith('tabi_session')).split(';')[0]].filter(Boolean).join('; ');
const signedIn = async () => { try { return (await (await fetch(`${B}/api/status`, { headers: { Cookie: cookie } })).json()).signedIn === true; } catch { return null; } };

check(await serving() === 'primary', `the primary is serving (${await serving()})`);
console.log(`  waiting ${Math.round((stack.snapshotMs + 1500) / 1000)} s so the sign-in is in a snapshot…`);
await sleep(stack.snapshotMs + 1500);

console.log('Killing the primary (like the droplet going down)');
control('k');
let t0 = Date.now(), gap = 0, who;
while ((who = await serving()) !== 'backup' && Date.now() - t0 < 120e3) { if (!who) gap++; await sleep(500); }
check(who === 'backup', `the backup took over after ${((Date.now() - t0) / 1000).toFixed(0)} s (visitors saw "no server" for about ${Math.round(gap / 2)} s)`);
check(await signedIn(), 'Sam is still signed in');

console.log('Starting the primary again');
control('s');
t0 = Date.now();
while ((who = await serving()) !== 'primary' && Date.now() - t0 < stack.failbackMs + 60e3) await sleep(500);
check(who === 'primary', `the primary took back over after ${((Date.now() - t0) / 1000).toFixed(0)} s (it waits ${stack.failbackMs / 1000} s to be sure it's healthy)`);
check(await signedIn(), 'Sam is still signed in');
console.log(fail ? `${fail} problem(s)` : 'Failover works.');
process.exit(fail ? 1 : 0);
