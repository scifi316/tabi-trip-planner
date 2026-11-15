// Map screen: MapLibre map, place + friend markers, search, controls, and the day "line strip".
import * as maplibregl from '/vendor/maplibre-gl/maplibre-gl.mjs';
import { state, on, emit, api, userById, groupById, groupsOn, myGroupOn, dayStops, defaultDay, tripDays, effectiveStatus, today } from './store.js';
import { openGroups, groupWhere } from './groups.js';
import { $, esc, icon, avatar, initials, STATUS, fmtDay, ago, debounce, toast, closePeekSheets } from './ui.js';
import { openPlace, selectedPlaceId } from './place.js';
import { openAddOne, openImport } from './add.js';
import { myPosition, locateOnce } from './location.js';

let map;
let styleUrl = null;
const placeMarkers = new Map(); // id -> { marker, el, key }
const friendMarkers = new Map();
let meMarker = null;
let stripDay = null;
let stripGroup; // undefined = follow my subgroup for the day; null = everyone; id = a subgroup
function currentGroup() {
  const active = groupsOn(stripDay);
  if (stripGroup === undefined) return myGroupOn(stripDay)?.id ?? null;
  return active.some((g) => g.id === stripGroup) ? stripGroup : null;
}
const JAPAN = [[122.9, 24.0], [146.0, 45.6]];

const LAYER_KEY = 'tabi.layers';
let visible = { confirmed: true, maybe: true, suggested: true, visited: true, missed: true, skipped: true, vetoed: false, removed: false, onlyDay: false, ...JSON.parse(localStorage.getItem(LAYER_KEY) || '{}') };

export function themeStyleUrl() {
  const dark = document.documentElement.dataset.theme === 'dark';
  return dark ? (state.config.styleDark || 'https://tiles.openfreemap.org/styles/dark') : (state.config.styleLight || 'https://tiles.openfreemap.org/styles/liberty');
}

function fallbackStyle() {
  const dark = document.documentElement.dataset.theme === 'dark';
  return { version: 8, sources: {}, layers: [{ id: 'bg', type: 'background', paint: { 'background-color': dark ? '#1D2128' : '#E6E9E4' } }] };
}

// Rewrite label layers to the chosen language.
function applyLabelLanguage() {
  const lang = localStorage.getItem('tabi.labels') || 'both';
  if (lang === 'both' || !map?.isStyleLoaded()) return;
  const expr = lang === 'en'
    ? ['coalesce', ['get', 'name:en'], ['get', 'name_en'], ['get', 'name:latin'], ['get', 'name']]
    : ['coalesce', ['get', 'name:ja'], ['get', 'name:nonlatin'], ['get', 'name']];
  for (const layer of map.getStyle().layers || []) {
    if (layer.type !== 'symbol') continue;
    const tf = map.getLayoutProperty(layer.id, 'text-field');
    if (tf && JSON.stringify(tf).includes('name')) map.setLayoutProperty(layer.id, 'text-field', expr);
  }
}

let usingFallback = false;
export function setMapStyle() {
  if (!map) return;
  const url = themeStyleUrl();
  if (url === styleUrl && !usingFallback) return;
  styleUrl = url;
  usingFallback = false;
  map.setStyle(url, { diff: false });
}

