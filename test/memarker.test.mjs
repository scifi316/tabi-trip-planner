// TA-20: your own map marker shows your profile photo, or your initials and colour when you have none.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

// ui.js listens for Escape on the document when it loads; that's all it needs here.
globalThis.document ??= { addEventListener() {} };
const { meMarkerKey, meMarkerHtml, meMarkerLabel, meChipAvatar, ME_BLUE } = await import('../public/js/memarker.js');

const kenny = { id: 1, name: 'Kenny P', color: '#E8710A', avatar: '/api/avatars/' + 'a'.repeat(64) + '.jpg' };
const noPhoto = { ...kenny, avatar: null };

test('with a photo: the photo sits on top of your initials, on your colour', () => {
  const html = meMarkerHtml(kenny);
  assert.match(html, /class="me-pulse"/);
  assert.match(html, /<span class="me-bubble" style="background:#E8710A">KP<img src="\/api\/avatars\/a{64}\.jpg"/);
  assert.match(html, /onerror="this\.remove\(\)"/, 'a photo that fails to load falls back to the initials');
});

test('without a photo: just your initials on your colour', () => {
  const html = meMarkerHtml(noPhoto);
  assert.match(html, /<span class="me-bubble" style="background:#E8710A">KP<\/span>/);
  assert.doesNotMatch(html, /<img/);
});

test('before your profile has loaded, the bubble is still drawn, in blue', () => {
  const html = meMarkerHtml(null);
  assert.match(html, new RegExp(`background:${ME_BLUE}"></span>`));
});

test('names and photo addresses are escaped', () => {
  const html = meMarkerHtml({ name: '<b>x', color: '"red', avatar: '/a"onload="alert(1)' });
  assert.doesNotMatch(html, /<b>|onload="alert/);
  assert.match(html, /&lt;B|&lt;b/i);
  assert.match(html, /&quot;red/);
});

test('the marker is rebuilt only when your name, colour or photo changes', () => {
  const k = meMarkerKey(kenny);
  assert.equal(meMarkerKey({ ...kenny, shareLocation: false, isAdmin: true }), k, 'other profile changes leave it alone');
  assert.notEqual(meMarkerKey({ ...kenny, avatar: '/api/avatars/' + 'b'.repeat(64) + '.jpg' }), k, 'a new photo');
  assert.notEqual(meMarkerKey(noPhoto), k, 'removing the photo');
  assert.notEqual(meMarkerKey({ ...kenny, name: 'Ken' }), k);
  assert.notEqual(meMarkerKey({ ...kenny, color: '#000' }), k);
  assert.equal(meMarkerKey(null), '');
});

test('the label says what tapping does, following or not', () => {
  assert.match(meMarkerLabel(false), /Tap to follow/);
  assert.match(meMarkerLabel(true), /Tap to stop following/);
});

test('the follow chip shows your photo, or your initials', () => {
  assert.match(meChipAvatar(kenny), /class="avatar me-ring"[^>]*>KP<img src="\/api\/avatars\//);
  assert.match(meChipAvatar(noPhoto), /class="avatar me-ring"[^>]*>KP<\/span>$/);
  assert.match(meChipAvatar(null), /class="avatar me-ring"/);
});

test('the map uses the photo marker, refreshes it when profiles change, and never draws you as a friend', () => {
  const map = read('public/js/map.js');
  assert.match(map, /from '\.\/memarker\.js'/);
  assert.doesNotMatch(map, /me-dot/, 'the old blue dot is gone');
  assert.match(map, /on\('users', \(\) => \{[^}]*renderMe\(\)/, 'a new or removed photo updates the marker without a reload');
  assert.match(map, /if \(!u \|\| u\.id === state\.me\?\.id\) continue;/, 'you are skipped when drawing friends');
  assert.match(map, /meChipAvatar\(state\.me\)/, 'the follow chip shows your picture');
  assert.match(map, /if \(follow\?\.kind === 'me'\) stopFollow\(\); else startFollow\(\{ kind: 'me' \}\)/, 'tapping toggles follow mode');
});

test('styles and offline shell are in place', () => {
  const css = read('public/app.css');
  assert.match(css, /\.me-bubble \{/);
  assert.match(css, /\.me-bubble img/);
  assert.match(css, /prefers-reduced-motion: reduce\) \{ \.me-pulse \{ animation: none/);
  assert.doesNotMatch(css, /\.me-dot/);
  assert.match(read('public/sw.js'), /'\/js\/memarker\.js'/);
  assert.doesNotMatch(read('public/index.html'), /blue dot/);
});
