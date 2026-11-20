// Works out how map bubbles should move when places group into a cluster or a cluster splits apart.
// Pure (no DOM, no MapLibre), so it can be tested on its own. Points are screen pixels at the
// current camera, and a dot counts as a cluster of 1.
//
//   leaving:  bubbles drawn until now that are no longer wanted   [{ key, x, y, count }]
//   entering: bubbles wanted now that aren't drawn yet             [{ key, x, y, count }]
//
// Returns
//   moves: [{ from, to }]  a cluster that only changed its id (MapLibre renumbers clusters at every
//                          zoom level): keep the same bubble and give it the new id, so it doesn't pop;
//   enter: Map key -> { dx, dy } | null   where a new bubble starts, relative to its own spot
//                                         (the cluster it came out of), or null to just fade in;
//   leave: Map key -> { dx, dy } | null   where an old bubble goes, relative to its own spot
//                                         (the cluster it joined), or null to just fade out.

// Children of a cluster sit within MapLibre's clusterRadius (46 px) of its centre at the zoom where
// they join, so up to about twice that a zoom level later, a little more mid-pinch.
export const REACH = 140;
// The same cluster under a new id has the same centre, so it projects to the same pixel.
const SAME = 4;

export function planMotion(leaving, entering, { reach = REACH } = {}) {
  const moves = [];
  const left = [...leaving], come = [...entering];

  // 1. Renumbered clusters: same size, same spot.
  for (let i = left.length - 1; i >= 0; i--) {
    const a = left[i];
    if (a.count < 2) continue;
    const j = nearest(come, a, (b) => b.count === a.count, SAME);
    if (j < 0) continue;
    moves.push({ from: a.key, to: come[j].key });
    left.splice(i, 1);
    come.splice(j, 1);
  }

  // 2. A new bubble came out of the nearest old cluster bigger than it (zooming in: a split).
  const enter = new Map();
  for (const b of come) {
    const j = nearest(left, b, (a) => a.count > b.count, reach);
    enter.set(b.key, j < 0 ? null : { dx: left[j].x - b.x, dy: left[j].y - b.y });
  }
  // 3. An old bubble went into the nearest new cluster bigger than it (zooming out: grouping).
  const leave = new Map();
  for (const a of left) {
    const j = nearest(come, a, (b) => b.count > a.count, reach);
    leave.set(a.key, j < 0 ? null : { dx: come[j].x - a.x, dy: come[j].y - a.y });
  }
  return { moves, enter, leave };
}

function nearest(list, p, ok, within) {
  let best = -1, bestD = within * within;
  for (let i = 0; i < list.length; i++) {
    const q = list[i];
    if (!ok(q)) continue;
    const d = (q.x - p.x) ** 2 + (q.y - p.y) ** 2;
    if (d <= bestD) { best = i; bestD = d; }
  }
  return best;
}