export function initMap() {
  styleUrl = themeStyleUrl();
  map = new maplibregl.Map({
    container: 'map',
    style: styleUrl,
    bounds: JAPAN,
    fitBoundsOptions: { padding: 20 },
    attributionControl: { compact: true },
    maxPitch: 0,
    dragRotate: false,
    localIdeographFontFamily: '"Hiragino Sans", "Noto Sans JP", "Noto Sans CJK JP", "Yu Gothic", sans-serif',
  });
  map.touchZoomRotate.disableRotation();
  map.on('style.load', applyLabelLanguage);
  let warned = false;
  map.on('error', (e) => {
    // Style couldn't load (offline and not cached): show a plain background so markers still work.
    if (!map.isStyleLoaded() && String(e.error?.message || '').match(/style|fetch|Failed/i) && !usingFallback) {
      usingFallback = true;
      map.setStyle(fallbackStyle(), { diff: false });
      if (!warned) { warned = true; toast('Map tiles are not saved for offline use here yet. Pins and friends still show.'); }
    }
  });
  map.on('click', () => { closePeekSheets(); hideLayers(); hideResults(); });

  setupLongPress();
  setupSearch();
  setupControls();

  on('places', () => { renderPlaces(); renderStrip(); });
  on('select', renderPlaces);
  on('locations', renderFriends);
  on('users', renderFriends);
  on('mypos', renderMe);
  on('trip', () => { renderStrip(); renderPlaces(); });
  on('focus-place', (id) => {
    const p = state.places.get(id);
    if (!p) return;
    if (p.day && p.day !== stripDay && tripDays().includes(p.day)) { stripDay = p.day; renderStrip(); renderPlaces(); }
    map.flyTo({ center: [p.lng, p.lat], zoom: Math.max(map.getZoom(), 15), padding: padding(), duration: 700 });
    setTimeout(() => openPlace(id), 50);
  });
  on('fit-all', fitAll);
  on('strip-day', (d) => { if (d !== stripDay) stripGroup = undefined; stripDay = d; renderStrip(); renderPlaces(); renderFriends(); });
  on('subgroups', () => { renderStrip(); renderPlaces(); renderFriends(); });
  on('focus-group', (id) => {
    const g = groupById(id);
    if (!g) return;
    if (groupsOn(stripDay).includes(g)) { stripGroup = id; renderStrip(); renderPlaces(); }
    const { locs } = groupWhere(g);
    if (!locs.length) return toast(`Nobody in ${g.name} is sharing their location right now.`);
    if (locs.length === 1) return map.flyTo({ center: [locs[0].lng, locs[0].lat], zoom: 15, padding: padding() });
    const b = new maplibregl.LngLatBounds();
    locs.forEach((l) => b.extend([l.lng, l.lat]));
    map.fitBounds(b, { padding: padding(), maxZoom: 16 });
  });
  on('labels', () => { usingFallback = false; map.setStyle(styleUrl, { diff: false }); });

  let firstFit = true;
  on('state', () => {
    if (!stripDay) stripDay = defaultDay();
    renderStrip(); renderPlaces(); renderFriends();
    if (firstFit) { firstFit = false; fitAll({ animate: false }); }
  });
  stripDay = defaultDay();
  renderStrip(); renderPlaces(); renderFriends();
  if (state.places.size) { firstFit = false; map.once('load', () => fitAll({ animate: false })); }
  setInterval(renderFriends, 30000);
  return map;
}

export function resizeMap() { map?.resize(); }

function padding() {
  const stripH = $('#line-strip')?.offsetHeight || 0;
  const bottom = (document.querySelector('.app.nav-collapsed') ? 60 : 70) + stripH + 20;
  return { top: 120, bottom: Math.min(bottom, innerHeight / 2), left: 30, right: 70 };
}

function fitAll({ animate = true } = {}) {
  const pts = [...state.places.values()].filter(isVisible);
  if (!pts.length) return;
  if (pts.length === 1) return map.jumpTo({ center: [pts[0].lng, pts[0].lat], zoom: 14 });
  const b = new maplibregl.LngLatBounds();
  pts.forEach((p) => b.extend([p.lng, p.lat]));
  map.fitBounds(b, { padding: padding(), maxZoom: 15, animate });
}

// ---------- places ----------
function isVisible(p) {
  const eff = effectiveStatus(p);
  if (eff === 'removed') return !!(visible.removed && state.me?.isAdmin);
  if (!visible[eff]) return false;
  if (visible.onlyDay && p.day !== stripDay) return false;
  return true;
}

