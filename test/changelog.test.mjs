// TA-17: "Tabi updated" toast with What's new, and the Changelog in Settings.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseVersion, compareVersions, versionOfBuild, sortReleases, releasesSince,
  decideAnnouncement, formatReleaseDate, changelogHtml,
} from '../public/js/changelog.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const CHANGELOG = JSON.parse(read('public/changelog.json'));
const PKG = JSON.parse(read('package.json'));

test('every release has a changelog entry: the current version is listed, newest first, well formed', () => {
  const list = CHANGELOG.releases;
  assert.ok(Array.isArray(list) && list.length, 'changelog.json has releases');
  assert.equal(list[0].version, PKG.version, `package.json is ${PKG.version}: add its entry at the top of public/changelog.json`);
  const seen = new Set();
  for (const [i, r] of list.entries()) {
    assert.ok(parseVersion(r.version), `entry ${i} has a version like 1.8.5`);
    assert.ok(!seen.has(r.version), `${r.version} is listed once`);
    seen.add(r.version);
    assert.match(r.date, /^\d{4}-\d{2}-\d{2}$/, `${r.version} has a YYYY-MM-DD date`);
    assert.ok(formatReleaseDate(r.date), `${r.version} has a real date`);
    assert.ok(Array.isArray(r.changes) && r.changes.length, `${r.version} lists its changes`);
    for (const c of r.changes) assert.ok(typeof c === 'string' && c.trim() && c.length <= 200, `${r.version}: one short sentence per change`);
    if (i) assert.equal(compareVersions(list[i - 1].version, r.version), 1, `${list[i - 1].version} comes before ${r.version}`);
  }
});

test('versions compare as numbers, and anything else is not a version', () => {
  assert.deepEqual(parseVersion('1.8.5'), [1, 8, 5]);
  assert.deepEqual(parseVersion('2.0'), [2, 0, 0]);
  for (const bad of ['', null, undefined, '{{BUILD}}', 'v1.8.5', '1.8.5-abc', 'abc']) assert.equal(parseVersion(bad), null, String(bad));
  assert.equal(compareVersions('1.8.10', '1.8.9'), 1);
  assert.equal(compareVersions('1.9.0', '1.10.0'), -1);
  assert.equal(compareVersions('1.8.5', '1.8.5'), 0);
  assert.equal(compareVersions('1.8.5', null), null);
});

test('the running version comes from the page build stamp', () => {
  assert.equal(versionOfBuild('1.8.5-3fa9c0d1e2'), '1.8.5');
  assert.equal(versionOfBuild('{{BUILD}}'), null, 'an unstamped page (no server) never announces');
  assert.equal(versionOfBuild(''), null);
});

test('announced once per version: newer yes, same no, rollback no but remembered, new devices quiet', () => {
  assert.deepEqual(decideAnnouncement({ running: '1.8.5', lastSeen: '1.8.3' }), { announce: true, remember: '1.8.5', since: '1.8.3' });
  assert.deepEqual(decideAnnouncement({ running: '1.8.5', lastSeen: '1.8.5' }), { announce: false, remember: null, since: null });
  assert.deepEqual(decideAnnouncement({ running: '1.8.3', lastSeen: '1.8.5' }), { announce: false, remember: '1.8.3', since: null });
  // First version that keeps track: someone already using Tabi hears about it, a brand-new sign-in doesn't.
  assert.deepEqual(decideAnnouncement({ running: '1.8.5', lastSeen: null, returning: true }), { announce: true, remember: '1.8.5', since: null });
  assert.deepEqual(decideAnnouncement({ running: '1.8.5', lastSeen: null, returning: false }), { announce: false, remember: '1.8.5', since: null });
  assert.deepEqual(decideAnnouncement({ running: null, lastSeen: '1.8.3' }), { announce: false, remember: null, since: null });
});

