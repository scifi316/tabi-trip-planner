// Map screen: MapLibre map, place + friend markers, search, controls, and the day "line strip".
import * as maplibregl from '/vendor/maplibre-gl/maplibre-gl.mjs';
import { state, on, emit, api, userById, groupById, groupsOn, myGroupOn, dayStops, defaultDay, tripDays, effectiveStatus, today } from './store.js';
import { openGroups, groupWhere } from './groups.js';
import { openFriends, openFriend } from './friends.js';
import { $, esc, icon, avatar, initials, STATUS, fmtDay, ago, debounce, toast, closePeekSheets, openSheet } from './ui.js';
import { openPlace, selectedPlaceId } from './place.js';
import { openAddOne, openImport } from './add.js';
import { myPosition, locateOnce, setFollowGps } from './location.js';

let map;
let styleUrl = null;
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
    attributionControl: false, // added bottom-left below, clear of the Add button
    maxPitch: 0,
    dragRotate: false,
    localIdeographFontFamily: '"Hiragino Sans", "Noto Sans JP", "Noto Sans CJK JP", "Yu Gothic", sans-serif',
  });
  map.touchZoomRotate.disableRotation();
  map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-left');
  map.on('style.load', () => { applyLabelLanguage(); drawAccuracy(); ensurePlaceSource(); syncSoon(); });
  // Keep cluster markers in step with the map: during moves (throttled), when it settles, and when
  // the clustered source finishes updating.
  map.on('render', () => { if (performance.now() - lastSync > 90) syncClusters(); });
  map.on('moveend', syncSoon);
  map.on('zoom', () => { if (stationsShown !== null && (map.getZoom() >= STATION_MIN_ZOOM) !== stationsShown) renderPlaces(); });
  map.on('sourcedata', (e) => { if (e.sourceId === PLACE_SRC && e.isSourceLoaded) syncSoon(); });
  let warned = false;
  const useFallback = () => {
    if (usingFallback || map.isStyleLoaded()) return;
    usingFallback = true;
    map.setStyle(fallbackStyle(), { diff: false });
    if (!warned) { warned = true; toast('Map tiles are not saved for offline use here yet. Pins and friends still show.'); }
  };
  map.on('error', (e) => {
    // Style couldn't load (offline and not cached): show a plain background so markers still work.
    if (!map.isStyleLoaded() && String(e.error?.message || '').match(/style|fetch|Failed|Offline|50\d/i)) useFallback();
  });
  // A style request can also just hang (captive Wi-Fi, a very weak signal) without an error.
  setTimeout(useFallback, 12000);
  map.on('click', () => { closePeekSheets(); hideLayers(); hideResults(); if (accCircle) { accCircle = null; drawAccuracy(); } });

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
  on('focus-friend', focusFriend);
  on('follow-friend', (id) => startFollow({ kind: 'friend', id: +id }, { fly: false }));
  on('stop-follow', stopFollow);
  on('mypos', () => { if (follow?.kind === 'me') keepFollowing(); });
  // Moving the map yourself ends following (zooming doesn't)
  map.on('dragstart', (e) => { if (e.originalEvent) stopFollow(); });
  on('focus-place', stopFollow);
  on('fit-friends', fitFriends);
  on('locations', () => {
    if (follow?.kind === 'friend') { if (!state.locations[follow.id]) stopFollow(); else keepFollowing(); }
    if (!accCircle) return;
    const l = state.locations[accCircle.userId];
    if (!l) accCircle = null; else Object.assign(accCircle, { lng: l.lng, lat: l.lat, acc: l.acc || 0 }); // follow them as they move
    drawAccuracy();
  });
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

// fitBounds adds its padding to whatever padding the map kept from the last camera move (pinpointing a
// friend, opening a place). On a phone the two together left no room, so "fit" landed somewhere odd.
// absolutePadding makes our padding the only one.
function fitTo(bounds, opts = {}) {
  map.fitBounds(bounds, { padding: padding(), absolutePadding: true, ...opts });
}

function fitAll({ animate = true } = {}) {
  const pts = [...state.places.values()].filter(isVisible);
  if (!pts.length) return;
  if (pts.length === 1) return map.jumpTo({ center: [pts[0].lng, pts[0].lat], zoom: 14 });
  const b = new maplibregl.LngLatBounds();
  pts.forEach((p) => b.extend([p.lng, p.lat]));
  stopFollow();
  fitTo(b, { maxZoom: 15, animate });
}

