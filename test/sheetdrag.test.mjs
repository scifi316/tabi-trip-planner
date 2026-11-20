// TA-18: pulling a sheet down to put it away, and the "All days" button at the screen edge.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { attachSheetDrag, startsDrag, shouldClose, speedOf, offsetFor, CLOSE_PX, DRAG_START_PX } from '../public/js/sheetdrag.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

// A pretend element: `chain` lists what it is and what it sits inside, e.g. ['button', '.sheet-head'].
const node = (...chain) => ({
  closest: (sel) => (sel.split(',').map((s) => s.trim()).some((s) => chain.includes(s)) ? {} : null),
});
const GRAB = node('.sheet-grab', '.sheet');
const TITLE = node('h2', '.sheet-head', '.sheet');
const CLOSE_X = node('button', '.sheet-head', '.sheet');
const BODY = node('p', '.sheet-body', '.sheet');

// A sheet and a window that record listeners, plus a clock, so drags can be played out.
function rig() {
  const on = {}, winOn = {};
  const classes = new Set();
  const el = {
    style: { transform: '' },
    classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c) },
    addEventListener: (type, fn) => { (on[type] ||= []).push(fn); },
  };
  const win = {
    ontouchstart: null,
    addEventListener: (type, fn) => { (winOn[type] ||= new Set()).add(fn); },
    removeEventListener: (type, fn) => { winOn[type]?.delete(fn); },
  };
  let t = 0, dismissed = 0;
  const api = attachSheetDrag(el, { onDismiss: () => { dismissed++; }, win, now: () => t });
  const fire = (type, e) => { for (const fn of on[type] || []) fn(e); };
  const fireWin = (type, e) => { for (const fn of [...(winOn[type] || [])]) fn(e); };
  const touchEv = (target, id, y, extra = {}) => {
    const touch = { identifier: id, clientY: y };
    return { target, touches: [touch], changedTouches: [touch], cancelable: true, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...extra };
  };
  return {
    el, classes, api, winOn,
    get dismissed() { return dismissed; },
    wait: (ms) => { t += ms; },
    touchStart: (target, y, id = 1, extra) => fire('touchstart', touchEv(target, id, y, extra)),
    touchMove: (y, id = 1) => { const e = touchEv(BODY, id, y); fire('touchmove', e); return e; },
    touchEnd: (y, id = 1) => fire('touchend', touchEv(BODY, id, y, { touches: [] })),
    touchCancel: (id = 1) => fire('touchcancel', touchEv(BODY, id, 0, { touches: [] })),
    // A finger pulling from y0 to y1 over `ms`, in steps, then lifting.
    pull(target, y0, y1, ms = 300) {
      this.touchStart(target, y0);
      for (let i = 1; i <= 6; i++) { t += ms / 6; this.touchMove(y0 + ((y1 - y0) * i) / 6); }
      this.touchEnd(y1);
    },
    mouseDown: (target, y, extra = {}) => fire('pointerdown', { target, pointerId: 7, pointerType: 'mouse', button: 0, clientY: y, ...extra }),
    mouseMove: (y) => fireWin('pointermove', { pointerId: 7, clientY: y }),
    mouseUp: (y) => fireWin('pointerup', { pointerId: 7, clientY: y }),
  };
}

test('the strip and the header both grab the sheet on a phone; buttons and the content keep their taps', () => {
  assert.equal(startsDrag(GRAB, true), true);
  assert.equal(startsDrag(TITLE, true), true, 'the title area is part of the handle now');
  assert.equal(startsDrag(CLOSE_X, true), false, 'the X still just closes');
  assert.equal(startsDrag(node('select', '.sheet-head'), true), false);
  assert.equal(startsDrag(node('a', '.sheet-head'), true), false);
  assert.equal(startsDrag(node('span', '[data-no-drag]', '.sheet-head'), true), false);
  assert.equal(startsDrag(BODY, true), false, 'the scrolling content scrolls, it does not pull the sheet');
  assert.equal(startsDrag(null, true), false);
});

test('with a mouse only the strip grabs, so the title can still be selected', () => {
  assert.equal(startsDrag(GRAB, false), true);
  assert.equal(startsDrag(TITLE, false), false);
});

test('let go far enough down, or flick it, and the sheet closes', () => {
  assert.equal(shouldClose(CLOSE_PX), true);
  assert.equal(shouldClose(CLOSE_PX - 1), false);
  assert.equal(shouldClose(30, 0.8), true, 'a quick flick');
  assert.equal(shouldClose(30, 0.1), false, 'a slow, short pull goes back');
  assert.equal(shouldClose(10, 3), false, 'a twitch is not a flick');
  assert.equal(shouldClose(-200, 5), false, 'pushing up never closes');
  assert.equal(offsetFor(-40), 0, 'the sheet never rises above where it rests');
  assert.equal(offsetFor(33.6), 34);
});

test('speed is measured over the last moments of the pull, not the whole of it', () => {
  assert.equal(speedOf([{ y: 0, t: 0 }]), 0);
  // Held still for a second, then a quick 50px in the last 50ms
  const s = [{ y: 0, t: 0 }, { y: 0, t: 1000 }, { y: 50, t: 1050 }];
  assert.equal(speedOf(s), 1);
});

test('pulling the header down far enough closes the sheet', () => {
  const r = rig();
  r.pull(TITLE, 100, 100 + CLOSE_PX + 20);
  assert.equal(r.dismissed, 1);
  assert.equal(r.classes.has('dragging'), false);
});

