// Boot, sign-in screens, navigation and theme.
import { state, on, emit, api, op, connect, loadCached, markSignedIn, signOutLocal } from './store.js';
import { maybeStartTour } from './tour.js';
import { $, $$, esc, icon, avatar, toast, openSheet, closeAllSheets, closePeekSheets } from './ui.js';
import { listHtml, bindList, markAllRead, unreadCount, clearNotifToasts, clearAll, wideScreen } from './notifications.js';
import './reactions.js';
import { pushNudgeHtml, bindPushNudge } from './push.js';
import { openTarget } from './notifications.js';
import { openPhotoEditor } from './photo.js';
import { forgotScreen, resetScreen, maybePromptRecovery } from './account.js';
import './tooltip.js';
import { rememberApp } from './android.js';
import { lockZoom, resetZoom } from './zoomlock.js';

lockZoom(); // TA-15: the page never pinch-zooms on a phone; the map still does

// TA-13: after turning the phone, an iOS home-screen app can be left zoomed in or scrolled, which shifts the
// fixed layout so taps land in the wrong place until the app is restarted. Once the turn has settled, put the
// zoom back to 100% and the page back at the top (the app's screens scroll inside themselves, never the page).
function settleAfterTurn() {
  if (!$('#app').hidden && (scrollX || scrollY)) scrollTo(0, 0);
  resetZoom();
}
let turnTimers = [];
const onTurn = () => { turnTimers.forEach(clearTimeout); turnTimers = [300, 900].map((ms) => setTimeout(settleAfterTurn, ms)); };
(screen.orientation?.addEventListener ? screen.orientation.addEventListener('change', onTurn) : addEventListener('orientationchange', onTurn));
matchMedia('(orientation: portrait)').addEventListener?.('change', onTurn);

rememberApp(); // opened from the Android app: remember it, tidy the address
addEventListener('hashchange', () => {
  if (location.hash === '#android-app' && state.signedIn) go('settings').then(() => import('./android.js').then((a) => a.openAndroidSheet()));
});

export const LOGO = `<svg class="logo" viewBox="0 0 64 64" aria-hidden="true"><rect width="64" height="64" rx="16" fill="#2B3A67"/>
  <path d="M14 44h36" stroke="#9CAEB7" stroke-width="5" stroke-linecap="round"/><path d="M14 44h18" stroke="#00A672" stroke-width="5" stroke-linecap="round"/>
  <circle cx="14" cy="44" r="5.5" fill="#fff" stroke="#00A672" stroke-width="3.5"/><circle cx="32" cy="44" r="5.5" fill="#fff" stroke="#00A672" stroke-width="3.5"/>
  <circle cx="50" cy="44" r="5.5" fill="#fff" stroke="#9CAEB7" stroke-width="3.5"/>
  <path d="M32 12c-6.1 0-11 4.7-11 10.6C21 30.2 32 38 32 38s11-7.8 11-15.4C43 16.7 38.1 12 32 12Z" fill="#E60012"/><circle cx="32" cy="22.5" r="4" fill="#fff"/></svg>`;

// ---------- theme ----------
export function applyTheme() {
  const t = localStorage.getItem('tabi.theme') || 'system';
  const dark = t === 'dark' || (t === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  emit('theme');
}
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);

// ---------- the avatar button, top-left on every screen ----------
// A red "!" on it means there are unread notifications.
const meLabel = (conn, n) => `Signed in as ${state.me?.name || ''}. ${conn === 'online' ? 'Connected' : 'Offline'}.${n ? ` ${n} unread notification${n > 1 ? 's' : ''}.` : ''}`;
const meInner = (n) => `${avatar(state.me)}${n ? '<span class="me-badge" aria-hidden="true">!</span>' : ''}`;
export function meButton() {
  const conn = !state.me ? 'signed-out' : state.conn === 'online' ? 'online' : 'offline';
  const n = unreadCount();
  return `<button class="me-btn" data-me-btn data-conn="${conn}" aria-label="${esc(meLabel(conn, n))}" data-tip="Your account, notifications and profile photo">${meInner(n)}</button>`;
}
function refreshMeButtons() {
  const n = unreadCount();
  for (const b of $$('[data-me-btn]')) {
    const conn = !state.me ? 'signed-out' : state.conn === 'online' ? 'online' : 'offline';
    b.dataset.conn = conn;
    b.innerHTML = meInner(n);
    b.setAttribute('aria-label', meLabel(conn, n));
  }
}
document.addEventListener('click', (e) => {
  if (e.target.closest('[data-me-btn]')) accountSheet();
});