// ---------- places ----------
function isVisible(p) {
  const eff = effectiveStatus(p);
  if (eff === 'removed') return !!(visible.removed && state.me?.isAdmin);
  if (!visible[eff]) return false;
  if (visible.onlyDay && p.day !== stripDay) return false;
  return true;
}

// Places are drawn in two ways:
//  • "pinned" places — the day's numbered stops and whatever place is open — are always their own marker;
//  • everything else goes into a clustered GeoJSON source. MapLibre groups nearby points as you zoom
//    out, and we draw one HTML marker per visible dot or cluster (re-synced as the map moves).
// Marker elements are plain wrappers: MapLibre positions them with a CSS transform, so all styling
// (sizes, scale on select, transitions) lives on the inner element. Styling the wrapper itself made
// dots slide behind the map while zooming.
const PLACE_SRC = 'places';
const STATUS_KEYS = Object.keys(STATUS);
let placeData = { type: 'FeatureCollection', features: [] };
const pinnedMarkers = new Map(); // place id -> { marker, el, key }
const dotMarkers = new Map();    // place id -> { marker, el, key }
const clusterMarkers = new Map(); // 'c<cluster id>' -> { marker, el, key }
// Zoomed out past city level, the day's numbered stops join the clusters too, so their badges don't
// sit on top of (and steal taps from) a cluster. They come back as badges when you zoom into a city.
const STATION_MIN_ZOOM = 11;
let stationsShown = null;

function makeMarker(lngLat, onClick, anchor = 'center') {
  const wrap = document.createElement('div');
  wrap.className = 'mk';
  const el = document.createElement('button');
  el.type = 'button';
  wrap.appendChild(el);
  el.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
  const marker = new maplibregl.Marker({ element: wrap, anchor }).setLngLat(lngLat).addTo(map);
  return { marker, el, wrap };
}

// Called on every style load (a theme switch replaces the style) and whenever places change.
// Before the first style has loaded MapLibre refuses new sources; that's fine, style.load retries.
function ensurePlaceSource() {
  try {
    if (!map || map.getSource(PLACE_SRC)) return;
  } catch { return; }
  try { addPlaceSource(); } catch { /* style not ready yet */ }
}
function addPlaceSource() {
  map.addSource(PLACE_SRC, {
    type: 'geojson', data: placeData, cluster: true, clusterRadius: 46, clusterMaxZoom: 15,
    // count each status inside a cluster, for the coloured ring
    clusterProperties: Object.fromEntries(STATUS_KEYS.map((k) => [k, ['+', ['case', ['==', ['get', 's'], k], 1, 0]]])),
  });
  // An invisible layer, so MapLibre builds the cluster tiles we read markers from.
  map.addLayer({ id: 'places-index', type: 'circle', source: PLACE_SRC, paint: { 'circle-radius': 0, 'circle-opacity': 0 } });
}

function renderPlaces() {
  if (!map) return;
  const stops = stripDay ? dayStops(stripDay, currentGroup()) : [];
  stationsShown = map.getZoom() >= STATION_MIN_ZOOM;
  const stationNo = new Map(stationsShown ? stops.map((s, i) => [s.place.id, i + 1]) : []);
  const onDay = new Set(stops.map((s) => s.place.id));
  const nextId = stops.find((s) => s.state === 'todo')?.place.id;
  const sel = selectedPlaceId();
  const pinned = new Set();
  const features = [];

  for (const p of state.places.values()) {
    const n = stationNo.get(p.id);
    if (!isVisible(p) && !n && !onDay.has(p.id)) continue;
    const eff = effectiveStatus(p);
    if (!n && p.id !== sel) {
      features.push({ type: 'Feature', id: features.length, geometry: { type: 'Point', coordinates: [p.lng, p.lat] }, properties: { id: p.id, s: eff } });
      continue;
    }
    pinned.add(p.id);
    const stopState = n ? stops[n - 1].state : null;
    const ring = p.groupId ? groupById(p.groupId)?.color : null;
    const key = [n, stopState, eff, p.id === sel, p.id === nextId, p.lat, p.lng, p.name, ring].join('|');
    let m = pinnedMarkers.get(p.id);
    if (m && m.key === key) continue;
    if (!m) { m = makeMarker([p.lng, p.lat], () => openPlace(p.id)); pinnedMarkers.set(p.id, m); }
    m.key = key;
    m.marker.setLngLat([p.lng, p.lat]);
    const el = m.el;
    el.dataset.pid = p.id;
    el.setAttribute('aria-label', `${p.name}, ${STATUS[eff].label}`);
    el.title = p.name;
    if (n) {
      el.className = `station sm ${p.id === sel ? 'selected' : ''}`;
      el.dataset.state = p.id === nextId ? 'next' : stopState === 'todo' ? '' : stopState;
      el.textContent = n;
      m.wrap.style.zIndex = p.id === sel ? 5 : 3;
      if (ring) el.style.setProperty('--ring', ring); else el.style.removeProperty('--ring');
    } else {
      dotStyle(el, p, eff, true);
      m.wrap.style.zIndex = 5;
    }
  }
  for (const [id, m] of pinnedMarkers) if (!pinned.has(id)) { m.marker.remove(); pinnedMarkers.delete(id); }

  placeData = { type: 'FeatureCollection', features };
  ensurePlaceSource();
  map.getSource(PLACE_SRC)?.setData(placeData);
  // A pinned place may have just left a cluster (or joined one): resync once the source has updated.
  syncSoon();
}

