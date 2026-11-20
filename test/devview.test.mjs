// TA-7: the developer console stays steady while live events stream in.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TAB_KINDS, affectsTab, patchHtml, patchList, rowItems, keepScroll, createThrottle, optionsHtml } from '../public/js/devview.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

// A tiny stand-in for the DOM: just what patchList and keepScroll use.
class El {
  constructor(html) { this.html = html; this.dataset = {}; this.parent = null; const cls = new Set(); this.classList = { add: (c) => cls.add(c), contains: (c) => cls.has(c) }; }
  remove() { this.parent?._take(this); }
}
class Box {
  constructor() { this.children = []; }
  insertBefore(el, ref) {
    el.parent?._take(el);
    const i = ref ? this.children.indexOf(ref) : this.children.length;
    this.children.splice(i < 0 ? this.children.length : i, 0, el);
    el.parent = this;
    return el;
  }
  _take(el) { const i = this.children.indexOf(el); if (i >= 0) this.children.splice(i, 1); el.parent = null; }
}
const parse = (html) => new El(html);
const htmls = (box) => box.children.map((c) => c.html);

test('only events that change what a tab shows redraw it', () => {
  assert.deepEqual(TAB_KINDS.overview, [], 'the overview refreshes on its own timer, not on every event');
  assert.ok(!affectsTab('overview', 'net'), 'failover storage requests every few seconds no longer redraw the overview');
  assert.ok(affectsTab('logs', 'log') && !affectsTab('logs', 'net'));
  assert.ok(affectsTab('network', 'net') && !affectsTab('network', 'log'));
  assert.ok(affectsTab('activity', 'op') && affectsTab('activity', 'ws'));
  assert.ok(affectsTab('locations', 'loc') && affectsTab('locations', 'owntracks'));
  assert.ok(!affectsTab('places', 'loc'), 'typing in the places filter is never interrupted by live events');
  assert.ok(!affectsTab('nonsense', 'log'));
});

test('patchHtml leaves an element alone when its markup is unchanged', () => {
  let writes = 0;
  const el = { set innerHTML(v) { writes++; this._v = v; }, get innerHTML() { return this._v; } };
  assert.equal(patchHtml(el, '<b>1</b>'), true);
  assert.equal(patchHtml(el, '<b>1</b>'), false);
  assert.equal(patchHtml(el, '<b>2</b>'), true);
  assert.equal(writes, 2);
  assert.equal(patchHtml(null, 'x'), false);
});

test('patchList keeps unchanged rows as the very same elements', () => {
  const box = new Box();
  patchList(box, [{ key: 2, html: 'b' }, { key: 1, html: 'a' }], parse);
  const [b, a] = box.children;
  assert.deepEqual(htmls(box), ['b', 'a']);
  // A new event arrives at the top; nothing else changed.
  const changed = patchList(box, [{ key: 3, html: 'c', fresh: true }, { key: 2, html: 'b' }, { key: 1, html: 'a' }], parse);
  assert.equal(changed, true);
  assert.deepEqual(htmls(box), ['c', 'b', 'a']);
  assert.equal(box.children[1], b, 'row b was not rebuilt');
  assert.equal(box.children[2], a, 'row a was not rebuilt');
  assert.ok(box.children[0].classList.contains('new'), 'the new row is highlighted');
  assert.ok(!b.classList.contains('new'));
  // Same list again: nothing to do.
  assert.equal(patchList(box, [{ key: 3, html: 'c' }, { key: 2, html: 'b' }, { key: 1, html: 'a' }], parse), false);
  assert.ok(box.children[0].classList.contains('new'), 'not redrawn just because the highlight flag went away');
});

test('patchList replaces changed rows, drops old ones and keeps the order', () => {
  const box = new Box();
  patchList(box, [{ key: 'x', html: 'x1' }, { key: 'y', html: 'y1' }, { key: 'z', html: 'z1' }], parse);
  const z = box.children[2];
  patchList(box, [{ key: 'y', html: 'y2' }, { key: 'z', html: 'z1' }, { key: 'w', html: 'w1' }], parse);
  assert.deepEqual(htmls(box), ['y2', 'z1', 'w1']);
  assert.equal(box.children[1], z);
  assert.equal(box.children.length, 3);
  // Reordering (newest first after a filter change) works too.
  patchList(box, [{ key: 'w', html: 'w1' }, { key: 'z', html: 'z1' }], parse);
  assert.deepEqual(htmls(box), ['w1', 'z1']);
  assert.equal(box.children[1], z);
});

