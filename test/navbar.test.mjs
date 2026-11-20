// 1.9: a permanent navigation bar, like Google Maps'. It can't be hidden any more and only steps aside while the
// on-screen keyboard is up on a phone (public/js/navbar.js); cards dock above it instead of covering it (app.css).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isTextField, initNavbar } from '../public/js/navbar.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

const el = (tagName, attrs = {}, extra = {}) => ({
  nodeType: 1, tagName, readOnly: false, disabled: false, isContentEditable: false,
  getAttribute: (k) => (k in attrs ? attrs[k] : null), ...extra,
});

// A stand-in for the browser: records listeners, runs timers by hand, and keeps <html>'s classes.
function fakeWindow({ coarse = true, android = false, height = 800, width = 400 } = {}) {
  const listeners = {}, winListeners = {}, timers = new Map(), classes = new Set();
  let nextTimer = 1;
  const document = {
    activeElement: null,
    documentElement: { classList: {
      contains: (c) => classes.has(c),
      toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)),
    } },
    addEventListener: (type, fn) => (listeners[type] ||= []).push(fn),
  };
  const win = {
    document, innerHeight: height, innerWidth: width, events: [],
    navigator: { userAgent: android ? 'Mozilla/5.0 (Linux; Android 15) Chrome/131' : 'Mozilla/5.0 (iPhone)' },
    matchMedia: (q) => ({ matches: q === '(pointer: coarse)' ? coarse : false }),
    setTimeout: (fn) => { const id = nextTimer++; timers.set(id, fn); return id; },
    addEventListener: (type, fn) => (winListeners[type] ||= []).push(fn),
    dispatchEvent: (e) => win.events.push(e.type),
    Event: class { constructor(type) { this.type = type; } },
  };
  globalThis.clearTimeout = (id) => timers.delete(id);
  return {
    win, classes,
    focus(target) { document.activeElement = target; for (const fn of listeners.focusin || []) fn({ target }); },
    blur() { const target = document.activeElement; document.activeElement = null; for (const fn of listeners.focusout || []) fn({ target }); },
    runTimers() { for (const [id, fn] of [...timers]) { timers.delete(id); fn(); } },
    resize(h, w = win.innerWidth) { win.innerHeight = h; win.innerWidth = w; for (const fn of winListeners.resize || []) fn(); },
  };
}

test('text boxes count as bringing up the keyboard; buttons, checkboxes and pickers do not', () => {
  assert.equal(isTextField(el('INPUT')), true, 'an input with no type is text');
  for (const type of ['text', 'search', 'email', 'url', 'tel', 'password', 'number', 'SEARCH']) assert.equal(isTextField(el('INPUT', { type })), true, type);
  for (const type of ['checkbox', 'radio', 'range', 'button', 'submit', 'file', 'color', 'date', 'time']) assert.equal(isTextField(el('INPUT', { type })), false, type);
  assert.equal(isTextField(el('TEXTAREA')), true);
  assert.equal(isTextField(el('DIV', {}, { isContentEditable: true })), true);
  assert.equal(isTextField(el('SELECT')), false);
  assert.equal(isTextField(el('BUTTON')), false);
  assert.equal(isTextField(el('INPUT', { type: 'text' }, { readOnly: true })), false, 'read-only boxes show no keyboard');
  assert.equal(isTextField(el('TEXTAREA', {}, { disabled: true })), false);
  assert.equal(isTextField(null), false);
  assert.equal(isTextField({ nodeType: 3 }), false, 'a text node is not a field');
});

test('on a phone the bar steps aside while typing and comes back after', () => {
  const f = fakeWindow();
  initNavbar(f.win);
  f.focus(el('INPUT', { type: 'search' }));
  assert.ok(f.classes.has('kb-open'));
  assert.deepEqual(f.win.events, ['navbar']);
  f.blur();
  assert.ok(f.classes.has('kb-open'), 'waits a moment before coming back');
  f.runTimers();
  assert.ok(!f.classes.has('kb-open'));
  assert.deepEqual(f.win.events, ['navbar', 'navbar']);
});

test('moving from one text box to the next does not flash the bar back in between', () => {
  const f = fakeWindow();
  initNavbar(f.win);
  f.focus(el('INPUT'));
  f.blur();
  f.focus(el('TEXTAREA'));
  f.runTimers();
  assert.ok(f.classes.has('kb-open'));
  assert.deepEqual(f.win.events, ['navbar'], 'one change, not three');
});

test('tapping a button or checkbox leaves the bar where it is', () => {
  const f = fakeWindow();
  initNavbar(f.win);
  f.focus(el('BUTTON'));
  f.focus(el('INPUT', { type: 'checkbox' }));
  f.focus(el('SELECT'));
  assert.ok(!f.classes.has('kb-open'));
});