function dotStyle(el, p, eff, selected) {
  el.className = `place-dot ${selected ? 'selected' : ''}`;
  el.dataset.pid = p.id;
  el.dataset.status = eff;
  el.textContent = '';
  el.style.setProperty('--dot', STATUS[eff].color);
  el.setAttribute('aria-label', `${p.name}, ${STATUS[eff].label}`);
  el.title = p.name;
}

// Draw a marker for each dot and cluster MapLibre currently shows.
let syncTimer = 0, lastSync = 0;
function syncSoon() { clearTimeout(syncTimer); syncTimer = setTimeout(syncClusters, 30); }
function syncClusters() {
  lastSync = performance.now();
  if (!map) return;
  let ready = false;
  try { ready = !!map.getSource(PLACE_SRC) && map.isSourceLoaded(PLACE_SRC); } catch { /* no style yet */ }
  // Until the map style has loaded there's nothing to cluster with: show every place as a plain dot.
  const feats = ready ? map.querySourceFeatures(PLACE_SRC) : placeData.features;
  const seenDots = new Set(), seenClusters = new Set();
  for (const f of feats) {
    const pr = f.properties;
    const ll = f.geometry.coordinates;
    if (pr.cluster) {
      const k = `c${pr.cluster_id}`;
      if (seenClusters.has(k)) continue;
      seenClusters.add(k);
      const count = pr.point_count;
      const key = [count, ll[0], ll[1], ...STATUS_KEYS.map((s) => pr[s] || 0)].join('|');
      let m = clusterMarkers.get(k);
      if (!m) { const id = pr.cluster_id; m = makeMarker(ll, () => openCluster(id, ll)); clusterMarkers.set(k, m); }
      if (m.key !== key) {
        m.key = key;
        m.marker.setLngLat(ll);
        const el = m.el;
        el.className = `cluster ${count >= 50 ? 'xl' : count >= 10 ? 'l' : ''}`;
        el.dataset.count = count;
        el.style.setProperty('--ring', clusterRing(pr, count));
        el.innerHTML = `<span class="num">${count}</span>`;
        el.setAttribute('aria-label', `${count} places here. Zoom in to see them.`);
        el.title = `${count} places`;
        m.wrap.style.zIndex = 2;
      }
    } else {
      if (seenDots.has(pr.id)) continue;
      const p = state.places.get(pr.id);
      if (!p) continue;
      seenDots.add(pr.id);
      // exact position from the place itself (tile geometry is slightly rounded)
      const at = [p.lng, p.lat];
      let m = dotMarkers.get(pr.id);
      if (!m) { m = makeMarker(at, () => openPlace(pr.id)); dotMarkers.set(pr.id, m); }
      const key = [pr.s, p.lng, p.lat, p.name].join('|');
      if (m.key !== key) { m.key = key; m.marker.setLngLat(at); dotStyle(m.el, p, pr.s, false); m.wrap.style.zIndex = 1; }
    }
  }
  for (const [k, m] of dotMarkers) if (!seenDots.has(k)) { m.marker.remove(); dotMarkers.delete(k); }
  for (const [k, m] of clusterMarkers) if (!seenClusters.has(k)) { m.marker.remove(); clusterMarkers.delete(k); }
}