function accountSheet() {
  const me = state.me;
  const pending = state.outbox.length;
  // Unread ones stay highlighted while the sheet is open; they're marked read straight away.
  const fresh = new Set(state.notifications.filter((n) => !n.read).map((n) => n.id));
  clearNotifToasts();
  // On a computer this opens by the avatar (top left) and shows the latest few; the full list has its own page.
  const wide = wideScreen();
  const limit = wide ? 5 : 40;
  const more = () => (wide && state.notifications.length ? `<button class="btn block small notif-all" data-see-all>${icon('bell', 'small')}See all notifications${state.notifications.length > limit ? ` (${state.notifications.length})` : ''}</button>` : '');
  const s = openSheet({
    className: 'account-sheet',
    head: `<div style="display:flex;gap:12px;align-items:center" class="grow"><button class="photo-btn" data-photo aria-label="Change your profile photo">${avatar(me, 'big')}<span class="photo-cam">${icon('camera', 'small')}</span></button><div><h2>${esc(me.name)}</h2>
      <div class="sub">${state.conn === 'online' ? 'Signed in and connected' : state.conn === 'connecting' ? 'Signed in, connecting…' : 'Signed in, offline'}${pending ? `. ${pending} change${pending > 1 ? 's' : ''} will sync when you reconnect` : ''}</div></div></div>`,
    body: `<div class="notif-head"><h3>Notifications</h3>${fresh.size ? `<span class="tag new">${fresh.size} new</span>` : ''}<span class="grow"></span>
        <button class="btn small ghost" data-notif-clear ${state.notifications.length ? '' : 'hidden'}>Clear all</button>
        <button class="btn small ghost" data-notif-settings>Choose</button></div>
      <div data-notifs>${listHtml(state.notifications, { fresh, limit })}${more()}</div>
      <div class="card" style="margin:14px 0 12px;background:var(--surface-2)">
        <div class="row"><div class="grow"><div class="label">Share my location</div><div class="help">${me.shareLocation ? 'Friends can see you on the map' : 'Off'}</div></div>
          <label class="switch"><input type="checkbox" data-share ${me.shareLocation ? 'checked' : ''} aria-label="Share my location"><span></span></label></div>
      </div>
      <button class="btn block" data-go-settings>${icon('settings')}All settings</button>`,
  });
  s.el.querySelector('[data-share]').onchange = async (e) => {
    const r = await op('loc.share', { on: e.target.checked });
    if (r.ok === false) { toast(r.error); e.target.checked = !e.target.checked; }
  };
  s.el.querySelector('[data-go-settings]').onclick = () => { s.close(); go('settings'); };
  s.el.querySelector('[data-notif-settings]').onclick = () => { s.close(); go('settings').then(() => $('#screen-settings [data-section=notifications]')?.scrollIntoView({ block: 'start' })); };
  s.el.querySelector('[data-photo]').onclick = () => openPhotoEditor();
  s.el.querySelector('[data-notif-clear]').onclick = () => clearAll();
  pushNudgeHtml().then((h) => { if (h && !s.closed) { s.el.querySelector('.notif-head').insertAdjacentHTML('beforebegin', h); bindPushNudge(s.el); } });
  const bindMore = () => s.el.querySelector('[data-see-all]')?.addEventListener('click', () => { s.close(); go('notifications'); });
  bindList(s.el, () => s.close());
  bindMore();
  markAllRead();
  const off = on('notifs', () => {
    if (s.closed) return off();
    state.notifications.filter((n) => !n.read).forEach((n) => fresh.add(n.id));
    const box = s.el.querySelector('[data-notifs]');
    box.innerHTML = listHtml(state.notifications, { fresh, limit }) + more();
    s.el.querySelector('[data-notif-clear]').hidden = !state.notifications.length;
    bindList(box, () => s.close());
    bindMore();
    if (state.unread) markAllRead();
  });
}

