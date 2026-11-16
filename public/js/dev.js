// Developer console: read-only, live view of server state for debugging.
import { esc } from './ui.js';

const $ = (s) => document.querySelector(s);
const TABS = [
  ['overview', 'Overview'], ['locations', 'Locations'], ['owntracks', 'OwnTracks'], ['places', 'Places'],
  ['activity', 'Activity'], ['network', 'Network'], ['logs', 'Server log'],
];
const KINDS = ['log', 'loc', 'owntracks', 'op', 'net', 'ws'];
const ev = Object.fromEntries(KINDS.map((k) => [k, []]));
const MAX = { log: 800, loc: 1000, owntracks: 300, op: 400, net: 400, ws: 200 };
let tab = location.hash.slice(1) || 'overview';
let overview = null, people = [], places = null, subgroups = [];
let freshIds = new Set();
const ui = { placeQuery: '', placeStatus: 'all', otUser: '', netHost: '', logLevel: 'all', paused: false };

// ---------- helpers ----------
const fmtTime = (ts) => ts ? new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '–';
const fmtDateTime = (ts) => ts ? new Date(ts).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '–';
function ago(ts) {
  if (!ts) return '–';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 0) return `in ${-s}s`;
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
const dur = (ms) => ms == null ? '–' : ms < 1000 ? `${ms} ms` : ms < 120000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms / 60000)} min`;
const bytes = (n) => n == null ? '–' : n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`;
const num = (v, d = 0) => v == null || v === '' || Number.isNaN(+v) ? '–' : (+v).toFixed(d);
const maps = (lat, lng) => `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`;
const coord = (lat, lng) => lat == null ? '–' : `<a href="${maps(lat, lng)}" target="_blank" rel="noopener" class="mono">${(+lat).toFixed(5)}, ${(+lng).toFixed(5)}</a>`;
const kv = (pairs) => `<dl class="kv">${pairs.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join('')}</dl>`;
const RESULT = {
  stored: ['good', 'Stored'], 'ignored-sharing-off': ['warn', 'Ignored: sharing is off in Tabi'],
  'bad-token': ['bad', 'Wrong token'], 'unknown-user': ['bad', 'Unknown user ID'], 'no-credentials': ['bad', 'No credentials sent'],
};
const resultBadge = (r) => { const [cls, label] = RESULT[r] || (String(r).startsWith('ignored-') ? ['', `Ignored: ${String(r).slice(8)} message`] : ['', r]); return `<span class="badge ${cls}">${esc(label)}</span>`; };

async function get(path) {
  const r = await fetch(path, { credentials: 'same-origin' });
  if (r.status === 404) throw new Error('Developer access expired. Open /dev?devkey=… again.');
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  return r.json();
}

// ---------- data ----------
async function loadAll() {
  await Promise.all(KINDS.map(async (k) => { ev[k] = (await get(`/api/dev/events?kind=${k}`)).events; }));
  await Promise.all([refreshOverview(), refreshPeople()]);
}
async function refreshOverview() { overview = await get('/api/dev/overview'); renderHead(); }
async function refreshPeople() { people = (await get('/api/dev/people')).people; }
async function refreshPlaces() { const r = await get('/api/dev/places'); places = r.places; subgroups = r.subgroups; }

function connectStream() {
  const es = new EventSource('/api/dev/stream');
  const live = $('#live');
  es.onopen = () => { live.className = 'badge good'; live.innerHTML = '<span class="live-dot"></span>Live'; };
  es.onerror = () => { live.className = 'badge warn'; live.innerHTML = '<span class="live-dot"></span>Reconnecting'; };
  for (const k of KINDS) {
    es.addEventListener(k, (e) => {
      const item = JSON.parse(e.data);
      ev[k].push(item);
      if (ev[k].length > MAX[k]) ev[k].splice(0, ev[k].length - MAX[k]);
      freshIds.add(item.id);
      if (k === 'loc' || k === 'owntracks') refreshPeopleSoon();
      renderSoon();
    });
  }
}
let peopleTimer;
function refreshPeopleSoon() { clearTimeout(peopleTimer); peopleTimer = setTimeout(() => refreshPeople().then(renderSoon).catch(() => {}), 800); }
let renderTimer;
function renderSoon() { if (ui.paused && tab === 'logs') return; clearTimeout(renderTimer); renderTimer = setTimeout(render, 250); }