// A ring split by status, in the same colours as the dots.
function clusterRing(pr, count) {
  let at = 0;
  const parts = [];
  for (const s of STATUS_KEYS) {
    const n = pr[s] || 0;
    if (!n) continue;
    const from = (at / count) * 360, to = ((at + n) / count) * 360;
    parts.push(`${STATUS[s].color} ${from}deg ${to}deg`);
    at += n;
  }
  return `conic-gradient(${parts.join(', ') || 'var(--ink-3) 0 360deg'})`;
}

// Tap a cluster: zoom to fit everything in it. If they're all on the same spot, list them instead.
async function openCluster(clusterId, ll) {
  const src = map.getSource(PLACE_SRC);
  let leaves = [];
  try { leaves = await src.getClusterLeaves(clusterId, Infinity, 0); } catch { /* cluster changed while zooming */ }
  if (!leaves.length) return map.easeTo({ center: ll, zoom: map.getZoom() + 2, padding: padding() });
  const b = new maplibregl.LngLatBounds();
  leaves.forEach((f) => b.extend(f.geometry.coordinates));
  const sw = b.getSouthWest(), ne = b.getNorthEast();
  if (Math.abs(ne.lat - sw.lat) < 2e-4 && Math.abs(ne.lng - sw.lng) < 2e-4) {
    return openSpotList(leaves.map((f) => state.places.get(f.properties.id)).filter(Boolean), ll);
  }
  closePeekSheets();
  fitTo(b, { maxZoom: 17, duration: 650 });
}

function openSpotList(places, ll) {
  map.easeTo({ center: ll, zoom: Math.max(map.getZoom(), 16), padding: padding() });
  const s = openSheet({
    title: `${places.length} places at this spot`,
    peek: true,
    body: `<div class="spot-list">${places.map((p) => {
      const eff = effectiveStatus(p);
      return `<button class="spot-row" data-spot="${esc(p.id)}"><span class="place-dot static" style="--dot:${STATUS[eff].color}"></span>
        <span class="grow"><b>${esc(p.name)}</b><span class="help">${esc(STATUS[eff].label)}</span></span>${icon('chevron-right', 'small')}</button>`;
    }).join('')}</div>`,
  });
  s.el.querySelectorAll('[data-spot]').forEach((b) => b.onclick = () => { s.close(); openPlace(b.dataset.spot); });
}

// ---------- friends ----------
function renderFriends() {
  if (!map) return;
  const row = $('#friend-row');
  const chips = [];
  const seen = new Set();
  const dayGroups = groupsOn(stripDay || today());
  const groupOf = (id) => dayGroups.find((g) => g.memberIds.includes(+id));
  const others = state.users.filter((u) => u.id !== state.me?.id);
  const liveCount = others.filter((u) => state.locations[u.id] && Date.now() - state.locations[u.id].ts < 15 * 60e3).length;
  if (others.length) chips.push(`<button class="friend-chip friends-btn" data-friends aria-label="Friends: ${liveCount} sharing live" data-tip="Friends: where everyone is, their plans, and money between you">${icon('users', 'small')}<span>Friends</span>${liveCount ? `<span class="age num">${liveCount} live</span>` : ''}</button>`);
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
      el.addEventListener('click', (e) => { e.stopPropagation(); openFriend(u.id, { follow: true }); });
      fm = { el, marker: new maplibregl.Marker({ element: el, anchor: 'bottom' }).setLngLat([loc.lng, loc.lat]).addTo(map) };
      friendMarkers.set(u.id, fm);
    }
    fm.marker.setLngLat([loc.lng, loc.lat]);
    fm.el.classList.toggle('stale', stale);
    const ug = groupOf(u.id);
    fm.el.innerHTML = `<div class="bubble" style="background:${esc(u.color)}${ug ? `;border-color:${esc(ug.color)}` : ''}">${esc(initials(u.name))}${u.avatar ? `<img src="${esc(u.avatar)}" alt="" onerror="this.remove()">` : ''}</div><div class="tail"></div><div class="label">${esc(u.name)}${stale ? ` <span class="faint">${ago(loc.ts)}</span>` : ''}</div>`;
    chips.push(`<button class="friend-chip ${stale ? 'stale' : ''}" data-friend="${u.id}">${avatar(u)}<span>${esc(u.name)}</span><span class="age">${ago(loc.ts)}</span></button>`);
  }
  for (const [id, fm] of friendMarkers) if (!seen.has(id)) { fm.marker.remove(); friendMarkers.delete(id); }
  chips.push(`<button class="friend-chip" data-groups aria-label="Subgroups" data-tip="Subgroups: for when the group splits up for a day or two">${icon('users', 'small')}<span>${dayGroups.length ? 'Groups' : 'Split up'}</span></button>`);
  row.innerHTML = chips.join('');
  row.querySelector('[data-groups]').onclick = () => openGroups();
  row.querySelector('[data-friends]')?.addEventListener('click', () => openFriends());
  row.querySelectorAll('[data-group]').forEach((b) => b.onclick = () => emit('focus-group', b.dataset.group));
  row.querySelectorAll('[data-friend]').forEach((b) => b.onclick = () => openFriend(+b.dataset.friend, { follow: true }));
}

