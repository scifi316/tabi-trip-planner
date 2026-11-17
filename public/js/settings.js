// Settings screen: account, location sharing, appearance, offline maps, trip, members, data.
import { state, on, emit, op, api, userById, signOutLocal } from './store.js';
import { esc, icon, avatar, toast, ago, openSheet } from './ui.js';
import { deviceSending, syncWatcher, isWatching, requestWake } from './location.js';
import { planPack, downloadPack, mapCacheInfo, clearMapCache } from './offline.js';
import { openImport } from './add.js';
import { meButton, applyTheme } from './main.js';
import { resetTours, maybeStartTour } from './tour.js';
import { openGroups } from './groups.js';
import { getMap } from './map.js';
import { prefsHtml, bindPrefs } from './notifications.js';
import { openPhotoEditor } from './photo.js';
import { ownTracksBadge } from './owntracks.js';
import { recoveryAction, recoveryStatus, openRecoverySetup, openResetLink } from './account.js';

const root = () => document.getElementById('screen-settings');
const COLORS = ['#E60012', '#F39700', '#00A672', '#009BBF', '#8F76D6', '#C1A470', '#00AC9B', '#E85298', '#0079C2', '#6E7681'];
let download = null; // { controller, done, total }

const isShown = () => !root().hidden;
function maybeRender() {
  if (!isShown()) return;
  const a = document.activeElement;
  if (a && root().contains(a) && a.matches('input:not([type=checkbox]), textarea')) return; // don't interrupt typing
  render();
}
['users', 'trip', 'conn', 'outbox', 'activity', 'locations', 'notif-prefs', 'owntracks', 'expense-reset', 'me-recovery'].forEach((e) => on(e, maybeRender));
// Keep "3 min ago" honest while Settings is open
setInterval(() => { if (!document.hidden) maybeRender(); }, 60e3);

const sw = (attr, checked, label) => `<label class="switch"><input type="checkbox" ${attr} ${checked ? 'checked' : ''} aria-label="${esc(label)}"><span></span></label>`;
const seg = (name, value, opts) => `<div class="seg" role="group">${opts.map(([v, l]) => `<button data-${name}="${v}" aria-pressed="${value === v}">${esc(l)}</button>`).join('')}</div>`;

// ---------- account recovery: what the row says, by state ----------
function recoveryHelp(me) {
  const r = me.recovery || {};
  switch (recoveryStatus()) {
    case 'saved': return `Recovery code saved ${ago(r.savedAt || r.setAt)}. If you forget your password, use it on the sign-in screen.`;
    case 'pending': return 'Your code is ready and already works. View it, save it somewhere safe, then hide it.';
    case 'unconfirmed': return `Made ${ago(r.setAt)}. Did you save it? If not, make a new one.`;
    default: return 'Not set up. If you forget your password, a trip admin will have to send you a reset link.';
  }
}
function recoveryButtons() {
  switch (recoveryStatus()) {
    case 'saved': return '<button class="btn small" data-recovery>New code</button>';
    case 'pending': return '<button class="btn small primary" data-recovery>View code</button>';
    case 'unconfirmed': return '<div class="btn-pair"><button class="btn small" data-recovery-new>New code</button><button class="btn small primary" data-recovery>I saved it</button></div>';
    default: return '<button class="btn small primary" data-recovery>Set up</button>';
  }
}
// A reminder at the top of Settings until the code is saved
function recoveryBanner() {
  const st = recoveryStatus();
  if (st === 'saved' || !state.me?.recovery) return '';
  const [title, text, btn] = st === 'pending'
    ? ['Save your recovery code', 'It’s ready, but you haven’t confirmed saving it. It stays here until you do.', 'View code']
    : st === 'unconfirmed'
      ? ['Did you save your recovery code?', 'Tell us you have it, or make a new one.', 'Check']
      : ['Protect your account', 'A recovery code lets you reset a forgotten password yourself.', 'Set up'];
  return `<div class="rc-banner" role="note">${icon('lock')}<div class="grow"><b>${esc(title)}</b><div class="help">${esc(text)}</div></div>
    <button class="btn small primary" data-recovery>${esc(btn)}</button></div>`;
}