// ---------- chrome ----------
function renderHead() {
  const h = overview?.health || {};
  const role = $('#role');
  role.className = `badge ${h.role === 'leader' || h.role === 'single' ? 'good' : h.role === 'standby' ? 'warn' : ''}`;
  role.textContent = `${h.node || overview?.host || '?'}: ${h.role || '?'}${h.epoch ? `, epoch ${h.epoch}` : ''}`;
}
function renderTabs() {
  const counts = { locations: ev.loc.length, owntracks: ev.owntracks.length, places: places?.length, activity: ev.op.length, network: ev.net.length, logs: ev.log.length };
  $('#tabs').innerHTML = TABS.map(([k, label]) => `<button role="tab" data-tab="${k}" aria-selected="${tab === k}">${label}${counts[k] != null ? `<span class="n">${counts[k]}</span>` : ''}</button>`).join('');
  $('#tabs').querySelectorAll('[data-tab]').forEach((b) => b.onclick = () => { tab = b.dataset.tab; location.hash = tab; render(); });
}

function render() {
  renderTabs();
  const view = $('#view');
  const keepScroll = view.querySelector('.tbl-wrap')?.scrollTop;
  ({ overview: viewOverview, locations: viewLocations, owntracks: viewOwnTracks, places: viewPlaces, activity: viewActivity, network: viewNetwork, logs: viewLogs })[tab]?.(view);
  if (keepScroll) { const w = view.querySelector('.tbl-wrap'); if (w) w.scrollTop = keepScroll; }
  freshIds = new Set();
}
const rowCls = (e) => (freshIds.has(e.id) ? 'new' : '');

// ---------- views ----------
function viewOverview(v) {
  const o = overview;
  if (!o) { v.innerHTML = '<p class="hint">Loading…</p>'; return; }
  const h = o.health || {};
  const c = o.counts;
  const yes = (b) => b ? '<span class="badge good">on</span>' : '<span class="badge">off</span>';
  v.innerHTML = `
    <div class="grid">
      <section class="panel"><h3>Server</h3>${kv([
        ['Version', esc(o.version)], ['Node.js', esc(o.node)], ['Host', esc(o.host)], ['Up', dur(o.uptimeSec * 1000)],
        ['Process memory', bytes(o.memory.rss)], ['Machine memory free', `${bytes(o.systemMemory.free)} of ${bytes(o.systemMemory.total)}`],
        ['Load (1/5/15 min)', o.load.map((x) => x.toFixed(2)).join(' / ')], ['Database', bytes(o.db.bytes)]])}</section>
      <section class="panel"><h3>Failover</h3>${kv([
        ['This node', esc(h.node || '–')], ['Role', esc(h.role || '–')], ['Priority', esc(h.priority || '–')], ['Lease holder', esc(h.holder || '–')],
        ['Epoch', esc(h.epoch ?? '–')], ['Last lease renewal', ago(h.lastRenewOk)], ['Last snapshot to storage', ago(h.lastSnapshot)],
        ['Error', h.error ? `<span class="badge bad">${esc(h.error)}</span>` : 'none']])}</section>
      <section class="panel"><h3>Data</h3>${kv([
        ['People', c.users], ['Sessions', c.sessions], ['Places', `${c.places} (+${c.removed} previously interested)`],
        ['By status', Object.entries(c.byStatus).map(([k, n]) => `${esc(k)} ${n}`).join(', ') || '–'], ['Votes', c.votes], ['Subgroups', c.subgroups],
        ['Expenses', `${c.expenses} (${c.privateExpenses} private), ${c.payments} payments`], ['Receipts', `${c.attachments} (${bytes(c.attachmentBytes)})`],
        ['Search cache entries', c.geocache], ['Activity items', c.activity]])}</section>
      <section class="panel"><h3>Settings</h3>${kv([
        ['Private-link gate', yes(o.features.privateLinkGate)], ['Cloudflare Tunnel', yes(o.features.tunnel)], ['Durable storage (R2)', yes(o.features.durableStorage)],
        ['Failover', yes(o.features.ha)], ['Behind proxy', yes(o.features.trustProxy)], ['Session length', `${o.features.sessionDays} days`],
        ['Trip', `${esc(o.trip.name)}, ${esc(o.trip.start || '?')} to ${esc(o.trip.end || '?')}`], ['Time zone', esc(o.trip.timezone)], ['Currency', esc(o.trip.currency)],
        ['Veto rule', esc(o.trip.vetoRule)], ['Auto-confirm', o.trip.autoConfirm || 'off']])}</section>
      <section class="panel wide"><h3>Map</h3>${kv([
        ['Light style', `<span class="mono">${esc(o.config.styleLight)}</span>`], ['Dark style', `<span class="mono">${esc(o.config.styleDark)}</span>`],
        ['Offline download limit', `${o.config.offlineTileLimit} tiles per press`], ['Map files cached in this browser', '<span id="tilecache">…</span>']])}
        <button class="btn small" id="test-style" style="margin-top:10px">Test map style from this browser</button> <span class="hint" id="style-result"></span></section>
      <section class="panel wide" id="acct-panel"><h3>Accounts</h3><p class="hint">Loading…</p></section>
      <section class="panel wide" id="exp-panel"><h3>Expenses</h3><p class="hint">Loading…</p></section>
    </div>
    <h3 style="margin:20px 0 8px;font-size:14px;color:var(--ink-2)">Connected right now (${o.clients.length})</h3>
    <div class="tbl-wrap"><table><thead><tr><th>Person</th><th>Connected</th><th>IP</th><th>Device</th></tr></thead><tbody>
      ${o.clients.map((cl) => `<tr><td>${esc(cl.user)}</td><td>${ago(cl.since)}</td><td class="mono">${esc(cl.ip || '')}</td><td class="wrap">${esc(cl.ua)}</td></tr>`).join('') || '<tr class="empty-row"><td colspan="4">Nobody has the app open</td></tr>'}
    </tbody></table></div>`;
  renderExpensePanel();
  renderAccountsPanel();
  caches?.open('tabi-map-v1').then((cch) => cch.keys()).then((k) => { const el = $('#tilecache'); if (el) el.textContent = String(k.length); }).catch(() => { const el = $('#tilecache'); if (el) el.textContent = 'not available'; });
  $('#test-style').onclick = async () => {
    const out = $('#style-result');
    out.textContent = 'Testing…';
    const res = [];
    for (const [name, u] of [['light', o.config.styleLight], ['dark', o.config.styleDark]]) {
      const t0 = performance.now();
      try {
        const r = await fetch(u, { cache: 'no-store' });
        const j = await r.json();
        res.push(`${name}: HTTP ${r.status}, ${j.layers?.length || 0} layers, ${Math.round(performance.now() - t0)} ms`);
      } catch (e) { res.push(`${name}: failed (${e.message})`); }
    }
    out.textContent = res.join('; ');
  };
}