test('patchList clears a placeholder that was there before', () => {
  const box = new Box();
  box.insertBefore(new El('Loading…'), null); // no key: not one of ours
  patchList(box, rowItems([], { html: () => '', empty: 'none yet' }), parse);
  assert.deepEqual(htmls(box), ['none yet']);
  patchList(box, rowItems([{ id: 7 }], { html: (e) => `row ${e.id}`, empty: 'none yet' }), parse);
  assert.deepEqual(htmls(box), ['row 7']);
});

test('rowItems marks fresh events and falls back to one placeholder', () => {
  const fresh = new Set([2]);
  assert.deepEqual(rowItems([{ id: 1 }, { id: 2 }], { html: (e) => `r${e.id}`, fresh: (e) => fresh.has(e.id), empty: 'e' }),
    [{ key: 1, html: 'r1', fresh: false }, { key: 2, html: 'r2', fresh: true }]);
  assert.deepEqual(rowItems([], { html: () => '', empty: 'e' }), [{ key: '__empty', html: 'e' }]);
  assert.deepEqual(rowItems([{ id: 'p1' }], { key: (p) => p.id, html: () => 'h', empty: 'e' })[0].key, 'p1');
});

// A scroll box whose content height follows the rows it holds (20px each)
const scrollBox = (rows, scrollTop, clientHeight = 200) => {
  const box = { rows, clientHeight, _top: scrollTop };
  Object.defineProperty(box, 'scrollHeight', { get: () => box.rows * 20 });
  Object.defineProperty(box, 'scrollTop', { get: () => box._top, set: (v) => { box._top = Math.max(0, Math.min(v, box.rows * 20 - clientHeight)); } });
  return box;
};

test('newest-first lists: a reader scrolled down stays on the same rows when new ones arrive above', () => {
  const box = scrollBox(50, 300);
  keepScroll(box, () => { box.rows += 3; });
  assert.equal(box.scrollTop, 360);
  const top = scrollBox(50, 0);
  keepScroll(top, () => { top.rows += 3; });
  assert.equal(top.scrollTop, 0, 'at the top you see the newest');
});

test('newest-last lists (server log): follow along at the bottom, stay put when scrolled up', () => {
  const bottom = scrollBox(50, 800); // 1000 - 200: at the bottom
  keepScroll(bottom, () => { bottom.rows += 5; }, 'newest-last');
  assert.equal(bottom.scrollTop, bottom.scrollHeight - bottom.clientHeight);
  const reading = scrollBox(50, 300);
  keepScroll(reading, () => { reading.rows += 5; }, 'newest-last');
  assert.equal(reading.scrollTop, 300);
});

test('the redraw throttle runs steadily under a constant stream, never starving', () => {
  let now = 0;
  const timers = [];
  const fake = {
    setTimeout: (fn, ms) => { timers.push({ fn, at: now + ms }); return timers.length; },
    clearTimeout: (id) => { if (timers[id - 1]) timers[id - 1].fn = null; },
  };
  let runs = 0;
  const t = createThrottle(() => runs++, 500, fake);
  // An event every 100 ms for 3 seconds (the old debounce would never have drawn).
  for (now = 0; now <= 3000; now += 100) {
    for (const tm of timers) if (tm.fn && tm.at <= now) { const f = tm.fn; tm.fn = null; f(); }
    t.schedule();
  }
  assert.ok(runs >= 5 && runs <= 6, `drew ${runs} times in 3 s`);
  assert.equal(t.pending, true);
  t.cancel();
  assert.equal(t.pending, false);
});

test('filter dropdown options keep the current choice', () => {
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
  const html = optionsHtml(['Ana', 'Bo<b>'], 'Ana', { allLabel: 'Everyone', esc });
  assert.match(html, /^<option value="">Everyone<\/option>/);
  assert.match(html, /<option value="Ana" selected>Ana<\/option>/);
  assert.ok(!html.includes('<b>'));
});

test('the console page scrolls as a page, and live data never rebuilds a whole tab', () => {
  const page = read('public/dev.html');
  assert.match(page, /html, body \{ height: auto;/, 'body is not a one-screen scrolling box');
  assert.ok(!/body \{ overflow: auto; \}/.test(page));
  const js = read('public/js/dev.js');
  const stream = js.slice(js.indexOf('function connectStream'), js.indexOf('async function catchUp'));
  assert.match(stream, /scheduleRender\(affectsTab\(tab, k\)\)/, 'live events go through the throttle, for the tabs they affect');
  assert.ok(!/\brender\(\)/.test(stream), 'live events never redraw straight away');
  assert.ok(!/\.focus\(\)/.test(js), 'no refocusing after a redraw: the filter box keeps its focus because it is never replaced');
  assert.match(js, /if \(mounted !== tab\)/, 'a tab is only built when you open it');
  assert.ok(!/setInterval\(\(\) => refreshOverview\(\)\.then\(\(\) => tab === 'overview' && render\(\)\)/.test(js), 'the overview timer no longer rebuilds the page');
});