export function render() {
  const el = root();
  const me = state.me || {};
  const tr = state.trip;
  const admin = me.isAdmin;
  const theme = localStorage.getItem('tabi.theme') || 'system';
  const labels = localStorage.getItem('tabi.labels') || 'both';
  const gate = state.config.gate ? `gate=${state.config.gate}&` : '';
  const invite = tr.joinCode ? `${location.origin}/?${gate}join=${tr.joinCode}` : '';
  const pending = state.outbox.length;

  el.innerHTML = `
  <div class="page">
    <header class="page-head">${meButton()}<div class="grow"><h1>Settings</h1>
      <div class="sub">${state.conn === 'online' ? 'Connected' : state.conn === 'connecting' ? 'Connecting…' : 'Offline'}${pending ? `, ${pending} change${pending > 1 ? 's' : ''} waiting to sync` : ''}</div></div></header>

    ${recoveryBanner()}
    <section class="section"><h2>You</h2><div class="card">
      <div class="row"><button class="photo-btn" data-photo aria-label="Change your profile photo">${avatar(me, 'big')}<span class="photo-cam">${icon('camera', 'small')}</span></button>
        <div class="grow"><div class="label">${esc(me.name)}</div><div class="help">${admin ? 'Trip admin' : 'Member'}</div></div>
        <button class="btn small" data-rename>Rename</button></div>
      <div class="row"><div class="grow"><div class="label">Profile photo</div><div class="help">${me.avatar ? 'Shown on the map and next to everything you do.' : 'Your initials are shown until you add one.'}</div></div>
        <button class="btn small" data-photo>${me.avatar ? 'Change' : 'Add photo'}</button></div>
      <div class="row stack"><div class="label">Your colour</div>
        <div class="colors" style="margin-top:8px">${COLORS.map((c) => `<button class="color-dot" style="--c:${c}" data-color="${c}" aria-label="Colour ${c}" aria-pressed="${me.color === c}"></button>`).join('')}</div></div>
      <div class="row"><div class="grow label">Password</div><button class="btn small" data-password>Change</button></div>
      <div class="row" data-section="recovery"><div class="grow"><div class="label">Account recovery</div><div class="help">${recoveryHelp(me)}</div></div>
        ${recoveryButtons()}</div>
      <div class="row"><div class="grow"><div class="label">Signed-in devices</div><div class="help">See where you’re signed in, and sign out the others.</div></div><button class="btn small" data-devices>Devices</button></div>
      <div class="row"><div class="grow label">Sign out of this device</div><button class="btn small danger" data-signout>Sign out</button></div>
      <div class="row"><div class="grow"><div class="label">Leave the trip</div><div class="help">Your expenses and balances stay, so everyone’s totals remain right.</div></div>
        <button class="btn small danger" data-leave>Leave…</button></div>
    </div></section>

    <section class="section" data-section="location"><h2>Location sharing</h2><div class="card">
      <div class="row"><div class="grow"><div class="label">Share my location with the group</div>
        <div class="help">${me.shareLocation ? 'Friends can see where you are.' : 'Off. Nobody can see where you are.'}</div></div>
        ${sw('data-share', me.shareLocation, 'Share my location')}</div>
      ${me.shareLocation ? `
      <div class="row"><div class="grow"><div class="label">Send from this device</div>
        <div class="help">${deviceSending() ? (isWatching() ? 'Sending while Tabi is open.' : 'Will send while Tabi is open.') : 'Off here. Use this if another phone is your main device.'}</div></div>
        ${sw('data-device', deviceSending(), 'Send from this device')}</div>
      <div class="row"><div class="grow"><div class="label">Keep screen on</div>
        <div class="help">Stops the phone sleeping while Tabi is open, so updates keep flowing.</div></div>
        ${sw('data-wake', localStorage.getItem('tabi.wake') === 'on', 'Keep screen on')}</div>` : ''}
      <div class="row stack">
        <div class="label">Share even when Tabi is closed</div>
        <div class="help">Browsers stop location when a web app is in the background. For always-on sharing like Find My, install the free OwnTracks app (iOS and Android) and point it at Tabi.</div>
        ${ownTracksBadge(me.owntracks, { sharing: me.shareLocation })}
        <button class="btn small" data-owntracks style="margin-top:10px;align-self:flex-start">${me.owntracks?.at ? 'OwnTracks settings' : 'Set up OwnTracks'}</button>
      </div>
    </div></section>

    <section class="section" data-section="notifications"><h2>Notifications</h2><div class="card">
      <div class="row stack"><div class="help">New ones show as a red ! on your picture at the top left. Tap it to read them. Choose what you want to hear about:</div></div>
      ${prefsHtml()}
    </div></section>

    <section class="section"><h2>Appearance</h2><div class="card">
      <div class="row stack"><div class="label" style="margin-bottom:8px">Theme</div>${seg('themepick', theme, [['system', 'Match phone'], ['light', 'Light'], ['dark', 'Dark']])}</div>
      <div class="row stack"><div class="label" style="margin-bottom:8px">Map labels</div>${seg('labels', labels, [['both', 'Both'], ['en', 'English'], ['ja', '日本語']])}</div>
      <div class="row"><div class="grow"><div class="label">Tips</div><div class="help">Replay the short tours of each screen.</div></div><button class="btn small" data-tips>Show tips again</button></div>
    </div></section>

    <section class="section" data-section="offline"><h2>Offline maps</h2><div class="card">
      <div class="row stack"><div class="help" data-cache-info>Checking saved maps…</div>
        ${download ? `<div class="progress" style="margin-top:10px"><div style="width:${download.total ? (download.done / download.total) * 100 : 0}%"></div></div>
          <div class="help num" style="margin-top:6px">${download.done} of ${download.total} files</div>` : ''}
      </div>
      <div class="row" style="flex-wrap:wrap;gap:8px">
        ${download ? `<button class="btn small" data-cancel-dl>Stop download</button>` : `
        <button class="btn small primary" data-dl="stops">${icon('download')}Save maps around all places</button>
        <button class="btn small" data-dl="view">${icon('download')}Save this map area</button>
        <button class="btn small danger" data-clear-maps>Clear</button>`}
      </div>
    </div></section>

    <section class="section"><h2>Trip</h2><div class="card">
      ${admin ? `
      <div class="row stack">
        <label class="field"><span>Trip name</span><input class="input" data-trip="name" value="${esc(tr.name || '')}"></label>
        <div class="inline-fields">
          <label class="field"><span>First day</span><input class="input" type="date" data-trip="start" value="${esc(tr.start || '')}"></label>
          <label class="field"><span>Last day</span><input class="input" type="date" data-trip="end" value="${esc(tr.end || '')}"></label>
        </div>
      </div>` : `<div class="row"><div class="grow"><div class="label">${esc(tr.name)}</div><div class="help">${tr.start ? `${esc(tr.start)} to ${esc(tr.end || '?')}` : 'No dates set yet'}. Only admins can change trip details.</div></div></div>`}
      <div class="row stack"><div class="label">Invite friends</div>
        <div class="help" style="margin:2px 0 8px">Anyone with this link can join the trip.</div>
        <div class="code">${esc(invite)}</div>
        <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap">
          <button class="btn small primary" data-share-invite>${icon('share')}Share link</button>
          <button class="btn small" data-copy="${esc(invite)}">${icon('copy')}Copy</button>
          ${admin ? `<button class="btn small" data-newcode>New link</button>` : ''}
        </div></div>
      <div class="row stack"><div class="label">Vetoes</div><div class="help" style="margin:2px 0 8px">What happens when someone vetoes a place.</div>
        ${admin ? seg('veto', tr.vetoRule, [['single', 'One veto removes it'], ['majority', 'Majority'], ['off', 'Counts as a no']]) : `<div class="help">${({ single: 'One veto removes a place.', majority: 'A place is removed when over half the group vetoes it.', off: 'A veto counts as a no vote.' })[tr.vetoRule]}</div>`}</div>
      <div class="row"><div class="grow"><div class="label">Auto-confirm</div><div class="help">Confirm a place automatically when this many people want to go. 0 turns it off.</div></div>
        ${admin ? `<input class="input num" type="number" min="0" max="50" data-trip="autoConfirm" value="${tr.autoConfirm || 0}" style="width:76px">` : `<b class="num">${tr.autoConfirm || 'Off'}</b>`}</div>
      <div class="row"><div class="grow"><div class="label">Trip currency</div><div class="help">Balances are added up in this currency. It’s fixed once expenses exist.</div></div>
        ${admin && !state.expenses.size ? `<select class="input" data-trip="currency" style="width:96px">${(state.config.currencies || ['JPY']).map((c) => `<option ${c === tr.currency ? 'selected' : ''}>${c}</option>`).join('')}</select>` : `<b>${esc(tr.currency || 'JPY')}</b>`}</div>
    </div></section>

    <section class="section"><h2>Group</h2><div class="card">
      <div class="row"><div class="grow"><div class="label">Subgroups</div><div class="help">${state.subgroups.length ? `${state.subgroups.length} subgroup${state.subgroups.length > 1 ? 's' : ''}` : 'For when the group splits up for a day or two.'}</div></div>
        <button class="btn small" data-subgroups>${icon('users')}Manage</button></div>
      ${state.users.map((u) => `
        <div class="row member">${avatar(u)}<div class="grow"><div class="label">${esc(u.name)}${u.id === me.id ? ' <span class="faint">(you)</span>' : ''}</div>
          <div class="help">${state.online.includes(u.id) ? 'Online' : 'Offline'}${u.shareLocation ? (state.locations[u.id] ? `, location ${ago(state.locations[u.id].ts)}` : ', sharing location') : ''}${admin && !u.hasRecovery ? ', no recovery code' : admin && u.recoverySaved === false ? ', recovery code not saved yet' : ''}</div></div>
          ${u.isAdmin ? '<span class="tag">Admin</span>' : ''}
          ${admin && u.id !== me.id ? `<button class="btn small" data-member="${u.id}">Manage</button>` : ''}
        </div>`).join('')}
    </div></section>
    ${admin && state.formerUsers.length ? `
    <section class="section" data-section="former"><h2>Former members</h2><div class="card">
      <div class="row stack"><div class="help">Removed, or left the trip. They can’t sign in, but their expenses still count in everyone’s balances.</div></div>
      ${state.formerUsers.map((u) => `
        <div class="row member">${avatar(u)}<div class="grow"><div class="label">${esc(u.name)}</div><div class="help">Left ${ago(u.removedAt)}</div></div>
          <button class="btn small" data-merge="${u.id}">Merge into…</button>
          <button class="btn small" data-bring-back="${u.id}">Bring back</button></div>`).join('')}
    </div></section>` : ''}

    <section class="section"><h2>Places data</h2><div class="card">
      <div class="row"><div class="grow"><div class="label">Import places</div><div class="help">Google My Maps, links, KML, GeoJSON, GPX, CSV</div></div>
        <button class="btn small" data-import>Import</button></div>
      <div class="row"><div class="grow"><div class="label">Export a backup</div><div class="help">KML opens in Google My Maps and Google Earth.</div></div>
        <button class="btn small" data-export="kml">KML</button><button class="btn small" data-export="json">JSON</button></div>
      <div class="row"><div class="grow"><div class="label">Export expenses</div><div class="help">Every expense you can see, as a spreadsheet.</div></div>
        <button class="btn small" data-export="expenses">CSV</button></div>
    </div></section>
    ${admin ? `
    <section class="section" data-section="admin-expenses"><h2>Expenses (admins)</h2><div class="card">
      <div class="row"><div class="grow"><div class="label">Clear all expenses</div><div class="help">Removes every expense and payment for everyone, so balances start from zero. Useful after test entries or mistakes. You can bring them back afterwards.</div></div>
        <button class="btn small danger" data-reset-expenses>Clear…</button></div>
      ${state.expenseReset ? `<div class="row"><div class="grow"><div class="label">Last cleared ${ago(state.expenseReset.at)}</div><div class="help">${state.expenseReset.count} expense${state.expenseReset.count === 1 ? '' : 's'}, by ${esc(state.expenseReset.by)}.</div></div>
        <button class="btn small" data-restore-expenses>Bring back</button></div>` : ''}
    </div></section>` : ''}

    <section class="section" data-section="activity"><h2>Recent activity</h2><div class="card">
      <div class="row act-search"><label class="search-field">${icon('search', 'small')}<input type="search" class="input" data-act-q placeholder="Search activity" aria-label="Search activity" value="${esc(act.q)}" autocomplete="off" enterkeyhint="search"></label></div>
      <div data-act-list>${activityListHtml()}</div>
    </div></section>

    <p class="faint" style="font-size:12px;margin:0 20px 10px">Tabi ${esc(state.config.version || '')}. Map data © OpenStreetMap contributors, tiles by OpenFreeMap / OpenMapTiles, search by Photon. Directions open in Google Maps.</p>
  </div>`;

  bind(el);
  mapCacheInfo().then((i) => {
    const t = el.querySelector('[data-cache-info]');
    if (t) t.textContent = i.entries
      ? `${i.entries.toLocaleString()} map files saved on this device (${(i.usage / 1048576).toFixed(0)} MB used by Tabi). Saved areas work without a connection.`
      : 'No maps saved yet. Save them on Wi-Fi before you fly. Areas you browse are also kept automatically.';
  }).catch(() => {});
}

