// Itinerary / calendar screen: day picker, status filters, grouped lists, voting and ordering.
import { state, on, emit, op, tripDays, effectiveStatus, voteCounts, byPlan, dayStops, today, groupById, groupsOn, userById, personSees } from './store.js';
import { avatar } from './ui.js';
import { openGroups } from './groups.js';
import { esc, icon, STATUS, STATUS_ORDER, fmtDay, dayParts, toast } from './ui.js';
import { openPlace } from './place.js';
import { openImport } from './add.js';
import { meButton } from './main.js';
import { photosOn, canAddOn, openDayPhotos, openViewer, openAlbum } from './photos.js';

const root = () => document.getElementById('screen-itinerary');
let day = 'all';     // 'all' | 'none' | YYYY-MM-DD
let filter = 'all';  // 'all' | status | 'missed'
let reordering = false;
let who = 'all';     // 'all' | subgroup id
let person = null;   // user id: show only that person's plan
const collapsed = new Set(['vetoed']);

on('itin-day', (d) => { day = d || 'all'; filter = 'all'; render(); });
on('itin-person', (id) => { person = +id; day = 'all'; filter = 'all'; who = 'all'; reordering = false; render(); });
on('places', () => isShown() && render());
on('photos', () => isShown() && render());
on('stays', () => isShown() && render());
on('trip', () => isShown() && render());
on('users', () => isShown() && render());
on('subgroups', () => isShown() && render());
on('state', () => isShown() && render());

const isShown = () => !root().hidden;

const FILTERS = [
  ['all', 'All'], ['confirmed', 'Confirmed'], ['maybe', 'Maybe'], ['suggested', 'Suggested'],
  ['visited', 'Visited'], ['missed', 'Missed'], ['vetoed', 'Vetoed'], ['removed', 'Previously interested'],
];
const groupOf = (p) => { const e = effectiveStatus(p); return e === 'skipped' ? 'missed' : e; };

// Where the group sleeps that night
function stayLineHtml(day) {
  const s = (state.stays || []).find((x) => (!x.startDay || x.startDay <= day) && (!x.endDay || x.endDay >= day));
  return s ? `<button class="itin-stay" data-open-stay="${esc(s.id)}">${icon('home', 'small')}<span>Staying at <b>${esc(s.name)}</b></span>${icon('chevron-right', 'small')}</button>` : '';
}

// Picture a day, at the top of a single day: its photos, or an invitation to add one.
function dayStripHtml(day) {
  const list = photosOn(day);
  if (!list.length && !canAddOn(day)) return '';
  return `<div class="itin-photos">
    ${list.map((p) => `<button class="itin-photo" data-view-photo="${p.id}" aria-label="Photo ${esc(p.caption || '')}"><img src="${esc(p.thumb)}" alt="" loading="lazy"></button>`).join('')}
    <button class="itin-photo add" data-open-day-photos="${day}">${icon('camera')}<span>${list.length ? `${list.length} of 5` : 'Add the day’s photo'}</span></button>
  </div>`;
}

