// Pictures and GIFs in the group chat can be opened full screen and zoomed, now that the page itself
// doesn't pinch-zoom on a phone (TA-15).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openOnPinch } from '../public/js/photozoom.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const chat = fs.readFileSync(path.join(ROOT, 'public/js/chat.js'), 'utf8');

// A chat with two pictures and some text; fingers land on one of them.
function fakeChat() {
  const listeners = {};
  const picA = { name: 'A' }, picB = { name: 'B' };
  const on = (pic) => ({ closest: (sel) => (sel === '.msg-media' ? pic : null) });
  const opened = [];
  const box = { addEventListener: (type, fn) => { (listeners[type] ||= []).push(fn); } };
  openOnPinch(box, '.msg-media', (pic) => opened.push(pic.name));
  const fire = (type, id, target, pointerType = 'touch') => listeners[type]?.forEach((fn) => fn({ pointerId: id, target, pointerType }));
  return { picA, picB, on, opened, fire };
}

test('pinching a picture in the chat opens it full screen', () => {
  const c = fakeChat();
  c.fire('pointerdown', 1, c.on(c.picA));
  assert.deepEqual(c.opened, []);
  c.fire('pointerdown', 2, c.on(c.picA));
  assert.deepEqual(c.opened, ['A']);
});

test('one finger, two pictures or text is not a pinch to open', () => {
  const c = fakeChat();
  c.fire('pointerdown', 1, c.on(c.picA)); c.fire('pointerup', 1, c.on(c.picA));
  c.fire('pointerdown', 2, c.on(c.picA));
  assert.deepEqual(c.opened, [], 'a tap and then another tap');
  c.fire('pointerup', 2, c.on(c.picA));
  c.fire('pointerdown', 3, c.on(c.picA)); c.fire('pointerdown', 4, c.on(c.picB));
  assert.deepEqual(c.opened, [], 'fingers on two different pictures');
  c.fire('pointerup', 3, null); c.fire('pointerup', 4, null);
  c.fire('pointerdown', 5, c.on(null)); c.fire('pointerdown', 6, c.on(null));
  assert.deepEqual(c.opened, [], 'pinching on text');
});

test('a mouse never counts as a pinch', () => {
  const c = fakeChat();
  c.fire('pointerdown', 1, c.on(c.picA), 'mouse');
  c.fire('pointerdown', 2, c.on(c.picA), 'mouse');
  assert.deepEqual(c.opened, []);
});

test('a lifted finger frees the pinch for the next one', () => {
  const c = fakeChat();
  c.fire('pointerdown', 1, c.on(c.picA)); c.fire('pointerdown', 2, c.on(c.picA));
  c.fire('pointerup', 1, null); c.fire('pointerup', 2, null);
  c.fire('pointerdown', 3, c.on(c.picB)); c.fire('pointerdown', 4, c.on(c.picB));
  assert.deepEqual(c.opened, ['A', 'B']);
});

test('the chat wires it up: GIFs open like photos and both zoom in the viewer', () => {
  assert.match(chat, /openOnPinch\(msgs, '\.msg-media'/);
  assert.match(chat, /e\.target\.closest\('\[data-photo\], \[data-gif\]'\)\) return openPhoto\(m\)/);
  assert.match(chat, /aria-label="Open GIF/);
  assert.match(chat, /m\.kind === 'photo' \|\| m\.kind === 'gif' \? `<button class="btn block" data-open>/);
  assert.match(chat, /photoZoom\(el\.querySelector\('\.pv-stage'\)\)/);
});

test("a KLIPY GIF has no download button, as KLIPY's terms don't allow keeping copies", () => {
  const viewer = chat.slice(chat.indexOf('function openPhoto(m)'), chat.indexOf('// ---------- writing'));
  assert.match(viewer, /\$\{klipy \? '<span class="pv-count">GIF via KLIPY<\/span>' : `<a class="icon-btn" href="\$\{esc\(md\.url\)\}" download=/);
  assert.match(viewer, /referrerpolicy="no-referrer"/);
});

test('a press and hold is not set off by a pinch', () => {
  const lp = chat.slice(chat.indexOf('function bindLongPress(box)'), chat.indexOf('function openActions('));
  assert.match(lp, /if \(fingers\.size > 1\) return clearTimeout\(t\);/);
});