function bind(el) {
  const me = state.me;
  el.querySelectorAll('[data-color]').forEach((b) => b.onclick = () => op('user.update', { color: b.dataset.color }));
  el.querySelector('[data-rename]').onclick = () => promptSheet('Your name', me.name, async (v) => {
    const r = await op('user.update', { name: v });
    if (r.ok === false) throw new Error(r.error);
  });
  el.querySelector('[data-password]').onclick = passwordSheet;
  const q = el.querySelector('[data-act-q]');
  q.oninput = onActivitySearch;
  q.onkeydown = (e) => { if (e.key === 'Escape' && q.value) { q.value = ''; onActivitySearch({ target: q }); } };
  renderActivityList();
  el.querySelectorAll('[data-recovery]').forEach((b) => b.onclick = () => recoveryAction());
  el.querySelector('[data-recovery-new]')?.addEventListener('click', () => openRecoverySetup({ replacing: true }));
  el.querySelector('[data-leave]').onclick = leaveSheet;
  el.querySelectorAll('[data-merge]').forEach((b) => b.onclick = () => mergeSheet(userById(+b.dataset.merge)));
  el.querySelectorAll('[data-bring-back]').forEach((b) => b.onclick = async () => {
    const u = userById(+b.dataset.bringBack);
    const r = await op('user.restore', { id: u.id });
    if (r.ok === false) return toast(r.error);
    if (r.canSignIn) toast(`${u.name} is back on the trip and can sign in with their old password`);
    else { toast(`${u.name} is back. They need a password first, so here’s a reset link.`); openResetLink(u); }
  });
  el.querySelectorAll('[data-photo]').forEach((b) => b.onclick = () => openPhotoEditor());
  bindPrefs(el);
  el.querySelector('[data-signout]').onclick = async () => {
    try { await api('/api/logout', { method: 'POST' }); } catch { /* offline */ }
    signOutLocal();
    location.href = '/';
  };

  el.querySelector('[data-share]').onchange = async (e) => {
    const on = e.target.checked;
    const r = await op('loc.share', { on });
    if (r.ok === false) { toast(r.error); e.target.checked = !on; return; }
    if (on) toast('Sharing on. Your location updates while Tabi is open.');
  };
  el.querySelector('[data-device]')?.addEventListener('change', (e) => {
    localStorage.setItem('tabi.gps.device', e.target.checked ? 'on' : 'off');
    syncWatcher(); render();
  });
  el.querySelector('[data-wake]')?.addEventListener('change', (e) => {
    localStorage.setItem('tabi.wake', e.target.checked ? 'on' : 'off');
    if (e.target.checked) requestWake();
  });
  el.querySelector('[data-owntracks]').onclick = ownTracksSheet;
  el.querySelector('[data-reset-expenses]')?.addEventListener('click', resetExpensesSheet);
  el.querySelector('[data-restore-expenses]')?.addEventListener('click', () => restoreExpenses(state.expenseReset));

  el.querySelectorAll('[data-themepick]').forEach((b) => b.onclick = () => { localStorage.setItem('tabi.theme', b.dataset.themepick); applyTheme(); render(); });
  el.querySelectorAll('[data-labels]').forEach((b) => b.onclick = () => { localStorage.setItem('tabi.labels', b.dataset.labels); emit('labels'); render(); });

  el.querySelectorAll('[data-dl]').forEach((b) => b.onclick = () => startDownload(b.dataset.dl));
  el.querySelector('[data-cancel-dl]')?.addEventListener('click', () => download?.controller.abort());
  el.querySelector('[data-clear-maps]')?.addEventListener('click', async (e) => {
    const b = e.currentTarget;
    if (!b.dataset.armed) { b.dataset.armed = 1; b.textContent = 'Tap again to clear'; return; }
    await clearMapCache(); toast('Saved maps cleared'); render();
  });

  el.querySelectorAll('[data-trip]').forEach((i) => i.onchange = async () => {
    const r = await op('trip.update', { [i.dataset.trip]: i.value });
    if (r.ok === false) toast(r.error); else toast('Trip updated');
  });
  el.querySelectorAll('[data-veto]').forEach((b) => b.onclick = () => op('trip.update', { vetoRule: b.dataset.veto }));
  el.querySelector('[data-newcode]')?.addEventListener('click', async () => { await op('trip.newCode'); toast('New invite link made. The old one no longer works.'); });
  el.querySelectorAll('[data-copy]').forEach((b) => b.onclick = () => copy(b.dataset.copy));
  el.querySelector('[data-share-invite]').onclick = async () => {
    const url = `${location.origin}/?join=${state.trip.joinCode}`;
    if (navigator.share) { try { await navigator.share({ title: state.trip.name, text: `Join our trip planner for ${state.trip.name}`, url }); } catch { /* cancelled */ } }
    else copy(url);
  };
  el.querySelectorAll('[data-member]').forEach((b) => b.onclick = () => memberSheet(+b.dataset.member));
  el.querySelector('[data-import]').onclick = () => openImport('mymaps');
  el.querySelector('[data-subgroups]').onclick = () => openGroups();
  el.querySelector('[data-tips]').onclick = () => { resetTours(); toast('Tips will show again on each screen.'); maybeStartTour('settings', { delay: 200, force: true }); };
  el.querySelector('[data-devices]').onclick = devicesSheet;
  el.querySelectorAll('[data-export]').forEach((b) => b.onclick = async () => {
    try {
      const res = await api(`/api/export?format=${b.dataset.export}`, { raw: true });
      const blob = await res.blob();
      const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: b.dataset.export === 'expenses' ? 'tabi-expenses.csv' : `tabi-trip.${b.dataset.export}` });
      a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    } catch (e) { toast(e.message); }
  });
}