function renderPlaces() {
  if (!map) return;
  const stops = stripDay ? dayStops(stripDay, currentGroup()) : [];
  const stationNo = new Map(stops.map((s, i) => [s.place.id, i + 1]));
  const nextId = stops.find((s) => s.state === 'todo')?.place.id;
  const sel = selectedPlaceId();
  const seen = new Set();

  for (const p of state.places.values()) {
    if (!isVisible(p) && !stationNo.has(p.id)) continue;
    seen.add(p.id);
    const eff = effectiveStatus(p);
    const n = stationNo.get(p.id);
    const stopState = n ? stops[n - 1].state : null;
    const ring = p.groupId ? groupById(p.groupId)?.color : null;
    const key = [n, stopState, eff, p.id === sel, p.id === nextId, p.lat, p.lng, p.name, ring].join('|');
    let m = placeMarkers.get(p.id);
    if (m && m.key === key) continue;
    if (!m) {
      const el = document.createElement('button');
      el.setAttribute('type', 'button');
      el.addEventListener('click', (e) => { e.stopPropagation(); openPlace(p.id); });
      const marker = new maplibregl.Marker({ element: el, anchor: 'center' }).setLngLat([p.lng, p.lat]).addTo(map);
      m = { marker, el };
      placeMarkers.set(p.id, m);
    }
    m.key = key;
    m.marker.setLngLat([p.lng, p.lat]);
    const el = m.el;
    el.setAttribute('aria-label', `${p.name}, ${STATUS[eff].label}`);
    el.title = p.name;
    if (n) {
      el.className = `station sm ${p.id === sel ? 'selected' : ''}`;
      el.dataset.state = p.id === nextId ? 'next' : stopState === 'todo' ? '' : stopState;
      el.textContent = n;
      el.style.zIndex = 3;
      if (ring) el.style.setProperty('--ring', ring); else el.style.removeProperty('--ring');
    } else {
      el.className = `place-dot ${p.id === sel ? 'selected' : ''}`;
      el.dataset.status = eff;
      el.textContent = '';
      el.style.setProperty('--dot', STATUS[eff].color);
      el.style.zIndex = p.id === sel ? 4 : 1;
    }
  }
  for (const [id, m] of placeMarkers) if (!seen.has(id)) { m.marker.remove(); placeMarkers.delete(id); }
}

// ---------- friends ----------
function renderFriends() {
  if (!map) return;
  const row = $('#friend-row');
  const chips = [];
  const seen = new Set();
  const dayGroups = groupsOn(stripDay || today());
  const groupOf = (id) => dayGroups.find((g) => g.memberIds.includes(+id));
  for (const g of dayGroups) {
    chips.push(`<button class="friend-chip group-chip" data-group="${g.id}" style="--g:${esc(g.color)}" aria-pressed="${currentGroup() === g.id}"><span class="group-dot"></span><span>${esc(g.name)}</span><span class="age num">${g.memberIds.length}</span></button>`);
  }
  for (const [uid, loc] of Object.entries(state.locations)) {
    const u = userById(uid);
    if (!u || u.id === state.me?.id) continue;
    seen.add(u.id);
    const stale = Date.now() - loc.ts > 15 * 60e3;
    let fm = friendMarkers.get(u.id);
    if (!fm) {
      const el = document.createElement('div');
      el.className = 'friend-marker';
      el.addEventListener('click', (e) => { e.stopPropagation(); friendInfo(u.id); });
      fm = { el, marker: new maplibregl.Marker({ element: el, anchor: 'bottom' }).setLngLat([loc.lng, loc.lat]).addTo(map) };
      friendMarkers.set(u.id, fm);
    }
    fm.marker.setLngLat([loc.lng, loc.lat]);
    fm.el.classList.toggle('stale', stale);
    const ug = groupOf(u.id);
    fm.el.innerHTML = `<div class="bubble" style="background:${esc(u.color)}${ug ? `;border-color:${esc(ug.color)}` : ''}">${esc(initials(u.name))}</div><div class="tail"></div><div class="label">${esc(u.name)}${stale ? ` <span class="faint">${ago(loc.ts)}</span>` : ''}</div>`;
    chips.push(`<button class="friend-chip ${stale ? 'stale' : ''}" data-friend="${u.id}">${avatar(u)}<span>${esc(u.name)}</span><span class="age">${ago(loc.ts)}</span></button>`);
  }
  for (const [id, fm] of friendMarkers) if (!seen.has(id)) { fm.marker.remove(); friendMarkers.delete(id); }
  chips.push(`<button class="friend-chip" data-groups aria-label="Subgroups">${icon('users', 'small')}<span>${dayGroups.length ? 'Groups' : 'Split up'}</span></button>`);
  row.innerHTML = chips.join('');
  row.querySelector('[data-groups]').onclick = () => openGroups();
  row.querySelectorAll('[data-group]').forEach((b) => b.onclick = () => emit('focus-group', b.dataset.group));
  row.querySelectorAll('[data-friend]').forEach((b) => b.onclick = () => {
    const loc = state.locations[b.dataset.friend];
    if (loc) map.flyTo({ center: [loc.lng, loc.lat], zoom: Math.max(map.getZoom(), 15), duration: 700 });
  });
}

