// Developer console: read-only, live view of server state for debugging.
// TA-7: each tab builds its controls once ("mount") and live data only redraws the parts that changed
// ("update"), so typing, dropdowns, scrolling and taps aren't interrupted while events stream in.
import { esc } from './ui.js';
import { affectsTab, patchHtml, patchList, rowItems, keepScroll, createThrottle, optionsHtml } from './devview.js';

const $ = (s) => document.querySelector(s);
const TABS = [
  ['overview', 'Overview'], ['locations', 'Locations'], ['owntracks', 'OwnTracks'], ['places', 'Places'],
  ['activity', 'Activity'], ['network', 'Network'], ['client', 'App errors'], ['logs', 'Server log'],
];
const KINDS = ['log', 'loc', 'owntracks', 'op', 'net', 'ws', 'client'];
const ev = Object.fromEntries(KINDS.map((k) => [k, []]));
const MAX = { log: 800, loc: 1000, owntracks: 300, op: 400, net: 400, ws: 200, client: 300 };
let tab = TABS.some(([k]) => k === location.hash.slice(1)) ? location.hash.slice(1) : 'overview';
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
// Table rows and log lines are updated one by one (see patchList): unchanged ones are left alone.
const parseEl = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; };
const patchRows = (box, list, html, empty, { key, cols } = {}) => patchList(box, rowItems(list, {
  key, html, fresh: (e) => freshIds.has(e.id),
  empty: cols ? `<tr class="empty-row"><td colspan="${cols}">${empty}</td></tr>` : empty,
}), parseEl);
// A dropdown's options are only redrawn while it's closed: replacing them under an open picker shuts it.
const patchSelect = (sel, html) => { if (sel && document.activeElement !== sel) patchHtml(sel, html); };

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
let resetLinksOn = false;
async function refreshPeople() { const r = await get('/api/dev/people'); people = r.people; resetLinksOn = !!r.resetLinks; }
async function refreshPlaces() { const r = await get('/api/dev/places'); places = r.places; subgroups = r.subgroups; }

function connectStream() {
  const es = new EventSource('/api/dev/stream');
  const live = $('#live');
  const setLive = (cls, text) => { if (live.className !== cls) { live.className = cls; live.innerHTML = `<span class="live-dot"></span>${text}`; } };
  let dropped = false;
  es.onopen = () => { setLive('badge good', 'Live'); if (dropped) { dropped = false; catchUp(); } };
  es.onerror = () => { dropped = true; setLive('badge warn', 'Reconnecting'); };
  for (const k of KINDS) {
    es.addEventListener(k, (e) => {
      const item = JSON.parse(e.data);
      ev[k].push(item);
      if (ev[k].length > MAX[k]) ev[k].splice(0, ev[k].length - MAX[k]);
      freshIds.add(item.id);
      if (k === 'loc' || k === 'owntracks') refreshPeopleSoon();
      scheduleRender(affectsTab(tab, k));
    });
  }
}
// After the live connection drops (a phone locking, a network change), fetch what was missed meanwhile.
async function catchUp() {
  await Promise.all(KINDS.map(async (k) => {
    const { events } = await get(`/api/dev/events?kind=${k}&since=${ev[k].at(-1)?.id || 0}`);
    const have = new Set(ev[k].map((e) => e.id));
    const add = events.filter((e) => !have.has(e.id));
    if (!add.length) return;
    ev[k] = [...ev[k], ...add].sort((a, b) => a.id - b.id).slice(-MAX[k]);
  })).catch(() => {});
  if (people.length) refreshPeopleSoon();
  scheduleRender(true);
}
let peopleTimer;
function refreshPeopleSoon() {
  clearTimeout(peopleTimer);
  peopleTimer = setTimeout(() => refreshPeople().then(() => scheduleRender(tab === 'locations')).catch(() => {}), 800);
}

// Live updates are drawn at most twice a second, and not at all while the page is hidden.
let viewDirty = false;
const throttle = createThrottle(() => {
  if (document.hidden) return;
  renderTabs();
  if (viewDirty) { viewDirty = false; updateView(); }
}, 500);
function scheduleRender(viewToo = true) { if (viewToo) viewDirty = true; throttle.schedule(); }
document.addEventListener('visibilitychange', () => { if (!document.hidden) scheduleRender(true); });

// ---------- chrome ----------
function renderHead() {
  const h = overview?.health || {};
  const role = $('#role');
  const cls = `badge ${h.role === 'leader' || h.role === 'single' ? 'good' : h.role === 'standby' ? 'warn' : ''}`;
  const text = `${h.node || overview?.host || '?'}: ${h.role || '?'}${h.epoch ? `, epoch ${h.epoch}` : ''}`;
  if (role.className !== cls) role.className = cls;
  if (role.textContent !== text) role.textContent = text;
}
// The tab buttons are made once; after that only which one is selected and the counts change.
function mountTabs() {
  const nav = $('#tabs');
  nav.innerHTML = TABS.map(([k, label]) => `<button role="tab" data-tab="${k}">${label}<span class="n" hidden></span></button>`).join('');
  nav.querySelectorAll('[data-tab]').forEach((b) => b.onclick = () => {
    if (tab === b.dataset.tab) return;
    tab = b.dataset.tab;
    history.replaceState(null, '', `#${tab}`);
    render();
  });
}
function renderTabs() {
  const counts = { locations: ev.loc.length, owntracks: ev.owntracks.length, places: places?.length, activity: ev.op.length, network: ev.net.length, client: ev.client.length, logs: ev.log.length };
  $('#tabs').querySelectorAll('[data-tab]').forEach((b) => {
    const k = b.dataset.tab, sel = String(tab === k), n = counts[k] != null ? String(counts[k]) : '';
    if (b.getAttribute('aria-selected') !== sel) b.setAttribute('aria-selected', sel);
    const span = b.querySelector('.n');
    if (span.textContent !== n) { span.textContent = n; span.hidden = !n; }
  });
}