const SAMPLE = { releases: [
  { version: '1.8.1', date: '2026-11-20', changes: ['One'] },
  { version: '1.8.5', date: '2026-11-21', changes: ['Five'] },
  { version: '1.8.3', date: '2026-11-20', changes: ['Three', ''] },
  { version: '1.8.2', date: '2026-11-20', changes: ['Two'] },
  { version: 'nope', changes: ['bad'] },
  { version: '1.8.4' }, // no changes: dropped
] };

test('What\'s new lists every release since the last one seen, up to the running one', () => {
  assert.deepEqual(sortReleases(SAMPLE).map((r) => r.version), ['1.8.5', '1.8.3', '1.8.2', '1.8.1']);
  assert.deepEqual(sortReleases(SAMPLE)[1].changes, ['Three'], 'blank changes are dropped');
  assert.deepEqual(releasesSince(SAMPLE, '1.8.1', '1.8.5').map((r) => r.version), ['1.8.5', '1.8.3', '1.8.2']);
  assert.deepEqual(releasesSince(SAMPLE, '1.8.2', '1.8.3').map((r) => r.version), ['1.8.3'], 'never shows a release newer than the app');
  assert.deepEqual(releasesSince(SAMPLE, null, '1.8.5').map((r) => r.version), ['1.8.5'], 'nothing remembered: just this release');
  assert.deepEqual(releasesSince(SAMPLE, '1.8.5', '1.8.6'), [], 'a release missing from the changelog: no list, plain toast');
  assert.deepEqual(sortReleases(null), []);
});

test('Settings: the last 3 releases are open, older ones folded under Earlier updates', () => {
  const html = changelogHtml(SAMPLE, { expanded: 3 });
  const opened = [...html.matchAll(/<details class="release" data-v="([\d.]+)" open>/g)].map((m) => m[1]);
  assert.deepEqual(opened, ['1.8.5', '1.8.3', '1.8.2']);
  const older = html.slice(html.indexOf('data-v="older"'));
  assert.ok(html.includes('data-v="older"') && !/data-v="older" open/.test(html), 'Earlier updates starts folded');
  assert.match(older, /<details class="release" data-v="1\.8\.1">/, '1.8.1 is inside Earlier updates, folded');
  assert.match(html, /Nov 21, 2026/);
  assert.ok(!changelogHtml({ releases: SAMPLE.releases.slice(0, 3) }).includes('older'), 'no Earlier updates with 3 or fewer');
  assert.match(changelogHtml([]), /No updates listed yet/);
  assert.ok(changelogHtml([{ version: '1.0.0', date: '2026-01-01', changes: ['<img src=x onerror=alert(1)>'] }]).includes('&lt;img'), 'text is escaped');
});

test('a release can carry a tag like "Pre 1.9", shown beside its version and escaped', () => {
  const html = changelogHtml([{ version: '1.8.11', date: '2026-11-23', tag: 'Pre 1.9', changes: ['x'] }, { version: '1.8.10', date: '2026-11-20', changes: ['y'] }]);
  assert.match(html, /<span class="label">Tabi 1\.8\.11 <span class="release-tag">Pre 1\.9<\/span><\/span>/);
  assert.match(html, /<span class="label">Tabi 1\.8\.10<\/span>/, 'no tag, no badge');
  assert.ok(changelogHtml([{ version: '1.0.0', date: '2026-01-01', tag: '<b>', changes: ['x'] }]).includes('&lt;b&gt;'), 'tag is escaped');
  for (const r of CHANGELOG.releases) if ('tag' in r) assert.ok(typeof r.tag === 'string' && r.tag.trim() && r.tag.length <= 20, `${r.version}: a short tag`);
});

test('release dates read the same in every time zone', () => {
  assert.equal(formatReleaseDate('2026-11-20'), 'Nov 20, 2026');
  assert.equal(formatReleaseDate('2026-13-40'), '');
  assert.equal(formatReleaseDate(undefined), '');
});