// Accounts: who's who, whether they can recover a forgotten password, and one-time reset links.
const resetLinks = {}; // user id -> url made in this console session
async function renderAccountsPanel() {
  const el = $('#acct-panel');
  if (!el) return;
  try { await refreshPeople(); } catch (e) { el.innerHTML = `<h3>Accounts</h3><p class="hint">${esc(e.message)}</p>`; return; }
  el.innerHTML = `<h3>Accounts</h3>
    <p class="hint" style="margin-top:0">Former members can’t sign in, but their expenses still count. A reset link lets someone set a new password once, within 24 hours, and signs them out everywhere else.</p>
    <div class="tbl-wrap"><table><thead><tr><th>Person</th><th>Status</th><th>Recovery code</th><th>Devices</th><th>Last seen</th><th></th></tr></thead><tbody>
    ${people.map((p) => `<tr>
      <td><span class="badge" style="background:${esc(p.color)};color:#fff">${esc(p.name)}</span> <span class="hint">#${p.id}</span></td>
      <td>${p.removedAt ? `<span class="badge">former member</span><div class="hint">since ${fmtDateTime(p.removedAt)}</div>` : p.admin ? '<span class="badge good">admin</span>' : 'member'}${!p.hasPassword ? '<div class="hint">no password yet</div>' : ''}</td>
      <td>${p.recoverySet ? '<span class="badge good">set up</span>' : '<span class="badge warn">not set up</span>'}</td>
      <td class="num">${p.sessions?.n || 0}</td>
      <td>${p.online ? '<span class="badge good">app open</span>' : p.sessions?.last ? ago(p.sessions.last) : '–'}</td>
      <td>${p.removedAt ? '' : resetLinks[p.id] ? `<input class="input" readonly value="${esc(resetLinks[p.id])}" style="width:260px;font-size:12px" onclick="this.select()">`
        : `<button class="btn small" data-reset-link="${p.id}">${p.resetLink ? 'New reset link' : 'Reset link'}</button>${p.resetLink ? `<div class="hint">a link is live until ${fmtTime(p.resetLink.expires_at)}</div>` : ''}`}</td></tr>`).join('')}
    </tbody></table></div>`;
  el.querySelectorAll('[data-reset-link]').forEach((b) => b.onclick = async () => {
    b.disabled = true;
    try {
      const r = await fetch('/api/dev/reset-link', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId: +b.dataset.resetLink }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error);
      resetLinks[b.dataset.resetLink] = `${location.origin}/?${j.gate ? `gate=${j.gate}&` : ''}reset=${j.token}`;
    } catch (e) { b.disabled = false; b.textContent = e.message; return; }
    renderAccountsPanel();
  });
}