// ---------- navigation ----------
let current = 'map';
const loaded = {};
async function go(tab) {
  current = tab;
  closePeekSheets();
  if (tab === 'notifications' && !wideScreen()) { // phones use the account sheet instead
    tab = 'map';
    setTimeout(() => $('[data-me-btn]')?.click(), 50);
  }
  current = tab;
  for (const s of ['map', 'itinerary', 'chat', 'money', 'settings', 'notifications']) $(`#screen-${s}`).hidden = s !== tab;
  $$('.tab[data-tab]').forEach((b) => (b.dataset.tab === tab ? b.setAttribute('aria-current', 'page') : b.removeAttribute('aria-current')));
  $('#nav-handle').querySelector('use').setAttribute('href', `#i-${{ map: 'map', itinerary: 'calendar', chat: 'chat', money: 'yen', settings: 'settings', notifications: 'bell' }[tab]}`);
  if (tab === 'map') (await loaded.map).resizeMap();
  if (tab === 'itinerary') (await loaded.itin).showItinerary();
  if (tab === 'money') (await loaded.money).showMoney();
  if (tab === 'settings') (await loaded.settings).showSettings();
  if (tab === 'notifications') (await loaded.notifs).showNotifications();
  emit('tab', tab);
  if (tab === 'chat') (await loaded.chat).showChat();
  maybeStartTour(tab);
  refreshMeButtons();
  if (!(tab === 'chat' && location.hash.startsWith('#chat'))) history.replaceState(null, '', tab === 'map' ? '/' : `/#${tab}`);
}
export const currentTab = () => current;
on('go', go);

function setNavCollapsed(c) {
  $('#app').classList.toggle('nav-collapsed', c);
  $('#nav-handle').hidden = !c;
  localStorage.setItem('tabi.nav', c ? 'collapsed' : 'open');
  setTimeout(() => loaded.map?.then((m) => m.resizeMap()), 320);
}

// The red count on the Chat tab: unread messages across your chats.
function refreshChatBadge() {
  const n = (state.chats || []).reduce((a, c) => a + (c.unread || 0), 0);
  const b = $('[data-chat-count]');
  if (!b) return;
  b.hidden = !n;
  b.textContent = n > 99 ? '99+' : String(n);
  b.closest('.tab').setAttribute('aria-label', n ? `Chat, ${n} unread` : 'Chat');
}

// ---------- auth screens ----------
function authScreen(mode, { tripName, joinCode } = {}) {
  const el = $('#auth');
  $('#app').hidden = true;
  el.hidden = false;
  const title = tripName || 'Tabi';
  const body = {
    setup: `
      <label class="field"><span>Trip name</span><input class="input" name="tripName" value="Japan trip" required></label>
      <div class="inline-fields">
        <label class="field"><span>First day</span><input class="input" type="date" name="start"></label>
        <label class="field"><span>Last day</span><input class="input" type="date" name="end"></label>
      </div>
      <label class="field"><span>Your name</span><input class="input" name="name" maxlength="24" autocomplete="nickname" required></label>
      <label class="field"><span>Password</span><input class="input" type="password" name="password" autocomplete="new-password" minlength="6" required></label>
      <button class="btn primary">Create trip</button>
      <p class="auth-foot">You will be the trip admin. Afterwards, share the invite link from Settings.</p>`,
    login: `
      <label class="field"><span>Your name</span><input class="input" name="name" autocomplete="username" required></label>
      <label class="field"><span>Password</span><input class="input" type="password" name="password" autocomplete="current-password" required></label>
      <button class="btn primary">Sign in</button>
      <button type="button" class="linklike" data-forgot>Forgot password?</button>`,
    join: `
      <label class="field"><span>Invite code</span><input class="input num" name="code" value="${esc(joinCode || '')}" autocapitalize="characters" required></label>
      <label class="field"><span>Your name</span><input class="input" name="name" maxlength="24" autocomplete="nickname" required></label>
      <label class="field"><span>Choose a password</span><input class="input" type="password" name="password" autocomplete="new-password" minlength="6" required></label>
      <button class="btn primary">Join trip</button>`,
  }[mode];
  el.innerHTML = `
    <form class="auth-card" novalidate>
      <div class="auth-mark">${LOGO}<div><h1>${esc(mode === 'setup' ? 'Start a trip' : title)}</h1><p>${mode === 'setup' ? 'Set up Tabi for your group' : 'Group trip planner'}</p></div></div>
      ${mode !== 'setup' ? `<div class="seg" role="group"><button type="button" data-mode="login" aria-pressed="${mode === 'login'}">Sign in</button><button type="button" data-mode="join" aria-pressed="${mode === 'join'}">Join with invite</button></div>` : ''}
      ${body}
      <p class="err" data-err hidden></p>
    </form>`;
  el.querySelectorAll('[data-mode]').forEach((b) => b.onclick = () => authScreen(b.dataset.mode, { tripName, joinCode }));
  const form = el.querySelector('form');
  el.querySelector('[data-forgot]')?.addEventListener('click', () => forgotScreen(el, { tripName, name: form.name.value.trim(), back: () => authScreen('login', { tripName }) }));
  form.onsubmit = async (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(form));
    const err = el.querySelector('[data-err]');
    const btn = form.querySelector('.btn.primary');
    btn.disabled = true;
    try {
      await api(`/api/${mode}`, { method: 'POST', body: data });
      markSignedIn();
      history.replaceState(null, '', '/');
      startApp();
    } catch (ex) {
      err.hidden = false;
      err.textContent = ex.message;
    } finally { btn.disabled = false; }
  };
  setTimeout(() => { if (!form.contains(document.activeElement)) (mode === 'join' && !joinCode ? form.querySelector('[name=code]') : form.querySelector('[name=name]'))?.focus(); }, 50);
}

