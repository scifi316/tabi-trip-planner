// TA-15: on a phone the page keeps a fixed scale like an app, while the map keeps its own pinch-zoom.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { lockZoom, resetZoom, unlockedViewport } from '../public/js/zoomlock.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

const viewportOf = (html) => {
  const m = html.match(/<meta name="viewport" content="([^"]*)">/);
  assert.ok(m, 'index.html has a viewport tag');
  return Object.fromEntries(m[1].split(',').map((s) => s.trim().split('=').map((x) => x.trim())));
};

// A stand-in for the browser: records listeners and lets a test fire Safari's gesture events.
function fakeWindow({ coarse = true, scale = 1, content = '' } = {}) {
  const listeners = {}, timers = [];
  const meta = { content };
  const document = {
    addEventListener: (type, fn, opts) => { (listeners[type] ||= []).push({ fn, opts }); },
    querySelector: (sel) => (sel === 'meta[name=viewport]' ? meta : null),
  };
  const fire = (type) => {
    const e = { type, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
    for (const l of listeners[type] || []) l.fn(e);
    return e;
  };
  return {
    document, meta, listeners, timers, fire,
    matchMedia: (q) => ({ matches: q === '(pointer: coarse)' && coarse }),
    visualViewport: { scale },
    setTimeout: (fn, ms) => timers.push({ fn, ms }),
  };
}

test('the page is locked to a fixed scale, keeping the existing viewport settings', () => {
  const v = viewportOf(read('public/index.html'));
  assert.equal(v['maximum-scale'], '1');
  assert.equal(v['user-scalable'], 'no');
  assert.equal(v['initial-scale'], '1');
  assert.equal(v.width, 'device-width');
  assert.equal(v['viewport-fit'], 'cover', 'notch padding still works');
  assert.equal(v['interactive-widget'], 'resizes-content', 'the keyboard still resizes the app');
  assert.equal(v['minimum-scale'], undefined);
});

test('the page only allows scrolling gestures, and the map keeps its own touch handling', () => {
  const css = read('public/app.css');
  assert.match(css, /html, body \{ touch-action: pan-x pan-y; \}/);
  // Only the page is locked: nothing in app.css overrides MapLibre's touch-action on the map canvas.
  assert.doesNotMatch(css, /\.maplibregl-canvas[^{]*\{[^}]*touch-action/);
});

test("Safari's pinch gestures are cancelled on touch devices", () => {
  const w = fakeWindow({ coarse: true });
  assert.equal(lockZoom(w), true);
  for (const type of ['gesturestart', 'gesturechange', 'gestureend']) {
    assert.equal(w.fire(type).defaultPrevented, true, `${type} is cancelled`);
    assert.equal(w.listeners[type][0].opts.passive, false, `${type} listener can cancel`);
  }
});

test('desktop trackpads are left alone', () => {
  const w = fakeWindow({ coarse: false });
  assert.equal(lockZoom(w), false);
  assert.deepEqual(w.listeners, {});
  assert.equal(w.fire('gesturestart').defaultPrevented, false);
});

test('unlockedViewport drops only the zoom limits', () => {
  assert.equal(
    unlockedViewport('width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover'),
    'width=device-width, initial-scale=1, viewport-fit=cover',
  );
  assert.equal(unlockedViewport('width=device-width,initial-scale=1'), 'width=device-width, initial-scale=1');
});

test('a page left zoomed after turning the phone is put back to 100% with the lock restored', () => {
  const locked = 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover';
  const w = fakeWindow({ scale: 1.6, content: locked });
  assert.equal(resetZoom(w), true);
  assert.equal(w.meta.content, 'width=device-width, initial-scale=1, viewport-fit=cover');
  assert.equal(w.timers.length, 1);
  w.timers[0].fn();
  assert.equal(w.meta.content, locked, 'the lock comes back');
});

test('a page at 100% is not touched', () => {
  const w = fakeWindow({ scale: 1, content: 'width=device-width, maximum-scale=1' });
  assert.equal(resetZoom(w), false);
  assert.equal(w.meta.content, 'width=device-width, maximum-scale=1');
  assert.equal(w.timers.length, 0);
});

test('the zoom lock is part of the offline app and loads at start', () => {
  assert.match(read('public/sw.js'), /'\/js\/zoomlock\.js'/);
  const main = read('public/js/main.js');
  assert.match(main, /import \{ lockZoom, resetZoom \} from '\.\/zoomlock\.js';/);
  assert.match(main, /^lockZoom\(\);/m);
});