function friendInfo(uid) {
  const u = userById(uid), loc = state.locations[uid];
  if (!u || !loc) return;
  const bits = [`Updated ${ago(loc.ts)}`];
  if (loc.acc) bits.push(`within ${Math.round(loc.acc)} m`);
  if (loc.batt != null) bits.push(`battery ${loc.batt}%`);
  toast(`${u.name}: ${bits.join(', ')}`, { action: 'Directions', onAction: () => open(`https://www.google.com/maps/dir/?api=1&destination=${loc.lat},${loc.lng}&travelmode=walking`, '_blank') });
}

function renderMe() {
  const pos = myPosition();
  if (!map || !pos) return;
  if (!meMarker) {
    const el = document.createElement('div');
    el.className = 'me-dot';
    el.title = 'You';
    meMarker = new maplibregl.Marker({ element: el }).setLngLat([pos.lng, pos.lat]).addTo(map);
  }
  meMarker.setLngLat([pos.lng, pos.lat]);
}

// ---------- line strip ----------
export function renderStrip() {
  const el = $('#line-strip');
  const days = tripDays();
  if (!days.length) {
    el.innerHTML = `<div class="strip-empty">Set your trip dates in Settings, or <button data-add>add places</button> to start planning.</div>`;
    el.querySelector('[data-add]').onclick = () => openImport();
    setStripHeight();
    return;
  }
  if (!stripDay || !days.includes(stripDay)) stripDay = defaultDay();
  const i = days.indexOf(stripDay);
  const gid = currentGroup();
  const grp = gid ? groupById(gid) : null;
  const dayGroups = groupsOn(stripDay);
  const stops = dayStops(stripDay, gid);
  const t = today();
  const left = stops.filter((s) => s.state === 'todo').length;
  const done = stops.filter((s) => s.state === 'visited').length;
  const nextIdx = stops.findIndex((s) => s.state === 'todo');
  const dayNo = days.indexOf(stripDay) + 1;
  const label = stripDay === t ? 'Today' : fmtDay(stripDay, { weekday: 'short', day: 'numeric', month: 'short' });
  const leftText = !stops.length ? '' : stripDay < t ? (left ? `<b>${left}</b> missed` : 'Day done')
    : left === 0 ? 'All done' : `<b class="num">${left}</b> ${left === 1 ? 'stop' : 'stops'} left`;

  // progress: line coloured through the last visited/skipped stop before the next one
  let lastDone = -1;
  stops.forEach((s, k) => { if (s.state !== 'todo' && (nextIdx === -1 || k < nextIdx)) lastDone = k; });

  el.innerHTML = `
    <div class="strip-head">
      <button class="icon-btn small" data-prev aria-label="Previous day" ${i <= 0 ? 'disabled' : ''}>${icon('chevron-left')}</button>
      <button class="strip-day" data-itin aria-label="Open this day in the itinerary"><b>${esc(label)}</b><span>${dayGroups.length ? `Day ${dayNo}` : `Day ${dayNo} of ${days.length}`}</span></button>
      ${dayGroups.length ? `<button class="strip-group" data-pick-group style="--g:${esc(grp?.color || 'var(--ink-3)')}" aria-label="Whose stops to show">${grp ? esc(grp.name) : 'Everyone'}</button>` : ''}
      <span class="strip-left">${leftText}</span>
      <button class="icon-btn small" data-next aria-label="Next day" ${i >= days.length - 1 ? 'disabled' : ''}>${icon('chevron-right')}</button>
    </div>
    ${stops.length ? `
    <div class="rail"><div class="rail-inner" style="min-width:${Math.max(stops.length * 38, 0)}px">
      <div class="rail-track"></div><div class="rail-done"></div>
      ${stops.map((s, k) => `<button class="rail-stop" data-id="${s.place.id}" data-state="${k === nextIdx && stripDay >= t ? 'next' : s.state}"
          aria-label="${k + 1}. ${esc(s.place.name)}, ${s.state === 'todo' ? 'to visit' : s.state}" title="${esc(s.place.name)}">
          <span class="station sm" data-state="${s.state === 'todo' ? (k === nextIdx ? 'next' : '') : s.state}" ${s.place.groupId && groupById(s.place.groupId) ? `style="--ring:${esc(groupById(s.place.groupId).color)}"` : ''}>${s.state === 'visited' ? '✓' : k + 1}</span></button>`).join('')}
    </div></div>` : `<div class="strip-empty">No confirmed stops for this day yet. <button data-plan>Plan it</button></div>`}`;

  el.querySelector('[data-prev]').onclick = () => emit('strip-day', days[i - 1]);
  el.querySelector('[data-next]').onclick = () => emit('strip-day', days[i + 1]);
  el.querySelector('[data-itin]').onclick = () => { emit('itin-day', stripDay); emit('go', 'itinerary'); };
  el.querySelector('[data-plan]')?.addEventListener('click', () => { emit('itin-day', stripDay); emit('go', 'itinerary'); });
  el.querySelectorAll('.rail-stop').forEach((b) => b.onclick = () => emit('focus-place', b.dataset.id));
  el.querySelector('[data-pick-group]')?.addEventListener('click', () => {
    // Cycle: everyone, then each subgroup active that day
    const order = [null, ...dayGroups.map((g) => g.id)];
    stripGroup = order[(order.indexOf(gid) + 1) % order.length];
    renderStrip(); renderPlaces(); renderFriends();
  });

  // size the "done" part of the rail
  requestAnimationFrame(() => {
    const doneEl = el.querySelector('.rail-done');
    if (!doneEl) return;
    const btns = el.querySelectorAll('.rail-stop');
    if (lastDone < 0 || !btns[lastDone]) { doneEl.style.width = '0'; return; }
    const r0 = el.querySelector('.rail-inner').getBoundingClientRect();
    const rb = btns[lastDone].getBoundingClientRect();
    doneEl.style.width = `${Math.max(0, rb.left + rb.width / 2 - r0.left - 14)}px`;
  });
  setStripHeight();
}