// The console's only write action: clear all expenses (typed confirmation), and undo the last clear.
let expMsg = '';
async function renderExpensePanel() {
  const el = $('#exp-panel');
  if (!el) return;
  let d;
  try { d = await get('/api/dev/expenses'); } catch (e) { el.innerHTML = `<h3>Expenses</h3><p class="hint">${esc(e.message)}</p>`; return; }
  const c = d.counts, total = c.expenses + c.payments, last = d.last;
  el.innerHTML = `<h3>Expenses</h3>
    <p class="hint" style="margin-top:0">${c.expenses} expense${c.expenses === 1 ? '' : 's'} (${c.private} private) and ${c.payments} payment${c.payments === 1 ? '' : 's'}.
      Clearing removes them for everyone so balances start from zero, and tells the people involved. The last clear can be undone.</p>
    <div class="exp-actions">
      <select class="input" id="exp-scope" aria-label="What to clear"><option value="all">Everything (${total})</option><option value="shared">Shared only (${total - c.private})</option></select>
      <input class="input" id="exp-confirm" placeholder="Type CLEAR" autocomplete="off" spellcheck="false" aria-label="Type CLEAR to confirm">
      <button class="btn small danger-fill" id="exp-clear" disabled>Clear expenses</button>
    </div>
    ${last ? `<p class="hint" style="margin:12px 0 0">Last cleared ${ago(last.at)} by ${esc(last.by)}: ${last.count} expense${last.count === 1 ? '' : 's'}. <button class="btn small" id="exp-restore">Bring them back</button></p>` : ''}
    <p class="hint" id="exp-result" role="status">${esc(expMsg)}</p>`;
  const confirmEl = $('#exp-confirm'), btn = $('#exp-clear');
  confirmEl.oninput = () => { btn.disabled = confirmEl.value.trim().toUpperCase() !== 'CLEAR' || !total; };
  const post = async (path, body) => {
    const r = await fetch(path, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
    return j;
  };
  btn.onclick = async () => {
    btn.disabled = true;
    try { const j = await post('/api/dev/expenses/reset', { scope: $('#exp-scope').value, confirm: 'CLEAR' }); expMsg = `Cleared ${j.count}.`; }
    catch (e) { expMsg = e.message; }
    await refreshOverview(); renderExpensePanel();
  };
  $('#exp-restore')?.addEventListener('click', async () => {
    try { const j = await post('/api/dev/expenses/restore', { batch: last.batch }); expMsg = `Brought back ${j.count}.`; }
    catch (e) { expMsg = e.message; }
    await refreshOverview(); renderExpensePanel();
  });
}

let devMap = null, devMarkers = new Map(), maplibre = null;
async function viewLocations(v) {
  if (!v.querySelector('#devmap')) {
    devMap?.remove();
    v.innerHTML = `<div class="dev-map" id="devmap"></div><div id="loc-tables"></div>`;
    devMap = null; devMarkers = new Map();
  }
  renderLocTables(v.querySelector('#loc-tables'));
  await ensureMap();
  drawMap();
}
function renderLocTables(el) {
  const recent = ev.loc.slice(-150).reverse();
  el.innerHTML = `
    <div class="tbl-wrap" style="margin-bottom:16px"><table><thead><tr>
      <th>Person</th><th>Sharing</th><th>Last update</th><th>Source</th><th>Position</th><th class="num">±m</th><th class="num">Battery</th><th>OwnTracks</th><th>Groups</th></tr></thead><tbody>
      ${people.map((p) => `<tr>
        <td><span class="badge" style="background:${esc(p.color)};color:#fff">${esc(p.name)}</span>${p.online ? ' <span class="badge good">app open</span>' : ''}</td>
        <td>${p.sharing ? '<span class="badge good">on</span>' : '<span class="badge">off</span>'}</td>
        <td>${p.location ? `${ago(p.location.ts)}<div class="hint">${fmtDateTime(p.location.ts)}</div>` : '–'}</td>
        <td>${esc(p.location?.source || '–')}</td><td>${p.location ? coord(p.location.lat, p.location.lng) : '–'}</td>
        <td class="num">${num(p.location?.acc)}</td><td class="num">${p.location?.batt != null ? `${p.location.batt}%` : '–'}</td>
        <td>${p.lastOwnTracks ? `${resultBadge(p.lastOwnTracks.result)}<div class="hint">${ago(p.lastOwnTracks.ts)}</div>` : '<span class="hint">no contact since server start</span>'}</td>
        <td>${esc(p.groups.join(', ') || '–')}</td></tr>`).join('')}
    </tbody></table></div>
    <h3 style="margin:0 0 8px;font-size:14px;color:var(--ink-2)">Location updates received (newest first)</h3>
    <div class="tbl-wrap" style="max-height:420px"><table><thead><tr><th>Received</th><th>Person</th><th>Source</th><th>Position</th><th class="num">±m</th><th class="num">Battery</th><th class="num">Speed</th><th class="num">Delay</th></tr></thead><tbody>
      ${recent.map((e) => `<tr class="${rowCls(e)}"><td>${fmtTime(e.ts)}</td><td>${esc(e.user)}</td><td>${esc(e.source)}</td><td>${coord(e.lat, e.lng)}</td>
        <td class="num">${num(e.acc)}</td><td class="num">${e.batt != null ? `${e.batt}%` : '–'}</td><td class="num">${e.speed != null ? `${num(e.speed * 3.6)} km/h` : '–'}</td>
        <td class="num" title="Time between the phone taking the fix and the server receiving it">${dur(e.lagMs)}</td></tr>`).join('') || '<tr class="empty-row"><td colspan="8">No location updates since the server started</td></tr>'}
    </tbody></table></div>`;
}
async function ensureMap() {
  if (devMap) return;
  maplibre ||= await import('/vendor/maplibre-gl/maplibre-gl.mjs');
  const dark = document.documentElement.dataset.theme === 'dark';
  const style = overview ? (dark ? overview.config.styleDark : overview.config.styleLight) : { version: 8, sources: {}, layers: [] };
  devMap = new maplibre.Map({ container: 'devmap', style, center: [139.7, 35.68], zoom: 10, attributionControl: { compact: true } });
  // If the map style can't load (offline), fall back to a plain background so positions still show.
  await new Promise((resolve) => {
    devMap.once('load', resolve);
    devMap.once('error', () => {
      if (devMap.isStyleLoaded()) return resolve();
      devMap.setStyle({ version: 8, sources: {}, layers: [{ id: 'bg', type: 'background', paint: { 'background-color': dark ? '#1D2128' : '#E6E9E4' } }] });
      devMap.once('style.load', resolve);
    });
  });
}
function drawMap() {
  if (!devMap || !devMap.isStyleLoaded()) { devMap?.once('idle', drawMap); return; }
  const trails = {};
  for (const e of ev.loc) (trails[e.userId] ||= []).push([e.lng, e.lat]);
  const colors = Object.fromEntries(people.map((p) => [p.id, p.color]));
  const lines = { type: 'FeatureCollection', features: Object.entries(trails).filter(([, c]) => c.length > 1).map(([id, c]) => ({ type: 'Feature', properties: { color: colors[id] || '#888' }, geometry: { type: 'LineString', coordinates: c.slice(-200) } })) };
  const circles = { type: 'FeatureCollection', features: people.filter((p) => p.location?.acc).map((p) => ({ type: 'Feature', properties: { color: p.color }, geometry: { type: 'Polygon', coordinates: [circle(p.location.lng, p.location.lat, p.location.acc)] } })) };
  for (const [id, data, layer] of [['trails', lines, { type: 'line', paint: { 'line-color': ['get', 'color'], 'line-width': 3, 'line-opacity': .7 } }],
    ['acc', circles, { type: 'fill', paint: { 'fill-color': ['get', 'color'], 'fill-opacity': .15 } }]]) {
    if (devMap.getSource(id)) devMap.getSource(id).setData(data);
    else { devMap.addSource(id, { type: 'geojson', data }); devMap.addLayer({ id, source: id, ...layer }); }
  }
  const bounds = new maplibre.LngLatBounds();
  for (const p of people) {
    if (!p.location) { devMarkers.get(p.id)?.remove(); devMarkers.delete(p.id); continue; }
    let m = devMarkers.get(p.id);
    if (!m) {
      const el = document.createElement('div');
      el.className = 'pin';
      m = new maplibre.Marker({ element: el }).setLngLat([p.location.lng, p.location.lat]).addTo(devMap);
      devMarkers.set(p.id, m);
    }
    const el = m.getElement();
    el.style.background = p.color;
    el.textContent = p.name.slice(0, 2).toUpperCase();
    el.title = `${p.name}: ${ago(p.location.ts)} via ${p.location.source}`;
    el.style.opacity = Date.now() - p.location.ts > 15 * 60e3 ? .55 : 1;
    m.setLngLat([p.location.lng, p.location.lat]);
    bounds.extend([p.location.lng, p.location.lat]);
  }
  if (!devMap._fitted && !bounds.isEmpty()) { devMap.fitBounds(bounds, { padding: 60, maxZoom: 15, animate: false }); devMap._fitted = true; }
}
function circle(lng, lat, m) {
  const pts = [];
  for (let i = 0; i <= 48; i++) {
    const a = (i / 48) * 2 * Math.PI;
    pts.push([lng + (m / (111320 * Math.cos((lat * Math.PI) / 180))) * Math.cos(a), lat + (m / 110540) * Math.sin(a)]);
  }
  return pts;
}

function viewOwnTracks(v) {
  const users = [...new Set(ev.owntracks.map((e) => e.user))];
  const list = ev.owntracks.filter((e) => !ui.otUser || e.user === ui.otUser).slice().reverse();
  v.innerHTML = `
    <p class="hint">Every request the OwnTracks app made to <span class="mono">/api/owntracks</span> since the server started. “Ignored: sharing is off” means the phone is set up correctly but that person hasn’t turned on sharing in Tabi.</p>
    <div class="toolbar"><select class="input" id="ot-user"><option value="">Everyone</option>${users.map((u) => `<option ${u === ui.otUser ? 'selected' : ''}>${esc(u)}</option>`).join('')}</select></div>
    <div class="tbl-wrap" style="max-height:70vh"><table><thead><tr><th>Received</th><th>User ID</th><th>Result</th><th>Message</th><th>Trigger</th><th>Position</th><th class="num">±m</th><th class="num">Battery</th><th>Network</th><th class="num">Fix age</th><th>Details</th></tr></thead><tbody>
      ${list.map((e) => `<tr class="${rowCls(e)}"><td>${fmtTime(e.ts)}<div class="hint">${ago(e.ts)}</div></td><td>${esc(e.user)}</td><td>${resultBadge(e.result)}</td>
        <td>${esc(e.type || '–')}</td><td>${esc({ p: 'ping', c: 'region', b: 'beacon', r: 'requested', u: 'manual', t: 'timer', v: 'move mode' }[e.trigger] || e.trigger || '–')}</td>
        <td>${e.lat != null ? coord(e.lat, e.lon) : '–'}</td><td class="num">${num(e.acc)}</td><td class="num">${e.batt != null ? `${e.batt}%` : '–'}</td>
        <td>${esc({ w: 'Wi-Fi', m: 'mobile', o: 'offline' }[e.conn] || e.conn || '–')}</td><td class="num">${e.tst ? dur(e.ts - e.tst) : '–'}</td>
        <td><details><summary>more</summary><pre class="mono">${esc(JSON.stringify({ ip: e.ip, device: e.device, ua: e.ua, vel: e.vel }, null, 1))}</pre></details></td></tr>`).join('')
        || '<tr class="empty-row"><td colspan="11">No OwnTracks requests since the server started. Tap the publish button in OwnTracks to send one.</td></tr>'}
    </tbody></table></div>`;
  $('#ot-user').onchange = (e) => { ui.otUser = e.target.value; render(); };
}

async function viewPlaces(v) {
  if (!places) { v.innerHTML = '<p class="hint">Loading places…</p>'; await refreshPlaces(); }
  const groupName = Object.fromEntries(subgroups.map((g) => [g.id, g.name]));
  const q = ui.placeQuery.toLowerCase();
  const list = places.filter((p) => (ui.placeStatus === 'all' || (ui.placeStatus === 'removed' ? p.removedAt : !p.removedAt && p.status === ui.placeStatus))
    && (!q || [p.name, p.notes, p.address, p.layer, p.id].some((x) => String(x || '').toLowerCase().includes(q))));
  v.innerHTML = `
    <div class="toolbar">
      <input class="input" id="pq" type="search" placeholder="Filter by name, notes, layer or id" value="${esc(ui.placeQuery)}">
      <select class="input" id="ps">${['all', 'confirmed', 'maybe', 'suggested', 'visited', 'skipped', 'vetoed', 'removed'].map((s) => `<option ${s === ui.placeStatus ? 'selected' : ''}>${s}</option>`).join('')}</select>
      <button class="btn small" id="reload">Reload</button><button class="btn small" id="dl">Download JSON</button>
      <span class="hint">${list.length} of ${places.length}</span>
    </div>
    <div class="tbl-wrap" style="max-height:72vh"><table><thead><tr><th>Name</th><th>Status</th><th>Day</th><th>Time</th><th class="num">Order</th><th>Subgroup</th><th>Votes</th><th>Added by</th><th>Updated</th><th>Position</th><th>Layer</th><th>Notes</th><th>ID</th></tr></thead><tbody>
      ${list.map((p) => `<tr><td>${esc(p.name)}</td><td>${p.removedAt ? `<span class="badge">removed by ${esc(p.removedByName || '?')}</span>` : esc(p.status)}</td>
        <td>${esc(p.day || '–')}</td><td>${esc(p.time || '–')}</td><td class="num">${num(p.sort, p.sort % 1 ? 2 : 0)}</td><td>${esc(groupName[p.groupId] || '–')}</td>
        <td>${Object.entries(p.votesByName).map(([n, val]) => `${esc(n)}: ${esc(val)}`).join(', ') || '–'}</td><td>${esc(p.createdByName || '–')}</td>
        <td>${ago(p.updatedAt)}</td><td>${coord(p.lat, p.lng)}</td><td>${esc(p.layer || '–')}</td><td class="wrap">${esc((p.notes || '').slice(0, 140))}</td><td class="mono">${esc(p.id)}</td></tr>`).join('')
        || '<tr class="empty-row"><td colspan="13">No places match</td></tr>'}
    </tbody></table></div>`;
  const pq = $('#pq');
  pq.oninput = () => { ui.placeQuery = pq.value; render(); setTimeout(() => { const el = $('#pq'); el.focus(); el.setSelectionRange(el.value.length, el.value.length); }, 0); };
  $('#ps').onchange = (e) => { ui.placeStatus = e.target.value; render(); };
  $('#reload').onclick = async () => { await refreshPlaces(); render(); };
  $('#dl').onclick = () => {
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob([JSON.stringify({ places, subgroups }, null, 2)], { type: 'application/json' })), download: `tabi-places-${new Date().toISOString().slice(0, 10)}.json` });
    a.click();
  };
}