async function copy(text) {
  try { await navigator.clipboard.writeText(text); toast('Copied'); }
  catch { toast('Copy failed. Press and hold the text to copy it.'); }
}

async function startDownload(kind) {
  const controller = new AbortController();
  download = { controller, done: 0, total: 0 };
  render();
  try {
    const map = getMap();
    const b = map?.getBounds();
    const plan = await planPack(kind, b ? { bounds: { w: b.getWest(), e: b.getEast(), s: b.getSouth(), n: b.getNorth() }, zoom: map.getZoom() } : {});
    let lastPaint = 0;
    const res = await downloadPack(plan, {
      limit: state.config.offlineTileLimit || 3000,
      signal: controller.signal,
      onProgress: (d, t) => {
        download.done = d; download.total = t;
        if (Date.now() - lastPaint > 250) { lastPaint = Date.now(); maybeRender(); }
      },
    });
    toast(controller.signal.aborted ? 'Download stopped. What finished is saved.'
      : res.remaining ? `Saved ${res.downloaded} files. ${res.remaining} more remain: run it again later to continue.`
        : res.downloaded ? `Saved ${res.downloaded} map files for offline use` : 'Everything here was already saved', { ms: 5000 });
  } catch (e) {
    toast(`Map download failed: ${e.message}`);
  } finally {
    download = null;
    if (isShown()) render();
  }
}

