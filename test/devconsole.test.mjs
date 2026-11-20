// Developer console: keys never show up in its logs, and reset links stay off unless turned on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const KLIPY = 'klipy-test-key/with+odd=chars';
const DEV = 'dev-console-test-key';
process.env.KLIPY_API_KEY = KLIPY;
process.env.DEV_KEY = DEV;

const { installDevCapture, devRecent, redact } = await import('../server/devlog.js');
const { openDb } = await import('../server/db.js');
const { createBlobStore } = await import('../server/blobs.js');
const { createApp } = await import('../server/app.js');
installDevCapture();

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('settings that hold keys are blanked out, as typed and URL-encoded', () => {
  assert.equal(redact(`https://api.example/v1/${KLIPY}/x`), 'https://api.example/v1/…/x');
  assert.equal(redact(`/api/v1/${encodeURIComponent(KLIPY)}/gifs`), '/api/v1/…/gifs');
  assert.equal(redact('nothing secret here'), 'nothing secret here');
});

test('outbound calls and the server log never show a key', async () => {
  const srv = http.createServer((req, res) => res.end('ok'));
  await new Promise((r) => srv.listen(0, r));
  try {
    await (await fetch(`http://127.0.0.1:${srv.address().port}/api/v1/${encodeURIComponent(KLIPY)}/gifs/search?q=cat`)).text();
    console.log('using key', KLIPY);
  } finally { srv.close(); }
  const net = devRecent('net').at(-1);
  assert.ok(net.path.startsWith('/api/v1/…/gifs/search'), net.path);
  assert.ok(!JSON.stringify(devRecent('net')).includes(encodeURIComponent(KLIPY)));
  assert.ok(!JSON.stringify(devRecent('log')).includes(KLIPY));
});

async function startApp(extraEnv) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tabi-dev-test-'));
  const db = openDb(dir);
  const app = createApp({ db, blobs: createBlobStore(dir, null), root: ROOT, dataDir: dir, env: { ...process.env, ...extraEnv } });
  await new Promise((r) => app.server.listen(0, r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const stop = async () => { await app.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); };
  return { base, stop };
}

async function resetLinkStatus(base) {
  const setup = await fetch(`${base}/api/setup`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tripName: 'T', name: 'Admin', password: 'secret123' }) });
  assert.equal(setup.status, 200);
  const login = await fetch(`${base}/dev?devkey=${encodeURIComponent(DEV)}`, { redirect: 'manual' });
  assert.equal(login.status, 302);
  const cookie = login.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  const people = await (await fetch(`${base}/api/dev/people`, { headers: { cookie } })).json();
  const r = await fetch(`${base}/api/dev/reset-link`, { method: 'POST', headers: { cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ userId: people.people[0].id }) });
  return { status: r.status, body: await r.json(), flag: people.resetLinks };
}

test('reset links from the console are off by default', async () => {
  const { base, stop } = await startApp({ DEV_RESET_LINKS: '' });
  try {
    const r = await resetLinkStatus(base);
    assert.equal(r.flag, false);
    assert.equal(r.status, 403);
    assert.match(r.body.error, /DEV_RESET_LINKS/);
  } finally { await stop(); }
});

test('reset links work when DEV_RESET_LINKS=on', async () => {
  const { base, stop } = await startApp({ DEV_RESET_LINKS: 'on' });
  try {
    const r = await resetLinkStatus(base);
    assert.equal(r.flag, true);
    assert.equal(r.status, 200);
    assert.ok(r.body.token);
  } finally { await stop(); }
});
