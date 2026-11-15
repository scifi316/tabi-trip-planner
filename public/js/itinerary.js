// Itinerary / calendar screen: day picker, status filters, grouped lists, voting and ordering.
import { state, on, emit, op, tripDays, effectiveStatus, voteCounts, byPlan, dayStops, today } from './store.js';
import { esc, icon, STATUS, STATUS_ORDER, fmtDay, dayParts, toast } from './ui.js';
import { openPlace } from './place.js';
import { openImport } from './add.js';
import { meButton } from './main.js';

const root = () => document.getElementById('screen-itinerary');
let day = 'all';     // 'all' | 'none' | YYYY-MM-DD
let filter = 'all';  // 'all' | status | 'missed'
let reordering = false;
const collapsed = new Set(['vetoed']);

on('itin-day', (d) => { day = d || 'all'; filter = 'all'; render(); });
on('places', () => isShown() && render());
on('trip', () => isShown() && render());
on('users', () => isShown() && render());
on('state', () => isShown() && render());

const isShown = () => !root().hidden;

const FILTERS = [
  ['all', 'All'], ['confirmed', 'Confirmed'], ['maybe', 'Maybe'], ['suggested', 'Suggested'],
  ['visited', 'Visited'], ['missed', 'Missed'], ['vetoed', 'Vetoed'],
];
const groupOf = (p) => { const e = effectiveStatus(p); return e === 'skipped' ? 'missed' : e; };

export function render() {
  const el = root();
  const days = tripDays();
  const t = today();
  if (day !== 'all' && day !== 'none' && !days.includes(day)) day = 'all';
  const all = [...state.places.values()];
  const inDay = all.filter((p) => day === 'all' ? true : day === 'none' ? !p.day : p.day === day);
  const counts = { all: inDay.length };
  for (const p of inDay) counts[groupOf(p)] = (counts[groupOf(p)] || 0) + 1;
  const shown = inDay.filter((p) => filter === 'all' || groupOf(p) === filter);
  const perDay = (d) => all.filter((p) => p.day === d && p.status !== 'vetoed').length;
  const tr = state.trip;

  el.innerHTML = `
    <div class="page">
      <header class="page-head">
        ${meButton()}
        <div class="grow"><h1>${esc(tr.name || 'Itinerary')}</h1>
          <div class="sub">${tr.start && tr.end ? `${esc(fmtDay(tr.start, { day: 'numeric', month: 'short' }))} to ${esc(fmtDay(tr.end, { day: 'numeric', month: 'short', year: 'numeric' }))}, ${days.length} days` : `${all.length} places`}</div></div>
        <button class="btn small primary" data-add>${icon('plus')}Add</button>
      </header>

      <div class="days" role="group" aria-label="Choose a day">
        <button class="day wide" data-day="all" aria-pressed="${day === 'all'}">All days</button>
        ${days.map((d) => { const dp = dayParts(d); const n = perDay(d); return `
          <button class="day ${d === t ? 'today' : ''}" data-day="${d}" aria-pressed="${day === d}" aria-label="${esc(fmtDay(d))}, ${n} places">
            <div class="dow">${d === t ? 'Today' : dp.dow}</div><div class="dnum">${dp.num}</div><div class="dmon">${dp.mon}</div>
            <span class="count">${n || '–'}</span></button>`; }).join('')}
        <button class="day wide" data-day="none" aria-pressed="${day === 'none'}">Unscheduled <span class="faint num" style="margin-left:4px">${all.filter((p) => !p.day).length}</span></button>
      </div>

      <div class="chips" role="group" aria-label="Filter by status">
        ${FILTERS.map(([k, label]) => `<button class="chip" data-filter="${k}" aria-pressed="${filter === k}">
          ${k !== 'all' ? `<span class="sw" style="--sw:${STATUS[k].color}"></span>` : ''}${label}<span class="n">${counts[k] || 0}</span></button>`).join('')}
      </div>

      <div data-list></div>
    </div>`;

  const list = el.querySelector('[data-list]');
  if (!all.length) {
    list.innerHTML = `<div class="empty"><h3>No places yet</h3><p>Import your Google My Maps, paste links friends sent you, or search for spots.</p>
      <button class="btn primary" data-add>${icon('plus')}Add places</button></div>`;
  } else if (!shown.length) {
    list.innerHTML = `<div class="empty"><p>${filter === 'all' ? 'Nothing planned here yet.' : `No ${FILTERS.find((f) => f[0] === filter)[1].toLowerCase()} places ${day === 'all' ? '' : 'on this day'}.`}</p>
      ${day !== 'all' && day !== 'none' ? `<button class="btn" data-pick>Choose from unscheduled places</button>` : ''}</div>`;
  } else if (day === 'all') {
    // Grouped by day, then by plan order
    const keys = [...new Set(shown.map((p) => p.day || ''))].sort((a, b) => (a || '9999') < (b || '9999') ? -1 : 1);
    list.innerHTML = keys.map((k) => {
      const items = shown.filter((p) => (p.day || '') === k).sort((a, b) => STATUS_ORDER.indexOf(groupOf(a)) - STATUS_ORDER.indexOf(groupOf(b)) || byPlan(a, b));
      return groupHtml(k ? (k === t ? `Today, ${fmtDay(k)}` : fmtDay(k, { weekday: 'long', day: 'numeric', month: 'short' })) : 'Unscheduled', items, { key: 'd' + k, dayKey: k });
    }).join('');
  } else {
    // One day: sections by status; confirmed is the ordered "line"
    const order = ['confirmed', 'missed', 'visited', 'maybe', 'suggested', 'vetoed'];
    list.innerHTML = order.map((g) => {
      let items = shown.filter((p) => groupOf(p) === g);
      if (!items.length) return '';
      items = items.sort(byPlan);
      return groupHtml(STATUS[g].label, items, { key: g, color: STATUS[g].color, line: g === 'confirmed' && day !== 'none' });
    }).join('');
  }

  bind(el);
}