function promptSheet(title, value, save) {
  const s = openSheet({
    title,
    body: `<input class="input" data-v value="${esc(value || '')}" maxlength="24" autofocus><p class="err" data-err hidden></p>`,
    foot: `<button class="btn" data-close>Cancel</button><button class="btn primary" data-save>Save</button>`,
  });
  s.el.querySelector('[data-save]').onclick = async () => {
    const v = s.el.querySelector('[data-v]').value.trim();
    if (!v) return;
    try { await save(v); s.close(); } catch (e) { const er = s.el.querySelector('[data-err]'); er.hidden = false; er.textContent = e.message; }
  };
}

function passwordSheet() {
  const s = openSheet({
    title: 'Change password',
    body: `<label class="field"><span>Current password</span><input class="input" type="password" data-cur autocomplete="current-password" autofocus></label>
      <label class="field"><span>New password</span><input class="input" type="password" data-new autocomplete="new-password"></label><p class="err" data-err hidden></p>`,
    foot: `<button class="btn" data-close>Cancel</button><button class="btn primary" data-save>Change password</button>`,
  });
  s.el.querySelector('[data-save]').onclick = async () => {
    try {
      await api('/api/password', { method: 'POST', body: { current: s.el.querySelector('[data-cur]').value, next: s.el.querySelector('[data-new]').value } });
      s.close(); toast('Password changed');
    } catch (e) { const er = s.el.querySelector('[data-err]'); er.hidden = false; er.textContent = e.message; }
  };
}

