// TA-15: the page no longer zooms on a phone, so the full-screen photo viewer zooms the photo itself.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { photoZoom, clampView, zoomAround, MAX_ZOOM } from '../public/js/photozoom.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

// A 400 x 800 stage at the top-left of the screen, holding the blurred thumbnail and the photo.
function fakeStage() {
  const listeners = {};
  const imgs = [{ style: {} }, { style: {} }];
  const classes = new Set();
  const stage = {
    addEventListener: (type, fn) => { listeners[type] = fn; },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 400, height: 800 }),
    querySelectorAll: () => imgs,
    setPointerCapture() {},
    classList: { toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)) },
  };
  let clock = 1000;
  const ev = (type, id, x, y, extra = {}) => {
    const e = { type, pointerId: id, clientX: x, clientY: y, timeStamp: clock, target: { closest: () => null }, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...extra };
    listeners[type](e);
    return e;
  };
  return {
    stage, imgs, classes,
    wait: (ms) => { clock += ms; },
    tap: (x, y) => { ev('pointerdown', 1, x, y); ev('pointerup', 1, x, y); },
    drag: (x0, y0, x1, y1) => { ev('pointerdown', 1, x0, y0); ev('pointermove', 1, x1, y1); ev('pointerup', 1, x1, y1); },
    pinch: (from, to) => { // two fingers either side of the stage's centre, from `from` px apart to `to`
      ev('pointerdown', 1, 200 - from / 2, 400); ev('pointerdown', 2, 200 + from / 2, 400);
      ev('pointermove', 1, 200 - to / 2, 400); ev('pointermove', 2, 200 + to / 2, 400);
      ev('pointerup', 1, 200 - to / 2, 400); ev('pointerup', 2, 200 + to / 2, 400);
    },
    ev,
  };
}

test('zooming keeps the point under the fingers still and stays in range', () => {
  const t = zoomAround({ z: 1, x: 0, y: 0 }, 2, 100, 0, 400, 800);
  assert.deepEqual(t, { z: 2, x: -100, y: 0 }); // a point 100px right of centre stays put at 2x
  assert.equal(zoomAround(t, 99, 0, 0, 400, 800).z, MAX_ZOOM);
  assert.deepEqual(zoomAround(t, 0.2, 0, 0, 400, 800), { z: 1, x: 0, y: 0 });
});

test("the photo can't be dragged off the screen", () => {
  assert.deepEqual(clampView({ z: 2, x: 999, y: -999 }, 400, 800), { z: 2, x: 200, y: -400 });
  assert.deepEqual(clampView({ z: 1, x: 50, y: 50 }, 400, 800), { z: 1, x: 0, y: 0 });
});

test('pinching out zooms the photo in, and pinching back in returns it to normal', () => {
  const f = fakeStage();
  const pz = photoZoom(f.stage);
  f.pinch(100, 300);
  assert.equal(pz.view.z, 3);
  assert.equal(f.imgs[1].style.transform, 'translate(0px, 0px) scale(3)');
  assert.ok(f.classes.has('zoomed'));
  f.pinch(300, 100);
  assert.deepEqual(pz.view, { z: 1, x: 0, y: 0 });
  assert.equal(f.imgs[1].style.transform, '');
  assert.ok(!f.classes.has('zoomed'));
});

test('double-tap zooms in where you tap, and again zooms back out', () => {
  const f = fakeStage();
  const pz = photoZoom(f.stage);
  f.tap(300, 400); f.wait(150); f.tap(300, 400);
  assert.equal(pz.view.z, 2.5);
  assert.equal(pz.view.x, -150); // the tapped spot, 100px right of centre, stays under the finger
  f.wait(500); f.tap(300, 400); f.wait(150); f.tap(300, 400);
  assert.deepEqual(pz.view, { z: 1, x: 0, y: 0 });
});

test('two slow taps are not a double-tap', () => {
  const f = fakeStage();
  const pz = photoZoom(f.stage);
  f.tap(200, 400); f.wait(600); f.tap(200, 400);
  assert.equal(pz.view.z, 1);
});

test('swiping moves between photos only when not zoomed in; zoomed in, a drag moves the photo', () => {
  const f = fakeStage();
  const swipes = [];
  const pz = photoZoom(f.stage, { onSwipe: (d) => swipes.push(d) });
  f.drag(300, 400, 100, 410);
  f.drag(100, 400, 300, 390);
  assert.deepEqual(swipes, [1, -1]);
  f.pinch(100, 200); // 2x
  f.drag(300, 400, 250, 400);
  assert.deepEqual(swipes, [1, -1], 'no swipe while zoomed');
  assert.equal(pz.view.x, -50);
});

test('a pinch never counts as a swipe', () => {
  const f = fakeStage();
  const swipes = [];
  photoZoom(f.stage, { onSwipe: (d) => swipes.push(d) });
  f.pinch(300, 100);
  assert.deepEqual(swipes, []);
});

test('the arrow buttons on the photo still work as buttons', () => {
  const f = fakeStage();
  const pz = photoZoom(f.stage);
  const onButton = { closest: () => ({}) };
  f.ev('pointerdown', 1, 10, 400, { target: onButton });
  f.ev('pointerup', 1, 10, 400, { target: onButton });
  f.wait(100);
  f.ev('pointerdown', 1, 10, 400, { target: onButton });
  f.ev('pointerup', 1, 10, 400, { target: onButton });
  assert.equal(pz.view.z, 1, 'pressing an arrow twice is not a double-tap');
});

test('a trackpad pinch zooms; ordinary scrolling is left alone', () => {
  const f = fakeStage();
  const pz = photoZoom(f.stage);
  assert.equal(f.ev('wheel', 0, 200, 400, { deltaY: 40 }).defaultPrevented, false);
  assert.equal(pz.view.z, 1);
  assert.equal(f.ev('wheel', 0, 200, 400, { deltaY: -100, ctrlKey: true }).defaultPrevented, true);
  assert.ok(pz.view.z > 2.7 && pz.view.z < 2.72);
});

test('both full-screen photo viewers use it, and it works offline', () => {
  assert.match(read('public/js/photos.js'), /photoZoom\(el\.querySelector\('\[data-stage\]'\)/);
  assert.match(read('public/js/chat.js'), /photoZoom\(el\.querySelector\('\.pv-stage'\)\)/);
  assert.match(read('public/app.css'), /\.pv-stage \{[^}]*touch-action: none;/);
  assert.match(read('public/sw.js'), /'\/js\/photozoom\.js'/);
});