// Pinpoint a friend: fly in close, draw how accurate their fix is, and pulse their bubble.
let accCircle = null; // { lng, lat, acc, color }
function circlePolygon(lng, lat, m) {
  const pts = [];
  for (let i = 0; i <= 64; i++) {
    const a = (i / 64) * 2 * Math.PI;
    pts.push([lng + (m / (111320 * Math.cos((lat * Math.PI) / 180))) * Math.cos(a), lat + (m / 110540) * Math.sin(a)]);
  }
  return pts;
}
function drawAccuracy() {
  if (!map?.isStyleLoaded()) return;
  const data = { type: 'FeatureCollection', features: accCircle ? [{ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [circlePolygon(accCircle.lng, accCircle.lat, Math.max(accCircle.acc, 8))] } }] : [] };
  if (map.getSource('friend-acc')) map.getSource('friend-acc').setData(data);
  else {
    map.addSource('friend-acc', { type: 'geojson', data });
    map.addLayer({ id: 'friend-acc-fill', type: 'fill', source: 'friend-acc', paint: { 'fill-color': accCircle?.color || '#1A73E8', 'fill-opacity': 0.14 } });
    map.addLayer({ id: 'friend-acc-line', type: 'line', source: 'friend-acc', paint: { 'line-color': accCircle?.color || '#1A73E8', 'line-width': 1.5, 'line-opacity': 0.6 } });
  }
  if (accCircle) {
    map.setPaintProperty('friend-acc-fill', 'fill-color', accCircle.color);
    map.setPaintProperty('friend-acc-line', 'line-color', accCircle.color);
  }
}
function focusFriend(id) {
  const u = userById(id), loc = state.locations[id];
  if (!u) return;
  if (!loc) return toast(`${u.name} isn’t sharing their location right now.`);
  accCircle = { userId: u.id, lng: loc.lng, lat: loc.lat, acc: loc.acc || 0, color: u.color };
  drawAccuracy();
  const zoom = loc.acc > 500 ? 14 : loc.acc > 100 ? 15.5 : 17;
  // Keep them in view above an open card (the friend sheet)
  const pad = padding();
  const sheet = document.querySelector('.sheet.peek:not(.closing)');
  if (sheet && innerWidth < 900) pad.bottom = Math.max(pad.bottom, sheet.offsetHeight + 24);
  map.flyTo({ center: [loc.lng, loc.lat], zoom, padding: pad, duration: 900 });
  const fm = friendMarkers.get(+id);
  if (fm) {
    fm.el.classList.remove('pinpoint');
    void fm.el.offsetWidth;
    fm.el.classList.add('pinpoint');
    setTimeout(() => fm.el.classList.remove('pinpoint'), 4200);
  }
  if (Date.now() - loc.ts > 15 * 60e3) toast(`${u.name} was here ${ago(loc.ts)}. They may have moved since.`);
}
function fitFriends() {
  stopFollow();
  const pts = Object.entries(state.locations).filter(([id]) => +id !== state.me?.id && userById(id)).map(([, l]) => l);
  const me = myPosition() || state.locations[state.me?.id];
  if (me) pts.push(me);
  if (!pts.length) return toast('Nobody is sharing their location right now.');
  if (pts.length === 1) return map.flyTo({ center: [pts[0].lng, pts[0].lat], zoom: 15, padding: padding() });
  const b = new maplibregl.LngLatBounds();
  pts.forEach((l) => b.extend([l.lng, l.lat]));
  fitTo(b, { maxZoom: 16 });
}