// Admins: clear every expense (or just the shared ones). Typed confirmation, then an Undo.
async function resetExpensesSheet() {
  const r = await op('expense.resetPreview');
  if (r.ok === false) return toast(r.error || 'You need to be online to do this.');
  const c = r.counts;
  const total = c.expenses + c.payments;
  if (!total) return toast('There are no expenses to clear.');
  const s = openSheet({
    title: 'Clear all expenses?',
    sub: 'Balances go back to zero for everyone.',
    body: `
      <p class="hint" style="font-size:14.5px;margin-top:0">This removes <b>${c.expenses} expense${c.expenses === 1 ? '' : 's'}</b> and <b>${c.payments} payment${c.payments === 1 ? '' : 's'}</b>. Everyone involved gets a notification. You can bring them back from Settings afterwards.</p>
      ${c.private ? `<div class="seg" role="group" aria-label="What to clear" style="margin-bottom:14px">
        <button data-scope="all" aria-pressed="true">Everything (${total})</button>
        <button data-scope="shared" aria-pressed="false">Shared only (${total - c.private})</button></div>
        <p class="help" data-scope-help style="margin:-6px 2px 14px">Includes ${c.private} private expense${c.private === 1 ? '' : 's'} between people, which you can’t see.</p>` : ''}
      <label class="field"><span>Type CLEAR to confirm</span><input class="input" data-confirm autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="CLEAR"></label>
      <p class="err" data-err hidden></p>`,
    foot: `<button class="btn" data-close>Cancel</button><button class="btn danger-fill" data-go disabled>Clear expenses</button>`,
  });
  let scope = 'all';
  const go = s.el.querySelector('[data-go]');
  const input = s.el.querySelector('[data-confirm]');
  input.oninput = () => { go.disabled = input.value.trim().toUpperCase() !== 'CLEAR'; };
  s.el.querySelectorAll('[data-scope]').forEach((b) => b.onclick = () => {
    scope = b.dataset.scope;
    s.el.querySelectorAll('[data-scope]').forEach((x) => x.setAttribute('aria-pressed', x === b));
    s.el.querySelector('[data-scope-help]').textContent = scope === 'all'
      ? `Includes ${c.private} private expense${c.private === 1 ? '' : 's'} between people, which you can’t see.`
      : `Keeps ${c.private} private expense${c.private === 1 ? '' : 's'} between people.`;
  });
  go.onclick = async () => {
    go.disabled = true;
    const res = await op('expense.reset', { scope, confirm: 'CLEAR' });
    if (res.ok === false) { const e = s.el.querySelector('[data-err]'); e.hidden = false; e.textContent = res.error; go.disabled = false; return; }
    s.close();
    toast(`Cleared ${res.count} expense${res.count === 1 ? '' : 's'}`, { action: 'Undo', onAction: () => restoreExpenses({ batch: res.batch, count: res.count }), ms: 10000 });
  };
  input.focus();
}
async function restoreExpenses(info) {
  if (!info?.batch) return;
  const r = await op('expense.restoreReset', { batch: info.batch });
  toast(r.ok === false ? r.error : `Brought back ${r.count} expense${r.count === 1 ? '' : 's'}`);
}

function ownTracksSheet() {
  const me = state.me;
  const url = `${location.origin}/api/owntracks${state.config.gate ? `?gate=${state.config.gate}` : ''}`;
  const s = openSheet({
    title: 'Always-on sharing with OwnTracks',
    sub: 'Free, open source, and keeps sharing when your phone is locked.',
    body: `
      <div data-ot-live>${ownTracksBadge(me.owntracks, { sharing: me.shareLocation })}</div>
      <div class="hint"><ol>
        <li>Install <b>OwnTracks</b> from the App Store or Google Play.</li>
        <li>Open its settings and set the mode to <b>HTTP</b>.</li>
        <li>Enter the URL, user ID and password below. Leave Device ID as anything, like “phone”.</li>
        <li>Choose <b>Significant</b> or <b>Move</b> monitoring. Significant saves battery.</li>
        <li>Make sure “Share my location with the group” is on in Tabi.</li>
      </ol></div>
      <label class="field"><span>URL</span><div class="code" data-copy-v>${esc(url)}</div></label>
      <label class="field"><span>User ID / username</span><div class="code" data-copy-v>${esc(me.name)}</div></label>
      <label class="field"><span>Password (token)</span><div class="code" data-copy-v data-tok>${esc(me.owntracksToken || '')}</div></label>
      <p class="hint">Tap a value to copy it. Friends who share will also show up inside OwnTracks. The token is separate from your Tabi password; make a new one if it leaks.</p>
      <p class="hint">To test it, tap the upload button (the arrow at the top) in OwnTracks. The status at the top of this sheet changes as soon as Tabi hears from it.</p>
      <button class="btn small" data-reset>Make a new token</button>`,
  });
  // Live status while you're setting it up
  const off = on('owntracks', () => {
    if (s.closed) return off();
    s.el.querySelector('[data-ot-live]').innerHTML = ownTracksBadge(state.me.owntracks, { sharing: state.me.shareLocation });
  });
  s.el.querySelectorAll('[data-copy-v]').forEach((c) => c.onclick = () => copy(c.textContent.trim()));
  s.el.querySelector('[data-reset]').onclick = async () => {
    const r = await op('user.owntracksReset');
    if (r.token) { state.me.owntracksToken = r.token; s.el.querySelector('[data-tok]').textContent = r.token; toast('New token made. Update it in OwnTracks.'); }
    else toast(r.error || 'Could not make a new token while offline');
  };
}