// ---------- views ----------
// Each view: mount(v) builds the tab's controls once; update(v) redraws only the data; leave() cleans up.
let mounted = null;
function render() {
  renderTabs();
  updateView();
}
function updateView() {
  const view = $('#view');
  const V = VIEWS[tab];
  if (!V) return;
  if (mounted !== tab) {
    VIEWS[mounted]?.leave?.();
    view.innerHTML = '';
    mounted = tab;
    V.mount(view);
  }
  V.update(view);
  freshIds = new Set();
}

// Every server's version, from what each one last wrote to storage. A backup that's behind serves
// the old app whenever it takes over (during a deploy, for example).
function serversHtml(h, version) {
  const list = Object.entries(h.servers || {});
  if (!list.length) return '';
  const stale = (s) => Date.now() - s.at > 15 * 60e3;
  const behind = list.filter(([, s]) => !stale(s) && s.version !== version);
  return `<h4 style="margin:12px 0 6px;font-size:13px">Servers</h4>
    <div class="tbl-wrap"><table><thead><tr><th>Server</th><th>Version</th><th>Role</th><th>Last heard</th></tr></thead><tbody>
    ${list.map(([n, s]) => `<tr><td>${esc(n)}${n === h.node ? ' <span class="hint">(this one)</span>' : ''}</td>
      <td>${esc(s.version)} ${s.version !== version && !stale(s) ? '<span class="badge bad">different</span>' : ''}</td><td>${esc(s.role)}${s.priority ? ` (${esc(s.priority)})` : ''}</td><td>${ago(s.at)}</td></tr>`).join('')}
    </tbody></table></div>
    ${behind.length ? `<p class="hint" style="color:var(--bad,#c00)">Not every server runs ${esc(version)}. Run <span class="mono">bash /opt/tabi/deploy/update.sh</span> on ${behind.map(([n]) => esc(n)).join(', ')} too, or people can get the older app whenever it takes over.</p>` : ''}`;
}

// Where uploaded files live: R2 (hot), the cold store, and this server's disk cache
function storageHtml(st) {
  if (!st || !st.hot) return '<p class="hint">Files are kept on this server only. Set the S3_* settings to keep copies in R2.</p>';
  const files = (x) => `${x.files} file${x.files === 1 ? '' : 's'}, ${bytes(x.bytes)}`;
  const pct = st.hot.limit ? Math.round((st.hot.bytes / st.hot.limit) * 100) : 0;
  const run = st.lastRun;
  const did = run ? Object.entries(run).filter(([k, n]) => !['at', 'error'].includes(k) && n).map(([k, n]) => `${esc({ indexed: 'added to the index', copiedCold: 'copied to cold', copiedHot: 'copied back to R2', movedCold: 'moved cold', checked: 'spot-checked', damaged: 'damaged', missing: 'missing', evicted: 'cleared from disk' }[k] || k)} ${n}`).join(', ') : '';
  return `${kv([
    ['R2 (hot)', `${files(st.hot)} <span class="hint">of ${bytes(st.hot.limit)} (${pct}%)</span>${pct >= 90 ? ' <span class="badge warn">nearly full: moving old files cold</span>' : ''}`],
    ['Cold store', st.cold ? `${esc(st.tiers?.[1] || 'cold')}: ${files(st.cold)}${st.coldOnly?.files ? ` <span class="hint">(${st.coldOnly.files} only there)</span>` : ''}` : '<span class="badge">off</span> <span class="hint">Set COLD_S3_* to add Backblaze B2</span>'],
    ...(st.allHot ? [['Bringing files back to R2', st.coldOnly?.files ? `<span class="badge warn">${st.coldOnly.files} left</span>` : '<span class="badge good">done</span>']] : []),
    ...(st.stranded?.files ? [['Only in the cold store', `<span class="badge bad">${st.stranded.files} files</span> <span class="hint">The cold store isn’t set up any more, so these can’t load. Put the COLD_S3_* settings back with STORAGE_ALL_HOT=1.</span>`]] : []),
    ['Waiting to copy cold', st.cold ? (st.waitingForCold ? `<span class="badge warn">${st.waitingForCold}</span>` : 'none') : '–'],
    ['This server’s disk cache', `${st.local.bytes == null ? '–' : bytes(st.local.bytes)} <span class="hint">of ${bytes(st.local.limit)}</span>`],
    ['Stores', st.stores.map((x) => `${esc(x.name)} ${x.ok ? '<span class="badge good">ok</span>' : `<span class="badge ${x.skippedUntil > Date.now() ? 'bad' : 'warn'}">${x.failures} failure${x.failures === 1 ? '' : 's'}</span> <span class="hint">${esc(x.lastError || '')}</span>`}`).join('<br>')],
    ['Last upkeep', run ? `${ago(run.at)}${did ? `: ${did}` : ', nothing to do'}${run.error ? ` <span class="badge bad">${esc(run.error)}</span>` : ''}` : 'not yet (runs a minute after start, then every 10 minutes)'],
  ])}${st.problems?.length ? `<h4 style="margin:12px 0 6px;font-size:13px">Files with problems</h4><div class="tbl-wrap"><table><thead><tr><th>File</th><th>Kind</th><th>Problem</th></tr></thead><tbody>
    ${st.problems.map((p) => `<tr><td class="mono">${esc(p.key.slice(0, 12))}…</td><td>${esc(p.kind || '–')}</td><td>${esc(p.problem)}</td></tr>`).join('')}</tbody></table></div>` : ''}`;
}