function viewActivity(v) {
  const all = [...ev.op.map((e) => ({ ...e, k: 'op' })), ...ev.ws.map((e) => ({ ...e, k: 'ws' }))].sort((a, b) => b.id - a.id).slice(0, 400);
  v.innerHTML = `
    <p class="hint">Changes people made in the app, sign-ins (including failed ones) and app connections, since the server started.</p>
    <div class="tbl-wrap" style="max-height:72vh"><table><thead><tr><th>Time</th><th>Person</th><th>What</th><th>Result</th><th class="num">Took</th><th>From</th></tr></thead><tbody>
      ${all.map((e) => `<tr class="${rowCls(e)}"><td>${fmtTime(e.ts)}</td><td>${esc(e.user)}</td>
        <td class="mono">${esc(e.k === 'ws' ? `app ${e.event}${e.seconds != null ? ` after ${dur(e.seconds * 1000)}` : ''}` : e.op)}</td>
        <td>${e.k === 'ws' ? '' : e.ok ? '<span class="badge good">ok</span>' : `<span class="badge bad">${esc(e.error || 'failed')}</span>`}</td>
        <td class="num">${e.ms != null ? dur(e.ms) : ''}</td><td class="mono">${esc(e.ip || '')}</td></tr>`).join('') || '<tr class="empty-row"><td colspan="6">Nothing yet</td></tr>'}
    </tbody></table></div>`;
}

