// TA-15: the page no longer zooms on a phone, so the full-screen photo viewer zooms the photo itself.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { photoZoom, clampView, zoomAround, fittedSize, MAX_ZOOM } from '../public/js/photozoom.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

// A 400 x 800 stage at the top-left of the screen, holding the blurred thumbnail and the photo.
// With no photo size given, the photo hasn't loaded yet and fills the stage.
function fakeStage(photo = {}) {
  const listeners = {};
  const imgListeners = {};
  const rect = { left: 0, top: 0, width: 400, height: 800 };
  const imgs = [{ style: {} }, { style: {}, naturalWidth: photo.w, naturalHeight: photo.h, addEventListener: (type, fn) => { imgListeners[type] = fn; } }];
  const classes = new Set();
  const stage = {
    addEventListener: (type, fn) => { listeners[type] = fn; },
    getBoundingClientRect: () => ({ ...rect }),
    querySelectorAll: () => imgs,
    querySelector: (sel) => (sel === '.pv-img' ? imgs[1] : null),
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
    stage, imgs, classes, rect, imgListeners,
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

test('a photo is drawn at its own shape inside the stage', () => {
  assert.deepEqual(fittedSize(400, 800, 4000, 3000), { iw: 400, ih: 300 }); // landscape photo, portrait phone
  assert.deepEqual(fittedSize(800, 400, 3000, 4000), { iw: 300, ih: 400 }); // portrait photo, landscape phone
  assert.deepEqual(fittedSize(400, 800, 0, 0), { iw: 400, ih: 800 }); // not loaded yet
});

test('a landscape photo on a portrait phone can only be dragged as far as its own edges', () => {
  // drawn 400 x 300 in a 400 x 800 stage: at 2x it's 800 x 600, wider than the stage but not taller
  assert.deepEqual(clampView({ z: 2, x: 999, y: 999 }, 400, 800, 400, 300), { z: 2, x: 200, y: 0 });
  // at 3x it's 900 tall, 50px taller than the stage either way
  assert.deepEqual(clampView({ z: 3, x: -999, y: -999 }, 400, 800, 400, 300), { z: 3, x: -400, y: -50 });
});

test('a portrait photo on a landscape phone can only be dragged as far as its own edges', () => {
  // drawn 300 x 400 in an 800 x 400 stage: at 2x it's 600 x 800, taller than the stage but not wider
  assert.deepEqual(clampView({ z: 2, x: 999, y: 999 }, 800, 400, 300, 400), { z: 2, x: 0, y: 200 });
  assert.deepEqual(clampView({ z: 3, x: -999, y: 0 }, 800, 400, 300, 400), { z: 3, x: -50, y: 0 });
});

test('dragging a zoomed landscape photo up or down keeps it on screen', () => {
  const f = fakeStage({ w: 4000, h: 3000 });
  const pz = photoZoom(f.stage);
  f.pinch(100, 200); // 2x: 800 x 600 in a 400 x 800 stage
  f.drag(200, 400, 260, 100);
  assert.deepEqual(pz.view, { z: 2, x: 60, y: 0 }, 'moves sideways, not out of view vertically');
  f.drag(200, 400, 900, 400);
  assert.equal(pz.view.x, 200, 'stops at the photo\'s left edge');
});

test('turning the phone while zoomed in pulls the photo back on screen', () => {
  const observers = [];
  globalThis.ResizeObserver = class { constructor(cb) { this.cb = cb; observers.push(this); } observe() {} disconnect() { this.off = true; } };
  try {
    const f = fakeStage({ w: 3000, h: 4000 }); // a portrait photo, drawn 400 x 533 on a 400 x 800 phone
    const pz = photoZoom(f.stage);
    f.pinch(100, 300); // 3x: 1200 x 1600
    f.drag(200, 400, 900, 1400);
    assert.deepEqual(pz.view, { z: 3, x: 400, y: 400 }, 'dragged to the top-left corner');
    // Turned sideways: the stage is 800 x 400 and the photo is drawn 300 x 400, so 900 x 1200 at 3x
    Object.assign(f.rect, { width: 800, height: 400 });
    observers[0].cb();
    assert.deepEqual(pz.view, { z: 3, x: 50, y: 400 });
    assert.equal(f.imgs[1].style.transform, 'translate(50px, 400px) scale(3)');
    // Once the viewer is closed, it stops listening
    f.stage.isConnected = false;
    observers[0].cb();
    assert.ok(observers[0].off);
  } finally {
    delete globalThis.ResizeObserver;
  }
});

test('when the full photo loads and its real shape is known, a zoomed view is pulled back inside it', () => {
  const f = fakeStage(); // not loaded yet: the photo is taken to fill the 400 x 800 stage
  const pz = photoZoom(f.stage);
  f.pinch(100, 200); // 2x
  f.drag(200, 400, 200, 900);
  assert.deepEqual(pz.view, { z: 2, x: 0, y: 400 });
  // It loads as a landscape photo, drawn 400 x 300: 600 tall at 2x, so it fits and is centred
  Object.assign(f.imgs[1], { naturalWidth: 4000, naturalHeight: 3000 });
  f.imgListeners.load();
  assert.deepEqual(pz.view, { z: 2, x: 0, y: 0 });
});

test('a view at normal size is left alone when the stage changes', () => {
  const f = fakeStage({ w: 4000, h: 3000 });
  const pz = photoZoom(f.stage);
  Object.assign(f.rect, { width: 0, height: 0 });
  pz.refit();
  assert.deepEqual(pz.view, { z: 1, x: 0, y: 0 });
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
