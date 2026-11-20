// TA-7: helpers that keep the developer console steady while live events stream in.
// Before 1.8.6 every event (several a second with failover on) and a 10-second timer rebuilt the whole
// page, so typed text, open dropdowns, scroll positions and half-finished taps were thrown away.
// Now each tab builds its controls once and only the parts whose content changed are redrawn.
// Nothing here touches the page directly, so it can be tested in Node.

// Which live event kinds change what each tab shows. Other events only update the counts on the tabs.
export const TAB_KINDS = {
  overview: [],
  locations: ['loc', 'owntracks'],
  owntracks: ['owntracks'],
  places: [],
  activity: ['op', 'ws'],
  network: ['net'],
  client: ['client'],
  logs: ['log'],
};
export const affectsTab = (tab, kind) => (TAB_KINDS[tab] || []).includes(kind);

// Replace an element's contents only when the markup actually changed. Returns true if it did.
export function patchHtml(el, html) {
  if (!el) return false;
  if (el._devHtml === html) return false;
  el.innerHTML = html;
  el._devHtml = html;
  return true;
}

// Bring a list (table rows, log lines) up to date one item at a time. `items` is [{ key, html, fresh }]
// in display order. Items whose markup didn't change keep their very same element, so a link or button
// someone is pressing isn't swapped out under their finger. `parse(html)` turns markup into one element.
// A fresh item gets the "new" class (a brief highlight) when it first appears, and never again.
// Returns true if anything changed.
export function patchList(box, items, parse) {
  if (!box) return false;
  const old = new Map();
  for (const el of [...box.children]) {
    if (el.dataset?.key != null && el._devHtml != null) old.set(el.dataset.key, el);
    else el.remove(); // a placeholder ("Loading…") from before
  }
  let changed = false;
  const want = items.map(({ key, html, fresh }) => {
    const k = String(key);
    const have = old.get(k);
    if (have && have._devHtml === html) return have;
    const el = parse(html);
    el.dataset.key = k;
    el._devHtml = html;
    if (fresh) el.classList.add('new');
    changed = true;
    return el;
  });
  const keep = new Set(want);
  for (const el of [...box.children]) if (!keep.has(el)) { el.remove(); changed = true; }
  want.forEach((el, i) => {
    if (box.children[i] !== el) { box.insertBefore(el, box.children[i] || null); changed = true; }
  });
  return changed;
}

// Run `mutate` (which redraws a scrolling list) without moving what the reader is looking at.
// 'newest-first': new rows arrive at the top, so a reader scrolled down stays on the same rows.
// 'newest-last': a reader at the bottom follows new lines; one scrolled up stays put.
export function keepScroll(box, mutate, order = 'newest-first') {
  if (!box) return mutate();
  const top = box.scrollTop, height = box.scrollHeight, view = box.clientHeight;
  const atBottom = height - top - view < 24;
  const out = mutate();
  if (order === 'newest-last') {
    if (atBottom) box.scrollTop = box.scrollHeight;
    else box.scrollTop = top;
  } else if (top > 0) {
    box.scrollTop = Math.max(0, top + (box.scrollHeight - height));
  } else {
    box.scrollTop = 0;
  }
  return out;
}

// Run `fn` at most once every `ms`, however often it's asked for. (The old debounce restarted its timer
// on every event, so a steady stream could hold the page back and then redraw it all at once.)
export function createThrottle(fn, ms, timers = globalThis) {
  let timer = null;
  return {
    schedule() {
      if (timer != null) return;
      timer = timers.setTimeout(() => { timer = null; fn(); }, ms);
    },
    cancel() { if (timer != null) timers.clearTimeout(timer); timer = null; },
    get pending() { return timer != null; },
  };
}

// Items for patchList from a list of events, or one placeholder row when there are none.
export function rowItems(list, { key = (e) => e.id, html, fresh = () => false, empty }) {
  if (!list.length) return [{ key: '__empty', html: empty }];
  return list.map((e) => ({ key: key(e), html: html(e), fresh: fresh(e) }));
}

// <option> markup for a filter dropdown, with the current choice selected.
export function optionsHtml(values, selected, { allLabel, esc }) {
  return `<option value="">${esc(allLabel)}</option>${values.map((v) => `<option value="${esc(v)}"${v === selected ? ' selected' : ''}>${esc(v)}</option>`).join('')}`;
}