test('the sheet follows the finger, and a short slow pull eases back', () => {
  const r = rig();
  r.touchStart(GRAB, 100);
  r.wait(100); const e = r.touchMove(140);
  assert.equal(r.el.style.transform, 'translateY(40px)');
  assert.equal(r.classes.has('dragging'), true);
  assert.equal(e.defaultPrevented, true, 'the page underneath does not scroll');
  r.wait(400); r.touchMove(150); r.wait(400); r.touchEnd(150);
  assert.equal(r.dismissed, 0);
  assert.equal(r.el.style.transform, '', 'back where it was');
  assert.equal(r.classes.has('dragging'), false, 'so it eases back rather than jumping');
});

test('a quick flick closes it even when it only moved a little', () => {
  const r = rig();
  r.pull(GRAB, 100, 140, 60);
  assert.equal(r.dismissed, 1);
});

test('a tap on the header does not nudge the sheet', () => {
  const r = rig();
  r.touchStart(TITLE, 100);
  r.wait(50); r.touchMove(100 + DRAG_START_PX - 1);
  assert.equal(r.el.style.transform, '');
  r.touchEnd(100 + DRAG_START_PX - 1);
  assert.equal(r.dismissed, 0);
});

test('a cancelled touch puts the sheet back instead of leaving it half way', () => {
  const r = rig();
  r.touchStart(GRAB, 100);
  r.wait(50); r.touchMove(160);
  r.touchCancel();
  assert.equal(r.el.style.transform, '');
  assert.equal(r.api.dragging(), false);
  assert.equal(r.dismissed, 0);
});

test('a drag that never saw the finger lift does not swallow the next tap', () => {
  const r = rig();
  r.touchStart(GRAB, 100, 1);
  r.wait(50); r.touchMove(150, 1);
  // The lift never arrives. The next touch lands on the X:
  r.touchStart(CLOSE_X, 60, 2);
  assert.equal(r.api.dragging(), false, 'the old drag is over');
  assert.equal(r.el.style.transform, '', 'and the sheet is back in place');
  // Stray moves or a late lift for the old finger change nothing
  r.touchMove(400, 1); r.touchEnd(400, 1);
  assert.equal(r.el.style.transform, '');
  assert.equal(r.dismissed, 0, 'the X tap itself is left to the button');
});

test('two fingers on the sheet are not a drag', () => {
  const r = rig();
  r.touchStart(GRAB, 100, 1, { touches: [{ identifier: 1, clientY: 100 }, { identifier: 2, clientY: 120 }] });
  r.touchMove(300, 1);
  assert.equal(r.el.style.transform, '');
});

test('with a mouse, the drag keeps following once the pointer leaves the strip', () => {
  const r = rig();
  r.mouseDown(GRAB, 100);
  r.wait(50); r.mouseMove(150); // the window hears it wherever the pointer is
  assert.equal(r.el.style.transform, 'translateY(50px)');
  r.wait(500); r.mouseUp(100 + CLOSE_PX + 10);
  assert.equal(r.dismissed, 1);
  assert.equal(r.winOn.pointermove.size + r.winOn.pointerup.size + r.winOn.pointercancel.size, 0, 'and stops listening afterwards');
});

test('a mouse on the title, a right click, or a finger arriving as a pointer do not start a pointer drag', () => {
  const r = rig();
  r.mouseDown(TITLE, 100);
  r.mouseDown(GRAB, 100, { button: 2 });
  r.mouseDown(GRAB, 100, { pointerType: 'touch' });
  assert.equal(r.winOn.pointermove?.size || 0, 0);
});

test('sheets use the new drag, with no pointer capture left to hold on to a tap', () => {
  const ui = read('public/js/ui.js');
  assert.match(ui, /import \{ attachSheetDrag \} from '\.\/sheetdrag\.js'/);
  assert.match(ui, /attachSheetDrag\(el,/);
  assert.doesNotMatch(ui, /grab\.setPointerCapture/);
  // Closing clears a drag's offset first, or the inline transform would stop the closing slide
  const close = ui.slice(ui.indexOf('close() {'), ui.indexOf("el.classList.add('closing')"));
  assert.match(close, /drag\.cancel\(\)/);
  assert.match(close, /el\.style\.transform = ''/);
  assert.match(read('public/sw.js'), /'\/js\/sheetdrag\.js'/, 'works offline');
});

test('the header is a touch handle, and a pulled sheet eases back', () => {
  const css = read('public/app.css');
  assert.match(css, /\.sheet-head \{[^}]*touch-action: none/);
  assert.match(css, /\.sheet \{[^}]*transition: transform/);
  assert.match(css, /\.sheet\.dragging \{[^}]*transition: none/);
});

test('"All days" snaps inside the strip\'s padding, not against the screen edge', () => {
  const rule = read('public/app.css').match(/\n\.days \{([^}]*)\}/)[1];
  const pad = rule.match(/padding: (\S+) (\S+)/);
  const sidePad = pad[2];
  assert.match(rule, /scroll-snap-type: x/, 'the strip still snaps');
  const sp = rule.match(/scroll-padding-inline: ([^;]+);/);
  assert.ok(sp, 'snap points are inset by scroll-padding');
  assert.equal(sp[1].trim(), sidePad, 'by the same amount as the strip\'s side padding');
});