function groupHtml(title, items, { key, color, line, dayKey }) {
  const isCollapsed = collapsed.has(key);
  const stops = day !== 'all' && day !== 'none' ? dayStops(day) : null;
  const canReorder = line && items.length > 1;
  return `
    <section class="group">
      <div class="group-head" style="${color ? `--sw:${color}` : ''}">
        <h3>${esc(title)}</h3><span class="n">${items.length}</span><span class="line"></span>
        ${canReorder ? `<button data-reorder>${reordering ? 'Done' : 'Reorder'}</button>` : ''}
        ${key === 'vetoed' ? `<button data-collapse="${key}">${isCollapsed ? 'Show' : 'Hide'}</button>` : ''}
      </div>
      ${isCollapsed ? '' : `<div class="list">${items.map((p, i) => itemHtml(p, { stops, index: i, reorder: canReorder && reordering, count: items.length, dayKey })).join('')}</div>`}
    </section>`;
}

function itemHtml(p, { stops, index, reorder, count }) {
  const eff = effectiveStatus(p);
  const c = voteCounts(p);
  const mine = p.votes?.[state.me?.id];
  const stopIdx = stops ? stops.findIndex((s) => s.place.id === p.id) : -1;
  const lead = stopIdx >= 0
    ? `<span class="station sm" data-state="${stops[stopIdx].state === 'todo' ? '' : stops[stopIdx].state}">${stopIdx + 1}</span>`
    : `<span class="dot" style="--dot:${STATUS[eff].color}"></span>`;
  const meta = [
    p.time ? `<span class="num">${icon('clock')}${esc(p.time)}</span>` : '',
    day === 'all' || stopIdx < 0 ? `<span>${esc(STATUS[eff].label)}</span>` : '',
    p.notes ? `<span>${esc(p.notes.split('\n')[0].slice(0, 40))}</span>` : '',
  ].filter(Boolean).join('');
  return `
    <div class="item ${eff === 'vetoed' ? 'is-vetoed' : ''}" data-id="${p.id}">
      ${lead}
      <button class="item-main" data-open="${p.id}">
        <div class="item-name">${esc(p.name)}</div>
        ${meta || p.address ? `<div class="item-meta">${meta || `<span class="faint">${esc(p.address)}</span>`}</div>` : ''}
      </button>
      ${reorder ? `<div class="reorder">
          <button class="icon-btn" data-move="-1" aria-label="Move up" ${index === 0 ? 'disabled' : ''}>${icon('arrow-up', 'small')}</button>
          <button class="icon-btn" data-move="1" aria-label="Move down" ${index === count - 1 ? 'disabled' : ''}>${icon('arrow-down', 'small')}</button></div>`
      : `<div class="vote-mini">
          <button class="${mine === 'up' ? 'on' : ''}" data-vote="up" aria-label="Want to go, ${c.up} votes" aria-pressed="${mine === 'up'}">${icon('up')}${c.up || ''}</button>
          <button class="down ${mine === 'down' || mine === 'veto' ? 'on' : ''}" data-vote="down" aria-label="Not keen, ${c.down + c.veto} votes" aria-pressed="${mine === 'down'}">${icon('down')}${c.down + c.veto || ''}</button>
        </div>`}
    </div>`;
}

function bind(el) {
  el.querySelectorAll('[data-add]').forEach((b) => b.onclick = () => openImport());
  el.querySelectorAll('[data-day]').forEach((b) => b.onclick = () => {
    day = b.dataset.day;
    reordering = false;
    if (day !== 'all' && day !== 'none') emit('strip-day', day);
    render();
    el.querySelector('.days [aria-pressed="true"]')?.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });
  });
  el.querySelectorAll('[data-filter]').forEach((b) => b.onclick = () => { filter = b.dataset.filter; render(); });
  el.querySelectorAll('[data-open]').forEach((b) => b.onclick = () => openPlace(b.dataset.open, { peek: false }));
  el.querySelectorAll('[data-collapse]').forEach((b) => b.onclick = () => {
    const k = b.dataset.collapse; collapsed.has(k) ? collapsed.delete(k) : collapsed.add(k); render();
  });
  el.querySelector('[data-reorder]')?.addEventListener('click', () => { reordering = !reordering; render(); });
  el.querySelector('[data-pick]')?.addEventListener('click', () => { const d = day; day = 'none'; filter = 'all'; render(); pickHint(d); });
  el.querySelectorAll('[data-vote]').forEach((b) => b.onclick = (e) => {
    e.stopPropagation();
    const id = b.closest('[data-id]').dataset.id;
    const p = state.places.get(id);
    const mine = p.votes?.[state.me?.id];
    const v = b.dataset.vote;
    op('place.vote', { id, value: mine === v || (v === 'down' && mine === 'veto') ? null : v });
  });
  el.querySelectorAll('[data-move]').forEach((b) => b.onclick = () => {
    const id = b.closest('[data-id]').dataset.id;
    const ids = dayStops(day).map((s) => s.place.id);
    const i = ids.indexOf(id), j = i + +b.dataset.move;
    if (i < 0 || j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    op('place.reorder', { day, ids });
  });
}

function pickHint(d) { toast(`Open a place and set its day to ${fmtDay(d)}`); }

export function showItinerary() { render(); }