function setStripHeight() {
  const el = $('#line-strip');
  requestAnimationFrame(() => document.documentElement.style.setProperty('--strip-h', `${el.offsetHeight + 8}px`));
}

// ---------- long press to drop a pin ----------
function setupLongPress() {
  let timer = null, start = null;
  const cancel = () => { clearTimeout(timer); timer = null; };
  const drop = async (lngLat) => {
    const item = { name: '', lat: lngLat.lat, lng: lngLat.lng };
    navigator.vibrate?.(15);
    const sheet = openAddOne({ ...item, name: 'Dropped pin' });
    try {
      const { result } = await api(`/api/reverse?lat=${item.lat}&lng=${item.lng}`);
      if (result && !sheet.closed) {
        const nameInput = sheet.el.querySelector('[data-name]');
        if (nameInput && (nameInput.value === 'Dropped pin' || !nameInput.value)) nameInput.value = result.name;
        const sub = sheet.el.querySelector('.sheet-head .sub');
        if (sub && result.address) sub.textContent = result.address;
      }
    } catch { /* offline: keep the plain pin */ }
  };
  map.on('touchstart', (e) => {
    if (e.originalEvent.touches.length !== 1) return cancel();
    start = e.point;
    const ll = e.lngLat;
    timer = setTimeout(() => { timer = null; drop(ll); }, 550);
  });
  map.on('touchmove', (e) => { if (timer && start && (Math.abs(e.point.x - start.x) > 10 || Math.abs(e.point.y - start.y) > 10)) cancel(); });
  map.on('touchend', cancel);
  map.on('touchcancel', cancel);
  map.on('movestart', (e) => { if (e.originalEvent) cancel(); });
  map.on('contextmenu', (e) => { if (!('ontouchstart' in window)) drop(e.lngLat); });
}