// ---------- app ----------
let started = false;
async function startApp() {
  $('#auth').hidden = true;
  $('#app').hidden = false;
  if (started) { connect(); return; }
  started = true;

  loaded.map = import('./map.js');
  loaded.itin = import('./itinerary.js');
  loaded.settings = import('./settings.js');
  loaded.money = import('./money.js');
  loaded.notifs = import('./notifpage.js');
  loaded.chat = import('./chat.js');
  await import('./location.js');
  const m = await loaded.map;
  m.initMap();
  on('theme', () => m.setMapStyle());

  $$('.tab[data-tab]').forEach((b) => b.onclick = () => go(b.dataset.tab));
  $('#nav-collapse').onclick = () => setNavCollapsed(true);
  $('#nav-handle').onclick = () => setNavCollapsed(false);
  if (localStorage.getItem('tabi.nav') === 'collapsed') setNavCollapsed(true);

  on('conn', refreshMeButtons);
  on('users', refreshMeButtons);
  on('state', refreshMeButtons);
  on('notifs', refreshMeButtons);
  on('chats', refreshChatBadge);
  refreshChatBadge();
  on('state', maybePromptRecovery);
  on('error', (msg) => toast(msg));
  refreshMeButtons();

  const hash = location.hash.slice(1);
  if (hash === 'android-app') { // "an update is ready" from the Android app
    go('settings').then(() => import('./android.js').then((a) => a.openAndroidSheet()));
  } else go(['itinerary', 'chat', 'money', 'settings', 'notifications'].includes(hash) ? hash : 'map');
  connect();
}

// ---------- opened from a push notification ----------
// The notification links to /?n=<id>; if Tabi was already open, the service worker messages us instead.
function openNotification(id) {
  const tryOpen = () => {
    const n = state.notifications.find((x) => String(x.id) === String(id));
    if (!n) return false;
    import('./notifications.js').then((m) => { m.markRead([n.id]); openTarget(n); });
    return true;
  };
  if (!tryOpen()) { const off = on('state', () => { off(); tryOpen(); }); }
}
{
  const u = new URL(location.href);
  const nid = u.searchParams.get('n');
  if (nid) { u.searchParams.delete('n'); history.replaceState(null, '', u.pathname + u.search + u.hash); openNotification(nid); }
}
navigator.serviceWorker?.addEventListener('message', (e) => { if (e.data?.t === 'open-notif' && e.data.id) openNotification(e.data.id); });

on('unauthorized', () => {
  signOutLocal();
  closeAllSheets();
  toast('You were signed out. Sign in again to continue.');
  boot();
});

async function boot() {
  applyTheme();
  const params = new URLSearchParams(location.search);
  const joinCode = params.get('join');
  // A password reset link from an admin: handle it even if this device is signed in as someone else.
  if (params.get('reset')) {
    $('#app').hidden = true;
    $('#auth').hidden = false;
    return resetScreen($('#auth'), params.get('reset'));
  }
  if (state.signedIn && !joinCode) {
    loadCached();
    return startApp(); // works offline from the cached state
  }
  try {
    const s = await api('/api/status');
    if (s.signedIn && !joinCode) { markSignedIn(); return startApp(); }
    if (!s.setup) return authScreen('setup');
    authScreen(joinCode ? 'join' : 'login', { tripName: s.tripName, joinCode });
  } catch {
    $('#auth').hidden = false;
    $('#auth').innerHTML = `<div class="auth-card"><div class="auth-mark">${LOGO}<div><h1>Tabi</h1><p>Can’t reach the server</p></div></div>
      <p class="muted">Check your connection, then reload. Once you have signed in on this device, Tabi also opens offline.</p>
      <button class="btn primary" onclick="location.reload()">Try again</button></div>`;
  }
}