// ----- Overview -----
// The stat panels and the connected list refresh every 10 seconds. Accounts and Expenses have buttons
// and a text box, so they're only redrawn when the tab opens or after you use them.
let tileCount = null;
const overviewView = {
  mount(v) {
    v.innerHTML = `
      <div class="grid">
        <section class="panel"><h3>Server</h3><div id="ov-server"></div></section>
        <section class="panel"><h3>Failover</h3><div id="ov-failover"></div></section>
        <section class="panel"><h3>Data</h3><div id="ov-data"></div></section>
        <section class="panel"><h3>Settings</h3><div id="ov-settings"></div></section>
        <section class="panel wide"><h3>File storage</h3><div id="ov-storage"></div></section>
        <section class="panel wide"><h3>Map</h3><div id="ov-map"></div>
          <button class="btn small" id="test-style" style="margin-top:10px">Test map style from this browser</button> <span class="hint" id="style-result"></span></section>
        <section class="panel wide" id="acct-panel"><h3>Accounts</h3><p class="hint">Loading…</p></section>
        <section class="panel wide" id="exp-panel"><h3>Expenses</h3><p class="hint">Loading…</p></section>
      </div>
      <div id="ov-clients"></div>`;
    renderExpensePanel();
    renderAccountsPanel();
    if (tileCount == null) {
      Promise.resolve(globalThis.caches?.open('tabi-map-v1')).then((cch) => cch ? cch.keys() : Promise.reject())
        .then((k) => { tileCount = String(k.length); }).catch(() => { tileCount = 'not available'; })
        .then(() => tab === 'overview' && scheduleRender(true));
    }
    $('#test-style').onclick = async () => {
      const out = $('#style-result');
      if (!overview) return;
      out.textContent = 'Testing…';
      const res = [];
      for (const [name, u] of [['light', overview.config.styleLight], ['dark', overview.config.styleDark]]) {
        const t0 = performance.now();
        try {
          const r = await fetch(u, { cache: 'no-store' });
          const j = await r.json();
          res.push(`${name}: HTTP ${r.status}, ${j.layers?.length || 0} layers, ${Math.round(performance.now() - t0)} ms`);
        } catch (e) { res.push(`${name}: failed (${e.message})`); }
      }
      out.textContent = res.join('; ');
    };
  },
  update() {
    const o = overview;
    if (!o) { patchHtml($('#ov-server'), '<p class="hint">Loading…</p>'); return; }
    const h = o.health || {};
    const c = o.counts;
    const yes = (b) => b ? '<span class="badge good">on</span>' : '<span class="badge">off</span>';
    patchHtml($('#ov-server'), kv([
      ['Version', esc(o.version)], ['Node.js', esc(o.node)], ['Host', esc(o.host)], ['Up', dur(o.uptimeSec * 1000)],
      ['Process memory', bytes(o.memory.rss)], ['Machine memory free', `${bytes(o.systemMemory.free)} of ${bytes(o.systemMemory.total)}`],
      ['Load (1/5/15 min)', o.load.map((x) => x.toFixed(2)).join(' / ')], ['Database', bytes(o.db.bytes)]]));
    patchHtml($('#ov-failover'), kv([
      ['This node', esc(h.node || '–')], ['Role', esc(h.role || '–')], ['Priority', esc(h.priority || '–')], ['Lease holder', esc(h.holder || '–')],
      ['Epoch', esc(h.epoch ?? '–')], ['Last lease renewal', ago(h.lastRenewOk)], ['Last snapshot to storage', ago(h.lastSnapshot)],
      ['Error', h.error ? `<span class="badge bad">${esc(h.error)}</span>` : 'none']]) + serversHtml(h, o.version));
    patchHtml($('#ov-data'), kv([
      ['People', c.users], ['Sessions', c.sessions], ['Places', `${c.places} (+${c.removed} previously interested)`],
      ['By status', Object.entries(c.byStatus).map(([k, n]) => `${esc(k)} ${n}`).join(', ') || '–'], ['Votes', c.votes], ['Subgroups', c.subgroups],
      ['Expenses', `${c.expenses} (${c.privateExpenses} private), ${c.payments} payments`], ['Receipts', `${c.attachments} (${bytes(c.attachmentBytes)})`],
      ['Search cache entries', c.geocache], ['Activity items', c.activity],
      ['Lock-screen notifications', c.push ? `${c.push.n} device${c.push.n === 1 ? '' : 's'} (${c.push.people} people)${c.push.failing ? `, <span class="badge warn">${c.push.failing} failing</span>` : ''}${c.push.lastOk ? `, last delivered ${ago(c.push.lastOk)}` : ''}` : '–']]));
    patchHtml($('#ov-settings'), kv([
      ['Private-link gate', yes(o.features.privateLinkGate)], ['Cloudflare Tunnel', yes(o.features.tunnel)], ['Durable storage (R2)', yes(o.features.durableStorage)],
      ['Failover', yes(o.features.ha)], ['Behind proxy', yes(o.features.trustProxy)], ['Session length', `${o.features.sessionDays} days`], ['Reset links', yes(o.features.resetLinks)],
      ['Trip', `${esc(o.trip.name)}, ${esc(o.trip.start || '?')} to ${esc(o.trip.end || '?')}`], ['Time zone', esc(o.trip.timezone)], ['Currency', esc(o.trip.currency)],
      ['Veto rule', esc(o.trip.vetoRule)], ['Auto-confirm', o.trip.autoConfirm || 'off']]));
    patchHtml($('#ov-storage'), storageHtml(o.storage));
    patchHtml($('#ov-map'), kv([
      ['Light style', `<span class="mono">${esc(o.config.styleLight)}</span>`], ['Dark style', `<span class="mono">${esc(o.config.styleDark)}</span>`],
      ['Offline download limit', `${o.config.offlineTileLimit} tiles per press`], ['Map files cached in this browser', esc(tileCount ?? '…')]]));
    patchHtml($('#ov-clients'), `
      <h3 style="margin:20px 0 8px;font-size:14px;color:var(--ink-2)">Connected right now (${o.clients.length})</h3>
      <div class="tbl-wrap"><table><thead><tr><th>Person</th><th>Connected</th><th>App build</th><th>IP</th><th>Device</th></tr></thead><tbody>
        ${o.clients.map((cl) => `<tr><td>${esc(cl.user)}</td><td>${ago(cl.since)}</td><td class="mono">${cl.build ? `${esc(cl.build)} ${cl.current ? '' : '<span class="badge warn">out of date</span>'}` : '–'}</td><td class="mono">${esc(cl.ip || '')}</td><td class="wrap">${esc(cl.ua)}</td></tr>`).join('') || '<tr class="empty-row"><td colspan="5">Nobody has the app open</td></tr>'}
      </tbody></table></div>`);
  },
};