// ---------- following (you, or a friend) ----------
// Tap the locate button twice, or tap your blue dot: the map keeps you centred as you move.
// Tap a friend on the map: it keeps them centred. Dragging the map, or "Stop", ends it.
let follow = null; // null | { kind: 'me' } | { kind: 'friend', id }
let lastLocate = 0;
function followTarget() {
  if (follow?.kind === 'me') return myPosition() || state.locations[state.me?.id] || null;
  if (follow?.kind === 'friend') return state.locations[follow.id] || null;
  return null;
}
function sheetPadding() {
  const pad = padding();
  const sheet = document.querySelector('.sheet.peek:not(.closing)');
  if (sheet && innerWidth < 900) pad.bottom = Math.max(pad.bottom, sheet.offsetHeight + 24);
  return pad;
}
export function startFollow(f, { fly = true } = {}) {
  follow = f;
  setFollowGps(f.kind === 'me');
  renderFollowUi();
  const t = followTarget();
  if (t && fly) map.flyTo({ center: [t.lng, t.lat], zoom: Math.max(map.getZoom(), f.kind === 'me' ? 16 : 15.5), padding: sheetPadding(), duration: 800 });
  emit('follow', follow);
}
export function stopFollow() {
  if (!follow) return;
  follow = null;
  setFollowGps(false);
  renderFollowUi();
  emit('follow', null);
}
function keepFollowing() {
  const t = followTarget();
  if (!t || !map || map.isMoving()) return;
  map.easeTo({ center: [t.lng, t.lat], padding: sheetPadding(), duration: 700 });
}
function renderFollowUi() {
  const btn = $('#ctl-locate');
  btn.classList.toggle('following', follow?.kind === 'me');
  btn.setAttribute('aria-pressed', String(follow?.kind === 'me'));
  btn.setAttribute('aria-label', follow?.kind === 'me' ? 'Following you. Tap to stop.' : 'Show my location. Tap again to follow you.');
  btn.dataset.tip = follow?.kind === 'me' ? 'Following you. Tap to stop following.' : 'Show my location. Tap again, or tap your blue dot, to follow you as you move.';
  const chip = $('#follow-chip');
  if (!follow) { chip.hidden = true; return; }
  const u = follow.kind === 'me' ? state.me : userById(follow.id);
  chip.hidden = false;
  chip.innerHTML = `${follow.kind === 'me' ? '<span class="me-dot mini"></span>' : avatar(u)}<span>Following ${follow.kind === 'me' ? 'you' : esc(u?.name || '')}</span><button data-stop-follow aria-label="Stop following">Stop</button>`;
  chip.querySelector('[data-stop-follow]').onclick = stopFollow;
}

function renderMe() {
  const pos = myPosition();
  if (!map || !pos) return;
  if (!meMarker) {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'me-dot';
    el.setAttribute('aria-label', 'You. Tap to follow your location.');
    el.dataset.tip = 'You. Tap to follow your location as you move.';
    el.addEventListener('click', (e) => { e.stopPropagation(); if (follow?.kind === 'me') stopFollow(); else startFollow({ kind: 'me' }); });
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
  // First tap: show me. Second tap (or tapping again while centred on me): follow me. While following: stop.
  $('#ctl-locate').onclick = async () => {
    if (follow?.kind === 'me') return stopFollow();
    const centred = (() => {
      const p = myPosition();
      if (!p) return false;
      const c = map.project([p.lng, p.lat]), mid = map.project(map.getCenter());
      return Math.hypot(c.x - mid.x, c.y - mid.y) < 40;
    })();
    if (Date.now() - lastLocate < 8000 || centred) { lastLocate = 0; return startFollow({ kind: 'me' }); }
    lastLocate = Date.now();
    try {
      stopFollow();
      const pos = await locateOnce();
      map.flyTo({ center: [pos.lng, pos.lat], zoom: Math.max(map.getZoom(), 15), duration: 700 });
    } catch (e) { toast(e.message); }
  };
  $('#ctl-fit').onclick = () => fitAll();
  $('#ctl-people').onclick = () => fitFriends();
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
