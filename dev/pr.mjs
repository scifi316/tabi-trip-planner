// Run a pull request (or any branch) on the dev stack, without touching your own checkout.
//
//   node dev/pr.mjs 15              pull request #15, on your existing dev data
//   node dev/pr.mjs 15 --fresh      ... starting from nothing (add --seed for the demo trip)
//   node dev/pr.mjs main            what's on main now (or any branch name)
//   node dev/pr.mjs --restore       put back the dev data from before the last pull request
//   node dev/pr.mjs 15 --docker     the same, in Docker with the production image (dev/docker-compose.yml)
//
// The code goes in dev/.pr/<name> (a git worktree). Running a pull request on the data you already
// have also tests the upgrade, which is what production goes through: the data is copied to
// dev/.data-before-pr first, so --restore can undo whatever the pull request did to it.
// Other options (--seed, --single, --phone, --prod-timings) are passed on to dev/stack.mjs.
import { spawnSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEV = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.dirname(DEV);
const DATA = path.join(DEV, '.data');
const BACKUP = path.join(DEV, '.data-before-pr');
const args = process.argv.slice(2);
const target = args.find((a) => !a.startsWith('--'));
const flags = args.filter((a) => a.startsWith('--') && !['--restore', '--docker'].includes(a));
const git = (...a) => { const r = spawnSync('git', a, { cwd: REPO, encoding: 'utf8' }); if (r.status !== 0) throw new Error((r.stderr || r.stdout).trim()); return r.stdout.trim(); };

// The dev stack must not be running: its data is about to be copied, and the ports reused
function stackRunning() {
  try { const { pid } = JSON.parse(fs.readFileSync(path.join(DATA, 'stack.json'), 'utf8')); process.kill(pid, 0); return true; } catch { return false; }
}
if (stackRunning()) { console.log('The dev stack is running: stop it first (type q in its window, or Ctrl+C).'); process.exit(1); }

if (args.includes('--restore')) {
  if (!fs.existsSync(BACKUP)) { console.log('There’s no saved dev data to put back.'); process.exit(1); }
  fs.rmSync(DATA, { recursive: true, force: true });
  fs.cpSync(BACKUP, DATA, { recursive: true });
  console.log(`Put back the dev data saved ${fs.readFileSync(path.join(BACKUP, 'saved-at.txt'), 'utf8').trim()}.`);
  process.exit(0);
}
if (!target) { console.log('Which pull request? For example: node dev/pr.mjs 15   (or a branch name: node dev/pr.mjs main)'); process.exit(1); }

// Fetch it. A number is a pull request; anything else is a branch on GitHub.
const isPr = /^\d+$/.test(target);
const ref = `refs/tabi-dev/${isPr ? `pr-${target}` : target.replace(/[^\w.-]/g, '_')}`;
try { git('fetch', '--force', 'origin', `${isPr ? `pull/${target}/head` : target}:${ref}`); }
catch (e) { console.log(`Couldn’t fetch ${isPr ? `pull request #${target}` : `branch ${target}`} from GitHub:\n${e.message}`); process.exit(1); }
const name = isPr ? target : target.replace(/[^\w.-]/g, '_');
const WT = path.join(DEV, '.pr', name);
if (fs.existsSync(path.join(WT, '.git'))) git('-C', WT, 'checkout', '--quiet', '--force', '--detach', ref);
else { fs.mkdirSync(path.dirname(WT), { recursive: true }); git('worktree', 'add', '--force', '--detach', WT, ref); }
console.log(`${isPr ? `Pull request #${target}` : target}: ${git('log', '-1', '--format=%h %s', ref)}`);

// Its own packages only when they differ from yours (otherwise it uses the repository's node_modules)
const lock = (dir) => { try { return fs.readFileSync(path.join(dir, 'package-lock.json'), 'utf8'); } catch { return ''; } };
if (lock(WT) !== lock(REPO) && !fs.existsSync(path.join(WT, 'node_modules'))) {
  console.log('It changes the packages: installing them for it…');
  const r = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['ci', '--omit=dev'], { cwd: WT, stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.status !== 0) process.exit(1);
}

// Save the dev data first, unless starting fresh
if (!flags.includes('--fresh') && !args.includes('--docker') && fs.existsSync(DATA)) {
  fs.rmSync(BACKUP, { recursive: true, force: true });
  fs.cpSync(DATA, BACKUP, { recursive: true, filter: (src) => !/[\\/](control|stack\.json)$/.test(src) });
  fs.writeFileSync(path.join(BACKUP, 'saved-at.txt'), `${new Date().toLocaleString()} (before ${isPr ? `#${target}` : target})`);
  console.log('Saved your dev data first: node dev/pr.mjs --restore puts it back.');
}

const COMPOSE = ['compose', '-f', path.join(DEV, 'docker-compose.yml')];
if (args.includes('--docker') && flags.includes('--fresh')) spawnSync('docker', [...COMPOSE, 'down', '-v'], { stdio: 'inherit' });
const child = args.includes('--docker')
  ? spawn('docker', [...COMPOSE, 'up', '--build'], { stdio: 'inherit', env: { ...process.env, TABI_SRC: path.relative(DEV, WT) } })
  : spawn(process.execPath, [path.join(DEV, 'stack.mjs'), '--src', WT, ...flags], { stdio: 'inherit' });
child.on('exit', (code) => process.exit(code ?? 0));
for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => child.kill(s));
