// Map bubbles (TA-8): when places group or a group splits, each bubble moves to or from the right
// cluster instead of popping.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { planMotion, REACH } from '../public/js/cluster-motion.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const at = (key, x, y, count = 1) => ({ key, x, y, count });

test('zooming out: dots slide into the cluster they join, which fades in', () => {
  const { moves, enter, leave } = planMotion(
    [at('pa', 100, 100), at('pb', 130, 110), at('pc', 115, 140)],
    [at('c1', 115, 117, 3)],
  );
  assert.deepEqual(moves, []);
  assert.deepEqual(leave.get('pa'), { dx: 15, dy: 17 });
  assert.deepEqual(leave.get('pb'), { dx: -15, dy: 7 });
  assert.deepEqual(leave.get('pc'), { dx: 0, dy: -23 });
  assert.equal(enter.get('c1'), null);
});

test('zooming in: a cluster splits and each part grows out of where it was', () => {
  const { moves, enter, leave } = planMotion(
    [at('c9', 200, 200, 5)],
    [at('pa', 150, 180), at('pb', 260, 230), at('c4', 205, 140, 3)],
  );
  assert.deepEqual(moves, []);
  assert.deepEqual(enter.get('pa'), { dx: 50, dy: 20 });
  assert.deepEqual(enter.get('pb'), { dx: -60, dy: -30 });
  assert.deepEqual(enter.get('c4'), { dx: -5, dy: 60 });
  assert.equal(leave.get('c9'), null);
});

test('a cluster that only got a new id keeps its bubble', () => {
  const { moves, enter, leave } = planMotion([at('c1', 50, 50, 4), at('pa', 300, 300)], [at('c7', 50.5, 49.8, 4), at('pa2', 900, 900)]);
  assert.deepEqual(moves, [{ from: 'c1', to: 'c7' }]);
  assert.ok(!enter.has('c7') && !leave.has('c1'));
  // nothing nearby to come from or go to: fade
  assert.equal(enter.get('pa2'), null);
  assert.equal(leave.get('pa'), null);
});

test('same spot but a different count is a real change, not a renumber', () => {
  const { moves, enter } = planMotion([at('c1', 50, 50, 4)], [at('c2', 50, 50, 6), at('pa', 70, 40)]);
  assert.deepEqual(moves, []);
  // the dot can only come out of a cluster bigger than itself
  assert.deepEqual(enter.get('pa'), { dx: -20, dy: 10 });
  assert.equal(enter.get('c2'), null);
});

test('with two clusters splitting side by side, each dot comes from its nearest one', () => {
  const { enter } = planMotion(
    [at('cL', 100, 100, 2), at('cR', 220, 100, 2)],
    [at('l1', 90, 95), at('l2', 110, 105), at('r1', 210, 95), at('r2', 230, 105)],
  );
  assert.deepEqual(enter.get('l1'), { dx: 10, dy: 5 });
  assert.deepEqual(enter.get('l2'), { dx: -10, dy: -5 });
  assert.deepEqual(enter.get('r1'), { dx: 10, dy: 5 });
  assert.deepEqual(enter.get('r2'), { dx: -10, dy: -5 });
});

test('a dot never flies to another dot, or to a cluster out of reach', () => {
  const { leave } = planMotion([at('pa', 0, 0), at('pb', 10, 0)], [at('pc', 5, 0), at('cFar', REACH + 50, 0, 2)]);
  assert.equal(leave.get('pa'), null);
  assert.equal(leave.get('pb'), null);
});

test('nothing changing plans nothing', () => {
  const { moves, enter, leave } = planMotion([], []);
  assert.deepEqual([moves.length, enter.size, leave.size], [0, 0, 0]);
});

test('every script the app imports is saved for offline use', () => {
  const dir = path.join(ROOT, 'public/js');
  const sw = fs.readFileSync(path.join(ROOT, 'public/sw.js'), 'utf8');
  const names = new Set();
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.js'))) {
    for (const m of fs.readFileSync(path.join(dir, f), 'utf8').matchAll(/(?:from |import\()'\.\/([\w-]+\.js)'/g)) names.add(m[1]);
  }
  assert.ok(names.has('cluster-motion.js'));
  for (const n of names) assert.ok(sw.includes(`'/js/${n}'`), `${n} is missing from the offline list in sw.js`);
});