test('on a computer (no touch screen) the bar never moves', () => {
  const f = fakeWindow({ coarse: false });
  initNavbar(f.win);
  f.focus(el('INPUT'));
  assert.ok(!f.classes.has('kb-open'));
});

test('Android: closing the keyboard with the back gesture brings the bar back, reopening it hides it again', () => {
  const f = fakeWindow({ android: true, height: 800 });
  initNavbar(f.win);
  f.focus(el('TEXTAREA'));
  f.resize(450); // keyboard up: with resizes-content the page shrinks
  assert.ok(f.classes.has('kb-open'));
  f.resize(800); // back gesture: keyboard gone, the box keeps focus
  assert.ok(!f.classes.has('kb-open'));
  f.resize(450); // tap the same box again: no new focusin
  assert.ok(f.classes.has('kb-open'));
});

test('Android: turning the phone is not mistaken for the keyboard opening or closing', () => {
  const f = fakeWindow({ android: true, height: 800, width: 400 });
  initNavbar(f.win);
  f.resize(400, 800); // sideways, nothing focused
  f.focus(el('INPUT'));
  f.resize(200, 800); // keyboard up sideways
  assert.ok(f.classes.has('kb-open'));
  f.resize(450, 400); // turned upright with the keyboard still up: no decision from the new height
  assert.ok(f.classes.has('kb-open'), 'the bar stays away while the keyboard is still up');
  f.resize(800, 400); // keyboard closed upright
  assert.ok(!f.classes.has('kb-open'));
});

test('iPhone: page size changes never decide it (iOS does not resize the page for the keyboard)', () => {
  const f = fakeWindow({ android: false, height: 800 });
  initNavbar(f.win);
  f.focus(el('INPUT'));
  f.resize(800);
  assert.ok(f.classes.has('kb-open'), 'still typing');
});

test('the hide button and the "show navigation" pill are gone', () => {
  const html = read('public/index.html'), css = read('public/app.css'), main = read('public/js/main.js');
  assert.doesNotMatch(html, /nav-collapse|nav-handle/);
  assert.doesNotMatch(css, /nav-collapsed|nav-handle|\.tab\.collapse/);
  assert.doesNotMatch(main, /setNavCollapsed|nav-collapsed/);
  assert.match(main, /localStorage\.removeItem\('tabi\.nav'\)/, 'an old "hidden" setting is forgotten');
  assert.doesNotMatch(read('public/js/map.js'), /nav-collapsed/);
  assert.doesNotMatch(read('public/js/tour.js'), /arrow hides this bar/);
});

test('every tab has an icon pill and a label, and the screens are the same as before', () => {
  const html = read('public/index.html');
  const nav = html.match(/<nav id="tabbar"[\s\S]*?<\/nav>/)[0];
  const tabs = [...nav.matchAll(/<button class="tab[^"]*" data-tab="(\w+)"[^>]*>([\s\S]*?)<\/button>/g)];
  assert.deepEqual(tabs.map((t) => t[1]), ['map', 'itinerary', 'chat', 'money', 'settings', 'notifications']);
  for (const [, tab, inner] of tabs) {
    assert.match(inner, /^<span class="tab-ico"><svg class="i"><use href="#i-[\w-]+"\/><\/svg><\/span><span class="tab-label">[^<]+<\/span>/, tab);
  }
  assert.match(nav, /data-chat-count/);
  assert.match(nav, /data-notif-count/);
});

test('cards dock above the bar, the chat box sits on it, and the bar only steps aside for the keyboard', () => {
  const css = read('public/app.css');
  assert.match(css, /\.sheet\.peek \{ bottom: var\(--bar-b\);/);
  assert.match(css, /\.screen-chat \{ bottom: var\(--bar-b\); \}/);
  assert.match(css, /html\.kb-open \{ --tab-h: 0px; --bar-b: 0px; --bar-safe: var\(--safe-b\); \}/);
  assert.match(css, /html\.kb-open \.tabbar \{ transform: translateY\(100%\); visibility: hidden; \}/);
  assert.doesNotMatch(css, /chat-convo \.tabbar/, 'a conversation no longer hides the bar');
  // Both rail layouts (computers, phones held sideways) keep the rail while typing and reserve no bottom space
  assert.equal((css.match(/:root \{ --tab-h: 0px; --bar-b: 0px; --bar-safe: var\(--safe-b\);/g) || []).length, 2);
  assert.equal((css.match(/html\.kb-open \.tabbar \{ transform: none; visibility: visible; \}/g) || []).length, 2);
});

test('the service worker keeps navbar.js for offline use', () => {
  assert.match(read('public/sw.js'), /'\/js\/navbar\.js'/);
});