function viewNetwork(v) {
  const label = (h) => /photon/.test(h) ? 'Search (Photon)' : /r2\.cloudflarestorage|amazonaws|localhost:9500/.test(h) ? 'Storage (R2)' : /frankfurter/.test(h) ? 'Exchange rates'
    : /google/.test(h) || /goo\.gl/.test(h) ? 'Google (links, My Maps)' : /apple/.test(h) ? 'Apple Maps' : h;
  const hosts = [...new Set(ev.net.map((e) => label(e.host)))];
  const list = ev.net.filter((e) => !ui.netHost || label(e.host) === ui.netHost).slice().reverse();
  const fails = ev.net.filter((e) => !e.status || e.status >= 400).length;
  v.innerHTML = `
    <p class="hint">Requests the server made to other services since it started. Storage requests every few seconds are the failover lease and snapshots. ${fails ? `<span class="badge bad">${fails} failed</span>` : ''}</p>
    <div class="toolbar"><select class="input" id="nh"><option value="">All services</option>${hosts.map((h) => `<option ${h === ui.netHost ? 'selected' : ''}>${esc(h)}</option>`).join('')}</select></div>
    <div class="tbl-wrap" style="max-height:72vh"><table><thead><tr><th>Time</th><th>Service</th><th>Request</th><th>Status</th><th class="num">Took</th></tr></thead><tbody>
      ${list.map((e) => `<tr class="${rowCls(e)}"><td>${fmtTime(e.ts)}</td><td>${esc(label(e.host))}</td><td class="mono wrap">${esc(e.method)} ${esc(e.path)}</td>
        <td>${e.status && e.status < 400 ? `<span class="badge good">${e.status}</span>` : `<span class="badge bad">${esc(e.status || e.error || 'failed')}</span>`}</td><td class="num">${dur(e.ms)}</td></tr>`).join('')
        || '<tr class="empty-row"><td colspan="5">No outbound requests yet</td></tr>'}
    </tbody></table></div>`;
  $('#nh').onchange = (e) => { ui.netHost = e.target.value; render(); };
}