// Accounts: who's who, whether they can recover a forgotten password, and one-time reset links.
const resetLinks = {}; // user id -> url made in this console session
async function renderAccountsPanel() {
  if (!$('#acct-panel')) return;
  try { await refreshPeople(); } catch (e) { const el = $('#acct-panel'); if (el) el.innerHTML = `<h3>Accounts</h3><p class="hint">${esc(e.message)}</p>`; return; }
  const el = $('#acct-panel');
  if (!el) return; // left the Overview tab while loading
  el.innerHTML = `<h3>Accounts</h3>
    <p class="hint" style="margin-top:0">Former members can’t sign in, but their expenses still count. A reset link lets someone set a new password once, within 24 hours, and signs them out everywhere else.${resetLinksOn ? '' : ' Reset links are off: set DEV_RESET_LINKS=on in .env and restart to make one, then turn it off again.'}</p>
    <div class="tbl-wrap"><table><thead><tr><th>Person</th><th>Status</th><th>Recovery code</th><th>Devices</th><th>Last seen</th><th></th></tr></thead><tbody>
    ${people.map((p) => `<tr>
      <td><span class="badge" style="background:${esc(p.color)};color:#fff">${esc(p.name)}</span> <span class="hint">#${p.id}</span></td>
      <td>${p.removedAt ? `<span class="badge">former member</span><div class="hint">since ${fmtDateTime(p.removedAt)}</div>` : p.admin ? '<span class="badge good">admin</span>' : 'member'}${!p.hasPassword ? '<div class="hint">no password yet</div>' : ''}</td>
      <td>${({ saved: '<span class="badge good">saved</span>', pending: '<span class="badge warn">made, not saved yet</span>', unconfirmed: '<span class="badge">made (before 1.6), not confirmed</span>' })[p.recoveryStatus] || (p.recoverySet ? '<span class="badge good">set up</span>' : '<span class="badge warn">not set up</span>')}</td>
      <td class="num">${p.sessions?.n || 0}</td>
      <td>${p.online ? '<span class="badge good">app open</span>' : p.sessions?.last ? ago(p.sessions.last) : '–'}</td>
      <td>${p.removedAt || (!resetLinksOn && !resetLinks[p.id]) ? '' : resetLinks[p.id] ? `<input class="input" readonly value="${esc(resetLinks[p.id])}" style="width:260px;font-size:12px" onclick="this.select()">`
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
  if (!$('#exp-panel')) return;
  let d;
  try { d = await get('/api/dev/expenses'); } catch (e) { const el = $('#exp-panel'); if (el) el.innerHTML = `<h3>Expenses</h3><p class="hint">${esc(e.message)}</p>`; return; }
  const el = $('#exp-panel');
  if (!el) return; // left the Overview tab while loading
  const c = d.counts, total = c.expenses + c.payments, last = d.last;
  el.innerHTML = `<h3>Expenses</h3>
    <p class="hint" style="margin-top:0">${c.expenses} expense${c.expenses === 1 ? '' : 's'} (${c.private} private) and ${c.payments} payment${c.payments === 1 ? '' : 's'}.
      Clearing removes them for everyone so balances start from zero, and tells the people involved. The last clear can be undone.</p>
    <div class="exp-actions">
      <select class="input" id="exp-scope" aria-label="What to clear"><option value="all">Everything (${total})</option><option value="shared">Shared only (${total - c.private})</option></select>
      <input class="input" id="exp-confirm" placeholder="Type CLEAR" autocomplete="off" autocapitalize="characters" spellcheck="false" aria-label="Type CLEAR to confirm">
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
  const after = async () => { await refreshOverview().catch(() => {}); if (tab === 'overview') scheduleRender(true); renderExpensePanel(); };
  btn.onclick = async () => {
    btn.disabled = true;
    try { const j = await post('/api/dev/expenses/reset', { scope: $('#exp-scope').value, confirm: 'CLEAR' }); expMsg = `Cleared ${j.count}.`; }
    catch (e) { expMsg = e.message; }
    await after();
  };
  $('#exp-restore')?.addEventListener('click', async () => {
    try { const j = await post('/api/dev/expenses/restore', { batch: last.batch }); expMsg = `Brought back ${j.count}.`; }
    catch (e) { expMsg = e.message; }
    await after();
  });
}

// ----- Locations -----
let devMap = null, devMarkers = new Map(), maplibre = null, mapStarting = false;
const locationsView = {
  mount(v) {
    v.innerHTML = `<div class="dev-map" id="devmap"></div>
      <div class="tbl-wrap" id="loc-people" style="margin-bottom:16px"></div>
      <h3 style="margin:0 0 8px;font-size:14px;color:var(--ink-2)">Location updates received (newest first)</h3>
      <div class="tbl-wrap" id="loc-recent-wrap" style="max-height:420px"><table><thead><tr><th>Received</th><th>Person</th><th>Source</th><th>Position</th><th class="num">±m</th><th class="num">Battery</th><th class="num">Speed</th><th class="num">Delay</th></tr></thead><tbody id="loc-recent"></tbody></table></div>`;
    startMap();
  },
  update() {
    patchHtml($('#loc-people'), `<table><thead><tr>
      <th>Person</th><th>Sharing</th><th>Last update</th><th>Source</th><th>Position</th><th class="num">±m</th><th class="num">Battery</th><th>OwnTracks</th><th>Groups</th></tr></thead><tbody>
      ${people.map((p) => `<tr>
        <td><span class="badge" style="background:${esc(p.color)};color:#fff">${esc(p.name)}</span>${p.online ? ' <span class="badge good">app open</span>' : ''}</td>
        <td>${p.sharing ? '<span class="badge good">on</span>' : '<span class="badge">off</span>'}</td>
        <td>${p.location ? `${ago(p.location.ts)}<div class="hint">${fmtDateTime(p.location.ts)}</div>` : '–'}</td>
        <td>${esc(p.location?.source || '–')}</td><td>${p.location ? coord(p.location.lat, p.location.lng) : '–'}</td>
        <td class="num">${num(p.location?.acc)}</td><td class="num">${p.location?.batt != null ? `${p.location.batt}%` : '–'}</td>
        <td>${p.lastOwnTracks ? `${resultBadge(p.lastOwnTracks.result)}<div class="hint">${ago(p.lastOwnTracks.ts)}</div>` : '<span class="hint">no contact since server start</span>'}</td>
        <td>${esc(p.groups.join(', ') || '–')}</td></tr>`).join('')}
      </tbody></table>`);
    const recent = ev.loc.slice(-150).reverse();
    keepScroll($('#loc-recent-wrap'), () => patchRows($('#loc-recent'), recent, (e) => `<tr><td>${fmtTime(e.ts)}</td><td>${esc(e.user)}</td><td>${esc(e.source)}</td><td>${coord(e.lat, e.lng)}</td>
      <td class="num">${num(e.acc)}</td><td class="num">${e.batt != null ? `${e.batt}%` : '–'}</td><td class="num">${e.speed != null ? `${num(e.speed * 3.6)} km/h` : '–'}</td>
      <td class="num" title="Time between the phone taking the fix and the server receiving it">${dur(e.lagMs)}</td></tr>`, 'No location updates since the server started', { cols: 8 }));
    drawMap();
  },
  leave() { devMap?.remove(); devMap = null; devMarkers = new Map(); },
};
// One map per visit to the tab, even if updates arrive while the map library is still loading.
async function startMap() {
  if (devMap || mapStarting) return;
  mapStarting = true;
  try { maplibre ||= await import('/vendor/maplibre-gl/maplibre-gl.mjs'); } catch { return; } finally { mapStarting = false; }
  const container = document.getElementById('devmap');
  if (!container || devMap || mounted !== 'locations') return;
  const dark = document.documentElement.dataset.theme === 'dark';
  const style = overview ? (dark ? overview.config.styleDark : overview.config.styleLight) : { version: 8, sources: {}, layers: [] };
  const map = new maplibre.Map({ container, style, center: [139.7, 35.68], zoom: 10, attributionControl: { compact: true } });
  devMap = map;
  // If the map style can't load (offline), fall back to a plain background so positions still show.
  map.once('error', () => {
    if (devMap !== map || map.isStyleLoaded()) return;
    map.setStyle({ version: 8, sources: {}, layers: [{ id: 'bg', type: 'background', paint: { 'background-color': dark ? '#1D2128' : '#E6E9E4' } }] });
  });
  drawMap();
}
function drawMap() {
  const map = devMap;
  if (!map) return;
  if (!map.isStyleLoaded()) {
    // Wait for the style once, however many updates arrive meanwhile.
    if (!map._tabiWaiting) { map._tabiWaiting = true; map.once('idle', () => { map._tabiWaiting = false; if (devMap === map) drawMap(); }); }
    return;
  }
  const trails = {};
  for (const e of ev.loc) (trails[e.userId] ||= []).push([e.lng, e.lat]);
  const colors = Object.fromEntries(people.map((p) => [p.id, p.color]));
  const lines = { type: 'FeatureCollection', features: Object.entries(trails).filter(([, c]) => c.length > 1).map(([id, c]) => ({ type: 'Feature', properties: { color: colors[id] || '#888' }, geometry: { type: 'LineString', coordinates: c.slice(-200) } })) };
  const circles = { type: 'FeatureCollection', features: people.filter((p) => p.location?.acc).map((p) => ({ type: 'Feature', properties: { color: p.color }, geometry: { type: 'Polygon', coordinates: [circle(p.location.lng, p.location.lat, p.location.acc)] } })) };
  for (const [id, data, layer] of [['trails', lines, { type: 'line', paint: { 'line-color': ['get', 'color'], 'line-width': 3, 'line-opacity': .7 } }],
    ['acc', circles, { type: 'fill', paint: { 'fill-color': ['get', 'color'], 'fill-opacity': .15 } }]]) {
    if (map.getSource(id)) map.getSource(id).setData(data);
    else { map.addSource(id, { type: 'geojson', data }); map.addLayer({ id, source: id, ...layer }); }
  }
  const bounds = new maplibre.LngLatBounds();
  for (const p of people) {
    if (!p.location) { devMarkers.get(p.id)?.remove(); devMarkers.delete(p.id); continue; }
    let m = devMarkers.get(p.id);
    if (!m) {
      const el = document.createElement('div');
      el.className = 'pin';
      m = new maplibre.Marker({ element: el }).setLngLat([p.location.lng, p.location.lat]).addTo(map);
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
  if (!map._fitted && !bounds.isEmpty()) { map.fitBounds(bounds, { padding: 60, maxZoom: 15, animate: false }); map._fitted = true; }
}
function circle(lng, lat, m) {
  const pts = [];
  for (let i = 0; i <= 48; i++) {
    const a = (i / 48) * 2 * Math.PI;
    pts.push([lng + (m / (111320 * Math.cos((lat * Math.PI) / 180))) * Math.cos(a), lat + (m / 110540) * Math.sin(a)]);
  }
  return pts;
}

// ----- OwnTracks -----
const openDetails = new Set(); // "more" rows left open stay open when new requests arrive
const owntracksView = {
  mount(v) {
    v.innerHTML = `
      <p class="hint">Every request the OwnTracks app made to <span class="mono">/api/owntracks</span> since the server started. “Ignored: sharing is off” means the phone is set up correctly but that person hasn’t turned on sharing in Tabi.</p>
      <div class="toolbar"><select class="input" id="ot-user" aria-label="Whose requests"></select></div>
      <div class="tbl-wrap" id="ot-wrap" style="max-height:70vh"><table><thead><tr><th>Received</th><th>User ID</th><th>Result</th><th>Message</th><th>Trigger</th><th>Position</th><th class="num">±m</th><th class="num">Battery</th><th>Network</th><th class="num">Fix age</th><th>Details</th></tr></thead><tbody id="ot-body"></tbody></table></div>`;
    $('#ot-user').onchange = (e) => { ui.otUser = e.target.value; render(); };
    $('#ot-body').addEventListener('toggle', (e) => {
      const id = +e.target.dataset?.id;
      if (id) e.target.open ? openDetails.add(id) : openDetails.delete(id);
    }, true);
  },
  update() {
    const users = [...new Set(ev.owntracks.map((e) => e.user))];
    patchSelect($('#ot-user'), optionsHtml(users, ui.otUser, { allLabel: 'Everyone', esc }));
    const list = ev.owntracks.filter((e) => !ui.otUser || e.user === ui.otUser).slice().reverse();
    keepScroll($('#ot-wrap'), () => patchRows($('#ot-body'), list, (e) => `<tr><td>${fmtTime(e.ts)}<div class="hint">${ago(e.ts)}</div></td><td>${esc(e.user)}</td><td>${resultBadge(e.result)}</td>
        <td>${esc(e.type || '–')}</td><td>${esc({ p: 'ping', c: 'region', b: 'beacon', r: 'requested', u: 'manual', t: 'timer', v: 'move mode' }[e.trigger] || e.trigger || '–')}</td>
        <td>${e.lat != null ? coord(e.lat, e.lon) : '–'}</td><td class="num">${num(e.acc)}</td><td class="num">${e.batt != null ? `${e.batt}%` : '–'}</td>
        <td>${esc({ w: 'Wi-Fi', m: 'mobile', o: 'offline' }[e.conn] || e.conn || '–')}</td><td class="num">${e.tst ? dur(e.ts - e.tst) : '–'}</td>
        <td><details data-id="${e.id}"${openDetails.has(e.id) ? ' open' : ''}><summary>more</summary><pre class="mono">${esc(JSON.stringify({ ip: e.ip, device: e.device, ua: e.ua, vel: e.vel }, null, 1))}</pre></details></td></tr>`, 'No OwnTracks requests since the server started. Tap the publish button in OwnTracks to send one.', { cols: 11 }));
  },
};

// ----- Places -----
const placesView = {
  mount(v) {
    v.innerHTML = `
      <div class="toolbar">
        <input class="input" id="pq" type="search" placeholder="Filter by name, notes, layer or id" value="${esc(ui.placeQuery)}" autocomplete="off" spellcheck="false">
        <select class="input" id="ps" aria-label="Status">${['all', 'confirmed', 'maybe', 'suggested', 'visited', 'skipped', 'vetoed', 'removed'].map((s) => `<option ${s === ui.placeStatus ? 'selected' : ''}>${s}</option>`).join('')}</select>
        <button class="btn small" id="reload">Reload</button><button class="btn small" id="dl">Download JSON</button>
        <span class="hint" id="pcount"></span>
      </div>
      <div class="tbl-wrap" id="pwrap" style="max-height:72vh"><table><thead><tr><th>Name</th><th>Status</th><th>Day</th><th>Time</th><th class="num">Order</th><th>Subgroup</th><th>Votes</th><th>Added by</th><th>Updated</th><th>Position</th><th>Layer</th><th>Notes</th><th>ID</th></tr></thead><tbody id="pbody"></tbody></table></div>`;
    // Filtering only redraws the rows, so the box keeps its focus, cursor and keyboard.
    $('#pq').oninput = (e) => { ui.placeQuery = e.target.value; placesView.update(); };
    $('#ps').onchange = (e) => { ui.placeStatus = e.target.value; placesView.update(); };
    $('#reload').onclick = async () => { await refreshPlaces().catch(() => {}); render(); };
    $('#dl').onclick = () => {
      if (!places) return;
      const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob([JSON.stringify({ places, subgroups }, null, 2)], { type: 'application/json' })), download: `tabi-places-${new Date().toISOString().slice(0, 10)}.json` });
      a.click();
    };
    if (!places) refreshPlaces().then(() => tab === 'places' && render()).catch((e) => patchRows($('#pbody'), [], null, esc(e.message), { cols: 13 }));
  },
  update() {
    if (!places) { patchRows($('#pbody'), [], null, 'Loading places…', { cols: 13 }); return; }
    const groupName = Object.fromEntries(subgroups.map((g) => [g.id, g.name]));
    const q = ui.placeQuery.toLowerCase();
    const list = places.filter((p) => (ui.placeStatus === 'all' || (ui.placeStatus === 'removed' ? p.removedAt : !p.removedAt && p.status === ui.placeStatus))
      && (!q || [p.name, p.notes, p.address, p.layer, p.id].some((x) => String(x || '').toLowerCase().includes(q))));
    patchHtml($('#pcount'), `${list.length} of ${places.length}`);
    patchRows($('#pbody'), list, (p) => `<tr><td>${esc(p.name)}</td><td>${p.removedAt ? `<span class="badge">removed by ${esc(p.removedByName || '?')}</span>` : esc(p.status)}</td>
        <td>${esc(p.day || '–')}</td><td>${esc(p.time || '–')}</td><td class="num">${num(p.sort, p.sort % 1 ? 2 : 0)}</td><td>${esc(groupName[p.groupId] || '–')}</td>
        <td>${Object.entries(p.votesByName).map(([n, val]) => `${esc(n)}: ${esc(val)}`).join(', ') || '–'}</td><td>${esc(p.createdByName || '–')}</td>
        <td>${ago(p.updatedAt)}</td><td>${coord(p.lat, p.lng)}</td><td>${esc(p.layer || '–')}</td><td class="wrap">${esc((p.notes || '').slice(0, 140))}</td><td class="mono">${esc(p.id)}</td></tr>`, 'No places match', { cols: 13, key: (p) => p.id });
  },
};

// ----- Activity -----
const activityView = {
  mount(v) {
    v.innerHTML = `
      <p class="hint">Changes people made in the app, sign-ins (including failed ones) and app connections, since the server started.</p>
      <div class="tbl-wrap" id="act-wrap" style="max-height:72vh"><table><thead><tr><th>Time</th><th>Person</th><th>What</th><th>Result</th><th class="num">Took</th><th>From</th></tr></thead><tbody id="act-body"></tbody></table></div>`;
  },
  update() {
    const all = [...ev.op.map((e) => ({ ...e, k: 'op' })), ...ev.ws.map((e) => ({ ...e, k: 'ws' }))].sort((a, b) => b.id - a.id).slice(0, 400);
    keepScroll($('#act-wrap'), () => patchRows($('#act-body'), all, (e) => `<tr><td>${fmtTime(e.ts)}</td><td>${esc(e.user)}</td>
        <td class="mono">${esc(e.k === 'ws' ? `app ${e.event}${e.seconds != null ? ` after ${dur(e.seconds * 1000)}` : ''}` : e.op)}</td>
        <td>${e.k === 'ws' ? '' : e.ok ? '<span class="badge good">ok</span>' : `<span class="badge bad">${esc(e.error || 'failed')}</span>`}</td>
        <td class="num">${e.ms != null ? dur(e.ms) : ''}</td><td class="mono">${esc(e.ip || '')}</td></tr>`, 'Nothing yet', { cols: 6 }));
  },
};

// ----- Network -----
const netLabel = (h) => /photon/.test(h) ? 'Search (Photon)' : /r2\.cloudflarestorage|amazonaws|localhost:9500/.test(h) ? 'Storage (R2)' : /frankfurter/.test(h) ? 'Exchange rates'
  : /google/.test(h) || /goo\.gl/.test(h) ? 'Google (links, My Maps)' : /apple/.test(h) ? 'Apple Maps' : h;
const networkView = {
  mount(v) {
    v.innerHTML = `
      <p class="hint">Requests the server made to other services since it started. Storage requests every few seconds are the failover lease and snapshots. <span id="net-fails"></span></p>
      <div class="toolbar"><select class="input" id="nh" aria-label="Service"></select></div>
      <div class="tbl-wrap" id="net-wrap" style="max-height:72vh"><table><thead><tr><th>Time</th><th>Service</th><th>Request</th><th>Status</th><th class="num">Took</th></tr></thead><tbody id="net-body"></tbody></table></div>`;
    $('#nh').onchange = (e) => { ui.netHost = e.target.value; render(); };
  },
  update() {
    const hosts = [...new Set(ev.net.map((e) => netLabel(e.host)))];
    patchSelect($('#nh'), optionsHtml(hosts, ui.netHost, { allLabel: 'All services', esc }));
    const fails = ev.net.filter((e) => !e.status || e.status >= 400).length;
    patchHtml($('#net-fails'), fails ? `<span class="badge bad">${fails} failed</span>` : '');
    const list = ev.net.filter((e) => !ui.netHost || netLabel(e.host) === ui.netHost).slice().reverse();
    keepScroll($('#net-wrap'), () => patchRows($('#net-body'), list, (e) => `<tr><td>${fmtTime(e.ts)}</td><td>${esc(netLabel(e.host))}</td><td class="mono wrap">${esc(e.method)} ${esc(e.path)}</td>
        <td>${e.status && e.status < 400 ? `<span class="badge good">${e.status}</span>` : `<span class="badge bad">${esc(e.status || e.error || 'failed')}</span>`}</td><td class="num">${dur(e.ms)}</td></tr>`, 'No outbound requests yet', { cols: 5 }));
  },
};

// ----- App errors -----
// Errors from people's browsers (the app reports them, at most 30 per person per server start)
const clientView = {
  mount(v) {
    v.innerHTML = `
      <p class="hint">JavaScript errors from people’s phones and computers since the server started, newest first. Useful when someone says a button “doesn’t work”.</p>
      <div class="tbl-wrap" id="cl-wrap"><table><thead><tr><th>When</th><th>Person</th><th>Error</th><th>Where</th><th>Screen</th><th>Browser</th></tr></thead><tbody id="cl-body"></tbody></table></div>`;
  },
  update() {
    const list = ev.client.slice().reverse();
    patchRows($('#cl-body'), list, (e) => `<tr><td>${fmtTime(e.ts)}</td><td>${esc(e.user)}</td><td class="mono">${esc(e.msg)}</td><td class="mono hint">${esc(e.where)}</td><td>${esc(e.screen)}</td><td class="hint">${esc(e.ua)}<div>${esc(e.build)}</div></td></tr>`, 'No errors reported since the server started', { cols: 6 });
  },
};

// ----- Server log -----
// New lines follow along only while you're at the bottom; scroll up to read and it stays put.
const logsView = {
  mount(v) {
    v.innerHTML = `
      <div class="toolbar">
        <select class="input" id="ll" aria-label="Which lines">${[['all', 'Everything'], ['problems', 'Warnings and errors']].map(([k, l]) => `<option value="${k}" ${k === ui.logLevel ? 'selected' : ''}>${l}</option>`).join('')}</select>
        <button class="btn small" id="pause"></button>
        <span class="hint" id="logcount"></span>
      </div>
      <div class="tbl-wrap mono" id="logbox" style="max-height:72vh"></div>`;
    $('#ll').onchange = (e) => { ui.logLevel = e.target.value; logsView.update(); const box = $('#logbox'); box.scrollTop = box.scrollHeight; };
    $('#pause').onclick = () => { ui.paused = !ui.paused; logsView.update(); };
    logsView.firstDraw = true;
  },
  update() {
    const list = ev.log.filter((e) => ui.logLevel === 'all' || e.level === ui.logLevel || (ui.logLevel === 'problems' && e.level !== 'log'));
    const pause = $('#pause');
    const label = ui.paused ? 'Resume' : 'Pause';
    if (pause.textContent !== label) pause.textContent = label;
    patchHtml($('#logcount'), ui.paused ? 'Paused: new lines are kept but not shown' : `${list.length} lines kept in memory (newest at the bottom)`);
    if (ui.paused && !logsView.firstDraw) return;
    const box = $('#logbox');
    keepScroll(box, () => patchRows(box, list, (e) => `<div class="logline ${esc(e.level)}"><time>${fmtTime(e.ts)}</time>${esc(e.msg)}</div>`, '<p class="hint" style="padding:12px">No log lines yet</p>'), 'newest-last');
    if (logsView.firstDraw) { box.scrollTop = box.scrollHeight; logsView.firstDraw = false; }
  },
};

const VIEWS = { overview: overviewView, locations: locationsView, owntracks: owntracksView, places: placesView, activity: activityView, network: networkView, client: clientView, logs: logsView };

// ---------- start ----------
(async () => {
  try {
    mountTabs();
    await loadAll();
    render();
    connectStream();
    // Overview figures every 10 seconds, only while the page is in view.
    setInterval(() => { if (!document.hidden) refreshOverview().then(() => tab === 'overview' && scheduleRender(true)).catch(() => {}); }, 10000);
    // Keep "ago" times fresh on the tabs that show them.
    setInterval(() => { if (tab === 'locations' || tab === 'owntracks') scheduleRender(true); }, 15000);
  } catch (e) {
    $('#view').innerHTML = `<div class="panel"><p>${esc(e.message)}</p></div>`;
  }
})();