export function render() {
  const el = root();
  const days = tripDays();
  const t = today();
  if (day !== 'all' && day !== 'none' && !days.includes(day)) day = 'all';
  const admin = !!state.me?.isAdmin;
  if (filter === 'removed' && !admin) filter = 'all';
  const everything = [...state.places.values()];
  const all = everything.filter((p) => !p.removedAt);
  const dayGroups = day !== 'all' && day !== 'none' ? groupsOn(day) : [];
  if (who !== 'all' && !dayGroups.some((g) => g.id === who)) who = 'all';
  if (person && !userById(person)) person = null;
  const inDay = everything
    .filter((p) => day === 'all' ? true : day === 'none' ? !p.day : p.day === day)
    .filter((p) => who === 'all' || !p.groupId || p.groupId === who)
    .filter((p) => !person || personSees(p, person));
  const counts = { all: inDay.length };
  for (const p of inDay) counts[groupOf(p)] = (counts[groupOf(p)] || 0) + 1;
  const shown = inDay.filter((p) => filter === 'all' ? !p.removedAt : groupOf(p) === filter);
  counts.all = inDay.filter((p) => !p.removedAt).length;
  const perDay = (d) => all.filter((p) => p.day === d && p.status !== 'vetoed').length;
  const tr = state.trip;

  el.innerHTML = `
    <div class="page">
      <header class="page-head">
        ${meButton()}
        <div class="grow"><h1>${esc(tr.name || 'Itinerary')}</h1>
          <div class="sub">${tr.start && tr.end ? `${esc(fmtDay(tr.start, { day: 'numeric', month: 'short' }))} to ${esc(fmtDay(tr.end, { day: 'numeric', month: 'short', year: 'numeric' }))}, ${days.length} days` : `${all.length} places`}</div></div>
        <button class="btn small" data-album aria-label="Trip photos" data-tip="Picture a day: the group’s photos for each day">${icon('camera')}Photos</button>
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
        ${FILTERS.filter(([k]) => k !== 'removed' || admin).map(([k, label]) => `<button class="chip" data-filter="${k}" aria-pressed="${filter === k}">
          ${k !== 'all' ? `<span class="sw" style="--sw:${STATUS[k].color}"></span>` : ''}${label}<span class="n">${counts[k] || 0}</span></button>`).join('')}
      </div>

      ${person ? `<div class="person-banner">${avatar(userById(person))}<span class="grow">Showing <b>${esc(userById(person).name)}</b>’s plan: stops for everyone, plus their subgroup’s.</span>
        <button class="btn small" data-clear-person>Show everyone’s</button></div>` : ''}
      ${dayGroups.length && !person ? `<div class="chips" role="group" aria-label="Whose plan">
        <button class="chip" data-who="all" aria-pressed="${who === 'all'}">${icon('users', 'small')}Everyone</button>
        ${dayGroups.map((g) => `<button class="chip" data-who="${g.id}" aria-pressed="${who === g.id}"><span class="sw" style="--sw:${esc(g.color)}"></span>${esc(g.name)}<span class="n">${g.memberIds.length}</span></button>`).join('')}
        <button class="chip" data-groups>Edit groups</button>
      </div>` : ''}
      ${filter === 'removed' ? `<p class="hint" style="margin:0 16px 12px">Places someone removed. Only admins see this list. Open one to bring it back or delete it for good.</p>` : ''}
      ${day !== 'all' && day !== 'none' ? stayLineHtml(day) + dayStripHtml(day) : ''}
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
    const order = ['confirmed', 'missed', 'visited', 'maybe', 'suggested', 'vetoed', 'removed'];
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
  const stops = day !== 'all' && day !== 'none' ? planStops() : null;
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
    p.groupId && groupById(p.groupId) ? `<span class="group-tag" style="--g:${esc(groupById(p.groupId).color)}">${esc(groupById(p.groupId).name)}</span>` : '',
    p.notes ? `<span>${esc(p.notes.split('\n')[0].slice(0, 40))}</span>` : '',
  ].filter(Boolean).join('');
  return `
    <div class="item ${eff === 'vetoed' ? 'is-vetoed' : ''}" data-id="${p.id}">
      ${lead}
      <button class="item-main" data-open="${p.id}">
        <div class="item-name">${esc(p.name)}</div>
        ${meta || p.address ? `<div class="item-meta">${meta || `<span class="faint">${esc(p.address)}</span>`}</div>` : ''}
      </button>
      ${eff === 'removed' ? '' : reorder ? `<div class="reorder">
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
  el.querySelector('[data-album]').onclick = () => openAlbum();
  el.querySelector('[data-open-stay]')?.addEventListener('click', (e) => { const id = e.currentTarget.dataset.openStay; emit('go', 'map'); import('./stays.js').then((m) => m.openStay(id)); });
  el.querySelectorAll('[data-open-day-photos]').forEach((b) => b.onclick = () => openDayPhotos(b.dataset.openDayPhotos));
  el.querySelectorAll('[data-view-photo]').forEach((b) => b.onclick = () => { const l = photosOn(day); openViewer(l, l.findIndex((p) => p.id === +b.dataset.viewPhoto)); });
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
  el.querySelectorAll('[data-who]').forEach((b) => b.onclick = () => { who = b.dataset.who; reordering = false; render(); });
  el.querySelector('[data-groups]')?.addEventListener('click', () => openGroups());
  el.querySelector('[data-clear-person]')?.addEventListener('click', () => { person = null; render(); });
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
    // Swap with the neighbour shown on screen (other subgroups' stops keep their places)
    const ids = dayStops(day).map((s) => s.place.id);
    const shownIds = planStops().map((s) => s.place.id);
    const k = shownIds.indexOf(id), other = shownIds[k + +b.dataset.move];
    if (k < 0 || !other) return;
    const i = ids.indexOf(id), j = ids.indexOf(other);
    [ids[i], ids[j]] = [ids[j], ids[i]];
    op('place.reorder', { day, ids });
  });
}

// Stops on the selected day's line, as currently filtered (subgroup chip or one person's plan)
function planStops() {
  const s = dayStops(day, who === 'all' ? null : who);
  return person ? s.filter((x) => personSees(x.place, person)) : s;
}

function pickHint(d) { toast(`Open a place and set its day to ${fmtDay(d)}`); }

export function showItinerary() { render(); }