function viewLogs(v) {
  const list = ev.log.filter((e) => ui.logLevel === 'all' || e.level === ui.logLevel || (ui.logLevel === 'problems' && e.level !== 'log'));
  v.innerHTML = `
    <div class="toolbar">
      <select class="input" id="ll">${[['all', 'Everything'], ['problems', 'Warnings and errors']].map(([k, l]) => `<option value="${k}" ${k === ui.logLevel ? 'selected' : ''}>${l}</option>`).join('')}</select>
      <button class="btn small" id="pause">${ui.paused ? 'Resume' : 'Pause'}</button>
      <span class="hint">${list.length} lines kept in memory (newest at the bottom)</span>
    </div>
    <div class="tbl-wrap mono" id="logbox" style="max-height:72vh">${list.map((e) => `<div class="logline ${e.level}"><time>${fmtTime(e.ts)}</time>${esc(e.msg)}</div>`).join('') || '<p class="hint" style="padding:12px">No log lines yet</p>'}</div>`;
  const box = $('#logbox');
  box.scrollTop = box.scrollHeight;
  $('#ll').onchange = (e) => { ui.logLevel = e.target.value; render(); };
  $('#pause').onclick = () => { ui.paused = !ui.paused; render(); };
}

// ---------- start ----------
(async () => {
  try {
    await loadAll();
    render();
    connectStream();
    setInterval(() => refreshOverview().then(() => tab === 'overview' && render()).catch(() => {}), 10000);
    setInterval(() => { if (tab === 'locations' || tab === 'owntracks') renderSoon(); }, 15000); // keep "ago" times fresh
  } catch (e) {
    $('#view').innerHTML = `<div class="panel"><p>${esc(e.message)}</p></div>`;
  }
})();