// A former member who rejoined under a new name: move their old expenses onto the new account.
function mergeSheet(old) {
  const counts = [...state.expenses.values()].filter((e) => e.paidBy === old.id || e.shares.some((x) => x.userId === old.id)).length;
  const s = openSheet({
    title: `Merge ${old.name}’s old account`,
    sub: 'For someone who was removed and joined again under a new name.',
    body: `
      <p class="hint" style="margin-top:0">${counts ? `${counts} expense${counts === 1 ? '' : 's'} you can see` : 'Any expenses'}, places and history from <b>${esc(old.name)}</b> move to the account you choose. Balances add up exactly as before. ${esc(old.name)} then disappears from the list. This can’t be undone.</p>
      <label class="field"><span>Move everything to</span><select class="input" data-into><option value="">Choose a person…</option>${state.users.map((u) => `<option value="${u.id}">${esc(u.name)}</option>`).join('')}</select></label>`,
    foot: '<button class="btn" data-close>Cancel</button><button class="btn danger-fill" data-go disabled>Merge</button>',
  });
  const sel = s.el.querySelector('[data-into]'), go = s.el.querySelector('[data-go]');
  sel.onchange = () => { go.disabled = !sel.value; go.textContent = sel.value ? `Merge into ${userById(+sel.value).name}` : 'Merge'; };
  go.onclick = async () => {
    go.disabled = true;
    const r = await op('user.merge', { from: old.id, into: +sel.value });
    if (r.ok === false) { toast(r.error); go.disabled = false; return; }
    toast(`Merged. ${old.name}’s expenses now count for ${userById(+sel.value).name}.`);
    s.close();
  };
}

function leaveSheet() {
  const s = openSheet({
    title: 'Leave the trip?',
    body: `<p class="hint" style="margin-top:0;font-size:14.5px">You’ll be signed out everywhere and won’t be able to sign in. Your expenses stay, so everyone’s balances remain right, and you still owe or are owed what you do now. A trip admin can bring your account back later.</p>`,
    foot: '<button class="btn" data-close>Stay</button><button class="btn danger-fill" data-go>Leave the trip</button>',
  });
  s.el.querySelector('[data-go]').onclick = async () => {
    const r = await op('user.leave');
    if (r.ok === false) return toast(r.error);
    s.close();
  };
}

// ---------- recent activity: latest 10, "Show more", and search over the server's history ----------
// Kept outside render() because Settings redraws often (people coming online, locations…).
const PAGE = 10, MORE = 20;
const act = { q: '', shown: PAGE, older: [], more: true, results: null, total: null, loading: false, offline: false };

const highlight = (text, q) => {
  const t = esc(text);
  if (!q) return t;
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  return i < 0 ? t : `${esc(text.slice(0, i))}<mark>${esc(text.slice(i, i + q.length))}</mark>${esc(text.slice(i + q.length))}`;
};
const actRow = (a, q) => `<div class="row activity">${avatar(userById(a.userId))}<div class="grow">${highlight(a.text, q)}<time title="${esc(new Date(a.ts).toLocaleString())}">${ago(a.ts)}</time></div></div>`;

function activityListHtml() {
  if (act.q) {
    if (!act.results) return '<div class="row help">Searching…</div>';
    const n = act.results.length;
    return `<div class="row help act-count" role="status">${n ? `${act.total ?? n} match${(act.total ?? n) === 1 ? '' : 'es'}${act.offline ? ', on this phone only (offline)' : ''}` : `Nothing matches “${esc(act.q)}”.`}</div>
      ${act.results.map((a) => actRow(a, act.q)).join('')}
      ${act.more && !act.offline ? '<div class="row act-more"><button class="btn small" data-act-more>Show more</button></div>' : ''}`;
  }
  const all = [...state.activity, ...act.older.filter((o) => !state.activity.some((a) => a.id === o.id))];
  if (!all.length) return '<div class="row help">Nothing yet.</div>';
  const list = all.slice(0, act.shown);
  const canMore = all.length > act.shown || act.more;
  return `${list.map((a) => actRow(a)).join('')}
    <div class="row act-more">${canMore ? '<button class="btn small" data-act-more>Show more</button>' : ''}
      ${act.shown > PAGE ? '<button class="btn small ghost" data-act-less>Show less</button>' : ''}</div>`;
}