// A stand-in for the page: storage, the changelog fetch and the toast area.
function fakePage({ seen = null, hadState = true, changelog = SAMPLE } = {}) {
  const store = new Map(Object.entries({ ...(seen ? { 'tabi.seenVersion': seen } : {}), ...(hadState ? { 'tabi.state': '{}' } : {}) }));
  const toasts = [];
  const el = () => {
    const e = { className: '', innerHTML: '', children: [], button: { onclick: null }, querySelector: () => e.button, remove() { e.removed = true; }, appendChild(c) { e.children.push(c); } };
    return e;
  };
  const root = el();
  globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
  globalThis.document = { addEventListener() {}, getElementById: (id) => (id === 'toast-root' ? root : null), createElement: el };
  globalThis.fetch = async (url) => { assert.equal(url, '/changelog.json'); return { ok: true, json: async () => changelog }; };
  root.appendChild = (c) => { root.children.push(c); toasts.push(c); };
  return { store, toasts };
}

test('the toast says the version, links What\'s new, and comes once per version', async () => {
  const page = fakePage({ seen: '1.8.3' });
  const { announceUpdate } = await import(`../public/js/whatsnew.js?case=once`);
  assert.equal(await announceUpdate('1.8.5-abcdef'), true);
  assert.equal(page.toasts.length, 1);
  assert.match(page.toasts[0].innerHTML, /Tabi updated to 1\.8\.5/);
  assert.match(page.toasts[0].innerHTML, /<button>What’s new<\/button>/);
  assert.equal(page.store.get('tabi.seenVersion'), '1.8.5');
  assert.equal(await announceUpdate('1.8.5-abcdef'), false, 'not again for the same version');
  assert.equal(page.toasts.length, 1);
});

test('a brand-new device stays quiet, and the next update is announced', async () => {
  const page = fakePage({ hadState: false });
  const { announceUpdate } = await import(`../public/js/whatsnew.js?case=new`);
  assert.equal(await announceUpdate('1.8.3-aaaa'), false);
  assert.equal(page.store.get('tabi.seenVersion'), '1.8.3');
  assert.equal(await announceUpdate('1.8.5-bbbb'), true);
  assert.equal(page.toasts.length, 1);
});

test('a version missing from the changelog still gets a plain toast, with no What\'s new link', async () => {
  const page = fakePage({ seen: '1.8.5' });
  const { announceUpdate } = await import(`../public/js/whatsnew.js?case=missing`);
  assert.equal(await announceUpdate('1.8.6-cccc'), true);
  assert.match(page.toasts[0].innerHTML, /Tabi updated to 1\.8\.6/);
  assert.doesNotMatch(page.toasts[0].innerHTML, /What’s new/);
});

test('a waiting update is offered once, with Reload', async () => {
  const page = fakePage();
  const { offerUpdate } = await import(`../public/js/whatsnew.js?case=offer`);
  let reloaded = 0;
  offerUpdate('1.8.6-dddd', () => reloaded++);
  offerUpdate('1.8.6-dddd', () => reloaded++);
  assert.equal(page.toasts.length, 1);
  assert.match(page.toasts[0].innerHTML, /Tabi 1\.8\.6 is ready/);
  page.toasts[0].button.onclick();
  assert.equal(reloaded, 1);
});

test('the changelog and its scripts are in the offline copy, and Settings and the app use them', () => {
  const sw = read('public/sw.js');
  for (const f of ['/changelog.json', '/js/changelog.js', '/js/whatsnew.js']) assert.ok(sw.includes(`'${f}'`), `${f} is in sw.js SHELL`);
  assert.match(read('public/js/settings.js'), /data-section="changelog"[\s\S]*fillChangelog/);
  assert.match(read('public/js/main.js'), /announceWhenSettled\(\);/);
  assert.match(read('public/js/main.js'), /offerUpdate\(target, reloadNow\)/);
});
