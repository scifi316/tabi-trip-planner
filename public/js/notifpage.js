// The notifications page (computers only; on a phone they're in the account sheet).
// Unread ones stay highlighted until you open them or "Mark all read". Dismiss one with ×, or clear the lot.
import { state, on, op } from './store.js';
import { $, icon, toast } from './ui.js';
import { listHtml, bindList, markAllRead, clearAll } from './notifications.js';
import { meButton } from './main.js';

let filter = 'all';
let older = [];          // fetched on demand, not kept in state
let olderDone = false;
let loading = false;

const root = () => $('#screen-notifications');
const isOpen = () => root() && !root().hidden;

function render() {
  const el = root();
  if (!el) return;
  const unreadN = state.notifications.filter((n) => !n.read).length;
  const all = [...state.notifications, ...older.filter((o) => !state.notifications.some((n) => n.id === o.id))];
  const list = filter === 'unread' ? all.filter((n) => !n.read) : all;
  const fresh = new Set(all.filter((n) => !n.read).map((n) => n.id));
  const scroll = el.scrollTop;
  el.innerHTML = `
  <div class="page notif-page">
    <header class="page-head">${meButton()}<div class="grow"><h1>Notifications</h1>
      <div class="sub">${unreadN ? `${unreadN} unread` : 'You’re all caught up'}</div></div>
      <button class="btn small" data-notif-settings>${icon('settings', 'small')}Choose what you get</button></header>
    <div class="notif-bar">
      <div class="seg" role="group" aria-label="Show">
        <button data-filter="all" aria-pressed="${filter === 'all'}">All</button>
        <button data-filter="unread" aria-pressed="${filter === 'unread'}">Unread${unreadN ? ` (${unreadN})` : ''}</button>
      </div>
      <span class="grow"></span>
      <button class="btn small" data-read-all ${unreadN ? '' : 'disabled'}>${icon('check', 'small')}Mark all read</button>
      <button class="btn small danger" data-clear-all ${all.length ? '' : 'disabled'}>${icon('trash', 'small')}Clear all</button>
    </div>
    <div class="card notif-card">${listHtml(list, {
      limit: 1000, fresh, group: true,
      empty: filter === 'unread' && all.length
        ? `<div class="notif-empty">${icon('check')}<div><b>No unread notifications</b><div class="help">Switch to All to see earlier ones.</div></div></div>`
        : undefined,
    })}</div>
    ${filter === 'all' && all.length && !olderDone ? `<button class="btn block notif-older" data-older ${loading ? 'disabled' : ''}>${loading ? 'Loading…' : 'Show older'}</button>` : ''}
    ${filter === 'all' && olderDone && all.length > 8 ? `<p class="hint notif-end">That’s everything. Notifications you’ve read are removed after 45 days.</p>` : ''}
  </div>`;
  el.scrollTop = scroll;
  el.querySelectorAll('[data-filter]').forEach((b) => b.onclick = () => { filter = b.dataset.filter; render(); });
  el.querySelector('[data-read-all]').onclick = () => { older.forEach((n) => { n.read = true; }); markAllRead(); };
  el.querySelector('[data-clear-all]').onclick = async () => { if (await clearAll()) { older = []; olderDone = true; render(); } };
  el.querySelector('[data-notif-settings]').onclick = async () => {
    const { emit } = await import('./store.js');
    await emit('go', 'settings');
    $('#screen-settings [data-section=notifications]')?.scrollIntoView({ block: 'start' });
  };
  el.querySelector('[data-older]')?.addEventListener('click', loadOlder);
  bindList(el, null, {
    find: (id) => state.notifications.find((n) => n.id === id) || older.find((n) => n.id === id),
    onDismiss: (id) => { older = older.filter((n) => n.id !== id); },
  });
}

async function loadOlder() {
  if (loading) return;
  loading = true; render();
  const all = [...state.notifications, ...older];
  const before = all.length ? Math.min(...all.map((n) => n.id)) : Number.MAX_SAFE_INTEGER;
  const r = await op('notif.older', { before, limit: 40 });
  loading = false;
  if (r?.ok === false) { toast(r.error); render(); return; }
  const got = r?.notifications || [];
  older.push(...got);
  if (got.length < 40) olderDone = true;
  render();
}

export function showNotifications() {
  filter = 'all';
  render();
}

// Keep it live while it's showing; reset the older ones when everything is cleared elsewhere.
on('notifs', (d) => {
  if (d?.reset) { older = []; olderDone = false; }
  if (isOpen()) render();
});
on('users', () => { if (isOpen()) render(); });

// The rail button's unread count
function badge() {
  const n = state.unread || 0;
  for (const b of document.querySelectorAll('[data-notif-count]')) { b.hidden = !n; b.textContent = n > 99 ? '99+' : String(n); }
  const tab = document.querySelector('.tab[data-tab=notifications]');
  tab?.setAttribute('aria-label', n ? `Notifications, ${n} unread` : 'Notifications');
}
on('notifs', badge);
on('state', badge);
badge();