// ---------- search ----------
function hideResults() { $('#search-results').hidden = true; }
function setupSearch() {
  const input = $('#search-input'), box = $('#search-results'), clear = $('#search-clear');
  let seq = 0;
  const run = debounce(async () => {
    const q = input.value.trim();
    const my = ++seq;
    if (q.length < 2) { box.hidden = true; return; }
    if (/^(https?:\/\/|geo:)/i.test(q) || /^-?\d+\.\d+\s*,\s*-?\d+\.\d+$/.test(q)) {
      box.hidden = false;
      box.innerHTML = `<div class="results-empty">Looking up that link…</div>`;
      try {
        const { results } = await api('/api/resolve', { method: 'POST', body: { text: q } });
        if (my !== seq) return;
        const r = results[0];
        if (r?.myMaps) { box.hidden = true; input.value = ''; const s = openImport('mymaps'); s.el.querySelector('[data-url]').value = q; return; }
        if (!r?.ok) { box.innerHTML = `<div class="results-empty">No location found in that link. Try opening it in Google Maps and sharing again.</div>`; return; }
        box.hidden = true; input.value = ''; clear.hidden = true;
        map.flyTo({ center: [r.lng, r.lat], zoom: 15, padding: padding() });
        openAddOne({ name: r.name || 'Shared place', lat: r.lat, lng: r.lng, address: r.address, url: r.url, approximate: r.approximate });
      } catch (e) { box.innerHTML = `<div class="results-empty">${esc(e.message)}</div>`; }
      return;
    }
    const ql = q.toLowerCase();
    const local = [...state.places.values()].filter((p) => !p.removedAt).filter((p) => p.name.toLowerCase().includes(ql) || (p.notes || '').toLowerCase().includes(ql)).slice(0, 5);
    const renderLocal = () => local.length ? `<div class="results-label">In your trip</div>${local.map((p) => `
      <button class="result" data-local="${p.id}"><span class="place-dot" style="--dot:${STATUS[effectiveStatus(p)].color};flex:none"></span>
      <span class="result-body"><div class="result-name">${esc(p.name)}</div><div class="result-sub">${esc(STATUS[effectiveStatus(p)].label)}${p.day ? `, ${esc(fmtDay(p.day))}` : ''}</div></span></button>`).join('')}` : '';
    box.hidden = false;
    box.innerHTML = renderLocal() + `<div class="results-empty">Searching Japan…</div>`;
    bindResults([]);
    try {
      const c = map.getCenter();
      const { results } = await api(`/api/search?q=${encodeURIComponent(q)}&lat=${c.lat}&lng=${c.lng}&lang=${localStorage.getItem('tabi.labels') === 'ja' ? 'ja' : 'en'}`);
      if (my !== seq) return;
      box.innerHTML = renderLocal() + (results.length ? `<div class="results-label">Places in Japan</div>${results.map((r, i) => `
        <button class="result" data-remote="${i}">${icon('pin')}<span class="result-body"><div class="result-name">${esc(r.name)}</div><div class="result-sub">${esc(r.address || r.kind || '')}</div></span></button>`).join('')}`
        : `<div class="results-empty">No matches in Japan. Try the Japanese name, or paste a Google Maps link.</div>`);
      bindResults(results);
    } catch (e) {
      if (my !== seq) return;
      box.innerHTML = renderLocal() + `<div class="results-empty">${esc(e.message)}</div>`;
      bindResults([]);
    }
  }, 300);

  function bindResults(results) {
    box.querySelectorAll('[data-local]').forEach((b) => b.onclick = () => { box.hidden = true; input.blur(); emit('focus-place', b.dataset.local); });
    box.querySelectorAll('[data-remote]').forEach((b) => b.onclick = () => {
      const r = results[+b.dataset.remote];
      box.hidden = true; input.blur();
      map.flyTo({ center: [r.lng, r.lat], zoom: 16, padding: padding() });
      openAddOne(r, { defaultDay: '' });
    });
  }
  input.addEventListener('input', () => { clear.hidden = !input.value; run(); });
  input.addEventListener('focus', () => { if (input.value.trim().length >= 2) run(); });
  input.addEventListener('paste', () => setTimeout(run, 0));
  clear.onclick = () => { input.value = ''; clear.hidden = true; box.hidden = true; input.focus(); };
}