// ---------- errors from this browser go to the developer console ----------
// (So "this button doesn't work" can be traced. At most a few per page load.)
let reported = 0;
function reportError(msg, where) {
  if (reported++ >= 10 || !state.signedIn || !navigator.onLine) return;
  fetch('/api/clientlog', {
    method: 'POST', credentials: 'same-origin', keepalive: true, headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ msg: String(msg).slice(0, 400), where: String(where || '').slice(0, 200), build: document.querySelector('meta[name=tabi-build]')?.content, screen: `${innerWidth}×${innerHeight} ${location.hash || '#map'}` }),
  }).catch(() => {});
}
addEventListener('error', (e) => { if (e.message) reportError(e.message, `${(e.filename || '').split('/').pop()}:${e.lineno}:${e.colno}`); });
addEventListener('unhandledrejection', (e) => reportError(e.reason?.message || e.reason, (e.reason?.stack || '').split('\n')[1]?.trim()));

// ---------- staying up to date ----------
// iOS keeps home-screen apps frozen in the background and resumes the old page, so after an update
// the app would keep running old code. The server tells us its current build on every (re)connect;
// if it isn't the build this page was loaded from, reload as soon as nothing is in progress.
// Unsent edits are kept in localStorage, so a reload never loses them.
//
// If a plain reload comes back with the old page again (a browser holding on to old files), the
// next try clears Tabi's offline copy and the service worker first. If even that doesn't help,
// the server that answers the page is probably behind the one we're connected to (a backup
// still on the old version): stop, say so, and report it to the developer console.
const PAGE_BUILD = document.querySelector('meta[name=tabi-build]')?.content || '';
const UPD = 'tabi.update';
const updState = () => { try { return JSON.parse(sessionStorage.getItem(UPD) || 'null'); } catch { return null; } };
let reloadTimer = 0;
function busy() {
  const a = document.activeElement;
  return !!document.querySelector('.sheet:not(.closing), .tour') || (a && a.matches('input, textarea, select'));
}
// Clear the offline copy of the app (not saved maps or photos) and the service worker, then reload.
export async function hardReload(target = '') {
  try { for (const k of await caches.keys()) if (k.startsWith('tabi-shell-')) await caches.delete(k); } catch { /* not available */ }
  try { for (const r of (await navigator.serviceWorker?.getRegistrations()) || []) await r.unregister(); } catch { /* not available */ }
  const u = new URL(location.href);
  u.searchParams.set('v', target || Date.now().toString(36)); // a URL no cache has seen
  location.replace(u.toString());
}
function reloadWhenIdle(target) {
  if (reloadTimer) return;
  const st = updState();
  const tries = st?.target === target ? st.tries : 0;
  if (tries >= 3) return stuckOnOldBuild(target);
  const wait = Math.max(0, (st?.at || 0) + 60e3 - Date.now()); // at most one try a minute: never a loop
  reloadTimer = setTimeout(function tryNow() {
    if (busy() && !document.hidden) { reloadTimer = setTimeout(tryNow, 4000); return; }
    sessionStorage.setItem(UPD, JSON.stringify({ target, tries: tries + 1, at: Date.now(), from: PAGE_BUILD }));
    sessionStorage.setItem('tabi.justUpdated', '1');
    if (tries === 0) {
      (async () => { try { await (await navigator.serviceWorker?.getRegistration())?.update(); } catch { /* offline */ } location.reload(); })();
    } else hardReload(target);
  }, wait);
}
let stuckShown = false;
function stuckOnOldBuild(target) {
  if (stuckShown) return;
  stuckShown = true;
  reportError(`page stuck on build ${PAGE_BUILD}; server says ${target}`, 'self-update');
  toast('This browser keeps getting an older version of Tabi. Try “Reload app” in Settings, or tell the trip admin.', { ms: 9000 });
}
on('state', () => {
  const b = state.config.build;
  if (b && /^\d/.test(PAGE_BUILD) && b !== PAGE_BUILD) reloadWhenIdle(b);
  else if (b && b === PAGE_BUILD) sessionStorage.removeItem(UPD);
});
if (new URL(location.href).searchParams.has('v')) { // tidy the address bar after a hard reload
  const u = new URL(location.href); u.searchParams.delete('v'); history.replaceState(null, '', u.pathname + u.search + u.hash);
}
if (sessionStorage.getItem('tabi.justUpdated')) {
  sessionStorage.removeItem('tabi.justUpdated');
  const off = on('state', () => {
    off();
    if (state.config.build === PAGE_BUILD) toast(`Tabi updated to ${state.config.version || 'the latest version'}`);
  });
}

if ('serviceWorker' in navigator && (isSecureContext)) {
  navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' }).catch(() => {});
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) navigator.serviceWorker.getRegistration().then((r) => r?.update()).catch(() => {});
  });
}

boot();