function renderActivityList() {
  const box = root().querySelector('[data-act-list]');
  if (!box) return;
  box.innerHTML = activityListHtml();
  box.querySelector('[data-act-more]')?.addEventListener('click', showMoreActivity);
  box.querySelector('[data-act-less]')?.addEventListener('click', () => { act.shown = PAGE; act.older = []; act.more = true; renderActivityList(); });
}

async function fetchActivity(before) {
  const qs = new URLSearchParams({ limit: MORE, ...(act.q ? { q: act.q } : {}), ...(before ? { before } : {}) });
  return api(`/api/activity?${qs}`);
}

async function showMoreActivity() {
  if (act.loading) return;
  if (act.q) {
    act.loading = true;
    try { const r = await fetchActivity(act.results.at(-1)?.id); act.results.push(...r.items); act.more = r.more; } catch { act.more = false; }
    act.loading = false;
    return renderActivityList();
  }
  const have = state.activity.length + act.older.length;
  if (act.shown + MORE <= have || !act.more) { act.shown += MORE; return renderActivityList(); }
  // Past what this phone has: page further back from the server
  act.loading = true;
  const last = [...state.activity, ...act.older].at(-1);
  try { const r = await fetchActivity(last?.id); act.older.push(...r.items); act.more = r.more; } catch { act.more = false; }
  act.loading = false;
  act.shown += MORE;
  renderActivityList();
}

let actTimer, actSeq = 0;
function onActivitySearch(e) {
  act.q = e.target.value.trim();
  clearTimeout(actTimer);
  if (!act.q) { act.results = null; return renderActivityList(); }
  act.results = null;
  actTimer = setTimeout(async () => {
    const seq = ++actSeq, q = act.q;
    try {
      const r = await fetchActivity();
      if (seq !== actSeq || q !== act.q) return; // a newer search started
      Object.assign(act, { results: r.items, more: r.more, total: r.total, offline: false });
    } catch {
      // Offline: search what this phone has
      const local = [...state.activity, ...act.older].filter((a) => a.text.toLowerCase().includes(q.toLowerCase()));
      Object.assign(act, { results: local, more: false, total: local.length, offline: true });
    }
    renderActivityList();
  }, 250);
  renderActivityList();
}

function memberSheet(id) {
  const u = userById(id);
  if (!u) return;
  const s = openSheet({
    title: u.name,
    body: `<div class="card" style="margin:0">
      <div class="row"><div class="grow"><div class="label">Trip admin</div><div class="help">Admins can change trip details, invite links and members.</div></div>
        ${sw('data-admin', u.isAdmin, 'Trip admin')}</div>
      <div class="row"><div class="grow"><div class="label">Forgot their password?</div><div class="help">Make a one-time link that lets ${esc(u.name)} set a new one. Their account and expenses stay. ${u.hasRecovery ? `${esc(u.name)} also has a recovery code they can use themselves.` : `${esc(u.name)} hasn’t set up a recovery code.`}</div></div>
        <button class="btn small" data-reset-link>Reset link</button></div>
      <div class="row"><div class="grow"><div class="label">Remove from trip</div><div class="help">They’re signed out and can’t sign in, and their votes are removed. Their expenses and balances stay, and you can bring them back later.</div></div>
        <button class="btn small danger" data-remove>Remove</button></div></div>`,
  });
  s.el.querySelector('[data-reset-link]').onclick = () => { s.close(); openResetLink(u); };
  s.el.querySelector('[data-admin]').onchange = async (e) => { const r = await op('user.admin', { id, on: e.target.checked }); if (r.ok === false) toast(r.error); };
  const rm = s.el.querySelector('[data-remove]');
  rm.onclick = async () => {
    if (!rm.dataset.armed) { rm.dataset.armed = 1; rm.textContent = 'Tap again to remove'; return; }
    const r = await op('user.remove', { id });
    if (r.ok === false) toast(r.error); else { toast(`${u.name} removed`); s.close(); }
  };
}

export function showSettings() { render(); }

async function devicesSheet() {
  const s = openSheet({ title: 'Signed-in devices', body: '<p class="hint">Loading…</p>' });
  try {
    const { sessions } = await api('/api/sessions');
    s.body.innerHTML = `<div class="card" style="margin:0;border:1px solid var(--line)">${sessions.map((x) => `
      <div class="row"><div class="grow"><div class="label">${esc(x.device)}${x.current ? ' <span class="tag">This device</span>' : ''}</div>
      <div class="help">Signed in ${ago(x.createdAt)}, last used ${ago(x.lastSeen)}</div></div></div>`).join('')}</div>
      ${sessions.length > 1 ? `<button class="btn danger block" data-others style="margin-top:14px">Sign out all other devices</button>` : ''}`;
    s.body.querySelector('[data-others]')?.addEventListener('click', async () => {
      await api('/api/logout-others', { method: 'POST' });
      toast('Signed out everywhere else');
      s.close();
    });
  } catch (e) { s.body.innerHTML = `<p class="err">${esc(e.message)}</p>`; }
}