// ---------- controls ----------
function hideLayers() { $('#layers-pop').hidden = true; $('#ctl-layers').setAttribute('aria-expanded', 'false'); }
function setupControls() {
  $('#ctl-locate').onclick = async () => {
    try {
      const pos = await locateOnce();
      map.flyTo({ center: [pos.lng, pos.lat], zoom: Math.max(map.getZoom(), 15), duration: 700 });
    } catch (e) { toast(e.message); }
  };
  $('#ctl-fit').onclick = () => fitAll();
  $('#fab-add').onclick = () => openImport();
  const pop = $('#layers-pop');
  $('#ctl-layers').onclick = (e) => {
    e.stopPropagation();
    if (!pop.hidden) return hideLayers();
    const rows = ['confirmed', 'maybe', 'suggested', 'visited', 'missed', 'skipped', 'vetoed', ...(state.me?.isAdmin ? ['removed'] : [])];
    pop.innerHTML = `<h4>Show on map</h4>${rows.map((s) => `
      <label class="check-row"><input type="checkbox" data-s="${s}" ${visible[s] ? 'checked' : ''}><span class="place-dot" style="--dot:${STATUS[s].color};width:12px;height:12px;border-width:2px"></span>${STATUS[s].label}</label>`).join('')}
      <label class="check-row" style="border-top:1px solid var(--line);margin-top:4px;padding-top:10px"><input type="checkbox" data-s="onlyDay" ${visible.onlyDay ? 'checked' : ''}>Only the selected day</label>`;
    pop.hidden = false;
    $('#ctl-layers').setAttribute('aria-expanded', 'true');
    pop.querySelectorAll('[data-s]').forEach((c) => c.onchange = () => {
      visible[c.dataset.s] = c.checked;
      localStorage.setItem(LAYER_KEY, JSON.stringify(visible));
      renderPlaces();
    });
  };
  document.addEventListener('click', (e) => { if (!pop.hidden && !pop.contains(e.target) && e.target !== $('#ctl-layers')) hideLayers(); });
}

export function getMap() { return map; }
