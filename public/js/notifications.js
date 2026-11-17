// Notifications: the list in the account sheet, the red "!" badge, the home-screen icon badge,
// and the per-person switches shown in Settings.
import { state, on, op, emit, userById } from './store.js';
import { esc, icon, avatar, ago, toast, confirmSheet, fmtDay } from './ui.js';
import { withEmojis } from './emoji.js';

export const KINDS = {
  groups: { label: 'Subgroups', help: 'You’re added to or taken out of a subgroup, or one you’re in changes or ends.', icon: 'users' },
  expenses: { label: 'Expenses that include you', help: 'Someone adds, changes or deletes an expense you’re part of, with what you now owe or are owed.', icon: 'yen' },
  payments: { label: 'Payments', help: 'Someone records a payment to you or from you.', icon: 'swap' },
  myPlaces: { label: 'Places you added', help: 'One of them is confirmed, vetoed or removed.', icon: 'pin' },
  plan: { label: 'Plan changes', help: 'A confirmed stop in your plan is added, moved or dropped, from today on.', icon: 'calendar' },
  people: { label: 'People', help: 'Someone joins the trip, or you’re made an admin.', icon: 'users' },
  newPlaces: { label: 'New places', help: 'Anyone adds or imports places. Off to start with, because it gets busy while you’re planning.', icon: 'plus' },
  removed: { label: 'Removed places', help: 'Someone removes a place, so you can bring it back from Previously interested. Admins only.', icon: 'trash', admin: true },
  help: { label: 'Sign-in help', help: 'Someone who forgot their password asks for a reset link. Admins only.', icon: 'lock', admin: true },
  chatMentions: { label: 'Chat: mentions and replies', help: 'Someone @mentions you, or replies to one of your messages.', icon: 'chat' },
  chatAll: { label: 'Chat: every message', help: 'Every new message in your chats, a few at a time. Off to start with.', icon: 'chat' },
  photos: { label: 'Picture a day', help: 'Someone adds a photo of the day, and an evening reminder if the day has none yet.', icon: 'camera' },
  reactions: { label: 'Waves and reactions', help: 'Someone sends you a 👋 or another emoji. Turning this off also stops them popping up on screen.', icon: 'smile' },
  // Always on: changes to your own password or recovery code. Not a switch.
  security: { label: 'Your account', icon: 'lock', locked: true },
};

export const unreadCount = () => state.unread || 0;

export function markAllRead() {
  if (!state.unread && !state.notifications.some((n) => !n.read)) return;
  state.notifications.forEach((n) => { n.read = true; });
  state.unread = 0;
  emit('notifs');
  op('notif.read', {});
}

// Mark some as read (opening one on the notifications page), or all of them.
export function markRead(ids) {
  const set = new Set(ids);
  let changed = 0;
  state.notifications.forEach((n) => { if (set.has(n.id) && !n.read) { n.read = true; changed++; } });
  if (!changed) return;
  state.unread = Math.max(0, (state.unread || 0) - changed);
  emit('notifs');
  op('notif.read', { ids });
}

// Dismiss one (or a few): gone from every device you're signed in on.
export function dismiss(ids) {
  const set = new Set(ids);
  const unreadGone = state.notifications.filter((n) => set.has(n.id) && !n.read).length;
  state.notifications = state.notifications.filter((n) => !set.has(n.id));
  state.unread = Math.max(0, (state.unread || 0) - unreadGone);
  emit('notifs');
  op('notif.dismiss', { ids }).then((r) => { if (r?.ok === false) toast(r.error); });
}

export async function clearAll() {
  if (!state.notifications.length) return true;
  const ok = await confirmSheet({ title: 'Clear all notifications?', body: 'They’re removed from all your devices. This doesn’t change anything they were about.', confirm: 'Clear all', danger: true });
  if (!ok) return false;
  state.notifications = [];
  state.unread = 0;
  emit('notifs', { reset: true });
  const r = await op('notif.clearAll', {});
  if (r?.ok === false) toast(r.error);
  else toast('Notifications cleared');
  return true;
}

const EMPTY = `<div class="notif-empty">${icon('bell')}<div><b>Nothing new</b><div class="help">You’ll see it here when you’re added to a subgroup, owed money, or the plan changes. Choose what you hear about in Settings.</div></div></div>`;

function dayLabel(ts) {
  const d = new Date(ts);
  const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const y = new Date(now - 864e5);
  const yesterday = `${y.getFullYear()}-${String(y.getMonth() + 1).padStart(2, '0')}-${String(y.getDate()).padStart(2, '0')}`;
  return { key, label: key === today ? 'Today' : key === yesterday ? 'Yesterday' : fmtDay(key, { weekday: 'long', day: 'numeric', month: 'short' }) };
}

const itemHtml = (n, fresh) => {
  const who = userById(n.actorId);
  const k = KINDS[n.kind] || { icon: 'info' };
  return `<div class="notif-item" data-item="${n.id}">
    <button class="notif ${fresh.has(n.id) ? 'unread' : ''}" data-notif="${n.id}">
      <span class="notif-av">${who ? avatar(who) : `<span class="avatar notif-sys">${icon(k.icon, 'small')}</span>`}<span class="notif-kind">${icon(k.icon, 'small')}</span></span>
      <span class="notif-main"><span class="notif-text">${withEmojis(n.text)}</span><time>${ago(n.ts)}</time></span></button>
    <button class="icon-btn small notif-x" data-dismiss="${n.id}" aria-label="Dismiss this notification" data-tip="Dismiss">${icon('x', 'small')}</button>
  </div>`;
};

// The list. In the account sheet it's a short scrolling list; on the notifications page it's grouped by day.
export function listHtml(list = state.notifications, { limit = 40, fresh = new Set(), group = false, empty = EMPTY } = {}) {
  if (!list.length) return empty;
  const shown = list.slice(0, limit);
  if (!group) return `<div class="notif-list">${shown.map((n) => itemHtml(n, fresh)).join('')}</div>`;
  const days = [];
  for (const n of shown) {
    const { key, label } = dayLabel(n.ts);
    if (days.at(-1)?.key !== key) days.push({ key, label, items: [] });
    days.at(-1).items.push(n);
  }
  return days.map((d) => `<section class="notif-day"><h3>${esc(d.label)}</h3><div class="notif-list grouped">${d.items.map((n) => itemHtml(n, fresh)).join('')}</div></section>`).join('');
}

// find: where to look a notification up (the page also shows older ones that aren't in state)
export function bindList(root, close, { find = (id) => state.notifications.find((x) => x.id === id), onDismiss } = {}) {
  root.querySelectorAll('[data-notif]').forEach((b) => b.onclick = () => {
    const n = find(+b.dataset.notif);
    if (!n) return;
    if (!n.read) markRead([n.id]);
    close?.();
    openTarget(n);
  });
  root.querySelectorAll('[data-dismiss]').forEach((b) => b.onclick = (e) => {
    e.stopPropagation();
    const id = +b.dataset.dismiss;
    const row = b.closest('.notif-item');
    row?.classList.add('gone');
    setTimeout(() => { onDismiss?.(id); dismiss([id]); }, 160);
  });
}

// Go to what a notification is about.
export async function openTarget(n) {
  const ref = n.ref || {};
  if (ref.type === 'place' && state.places.has(ref.id)) {
    emit('go', 'map');
    setTimeout(() => emit('focus-place', ref.id), 120);
  } else if (ref.type === 'expense') {
    emit('go', 'money');
    const e = state.expenses.get(ref.id);
    if (e) (await import('./money.js')).openExpense(e);
  } else if (ref.type === 'group') {
    (await import('./groups.js')).openGroups();
  } else if (ref.type === 'user' && userById(ref.id) && +ref.id !== state.me?.id) {
    emit('go', 'map');
    (await import('./friends.js')).openFriend(+ref.id, { pinpoint: true });
  } else if (ref.type === 'help' && userById(ref.id)) {
    emit('go', 'settings');
    (await import('./account.js')).openResetLink(userById(ref.id));
  } else if (ref.type === 'account') {
    await emit('go', 'settings');
  } else if (ref.type === 'stay' && ref.id) {
    emit('go', 'map');
    (await import('./stays.js')).openStay(String(ref.id));
  } else if (ref.type === 'photos' && ref.id) {
    (await import('./photos.js')).openDayPhotos(String(ref.id));
  } else if (ref.type === 'reaction' && userById(ref.id) && +ref.id !== state.me?.id) {
    emit('go', 'map');
    (await import('./friends.js')).openFriend(+ref.id, { pinpoint: true });
  } else if (ref.type === 'chat' && ref.id) {
    emit('go', 'chat');
    (await import('./chat.js')).openChat(String(ref.id));
  } else if (ref.type === 'reset') {
    emit('go', 'money');
  } else if (ref.type === 'adds' || ref.type === 'import') {
    emit('go', 'itinerary');
  }
}

// Home-screen icon badge (installed apps on iOS 16.4+, Android and desktop Chrome).
function syncAppBadge() {
  try {
    if (state.unread) navigator.setAppBadge?.(state.unread)?.catch?.(() => {});
    else navigator.clearAppBadge?.()?.catch?.(() => {});
  } catch { /* unsupported */ }
}
on('notifs', syncAppBadge);

// On a computer the notifications have their own page (rail button); on a phone they're in the account sheet.
export const wideScreen = () => matchMedia('(min-width: 900px) and (min-height: 521px)').matches;
export const openNotifications = () => (wideScreen() ? emit('go', 'notifications') : document.querySelector('[data-me-btn]')?.click());

// One short toast when something arrives while the app is open (unless the list is already showing).
// Waves and reactions have their own pop-up, so no toast for those.
// Several arriving together become "3 new notifications", which opens the list.
let burst = { n: 0, at: 0 };
export const clearNotifToasts = () => document.querySelectorAll('.toast.notif-toast').forEach((t) => t.remove());
on('notifs', (d) => {
  if (!d?.fresh || document.hidden || d.fresh.kind === 'reactions') return;
  if (document.querySelector('.sheet.account-sheet:not(.closing)')) return;
  if (document.getElementById('screen-notifications')?.hidden === false) return;
  const now = Date.now();
  burst = now - burst.at < 6000 ? { n: burst.n + 1, at: now } : { n: 1, at: now };
  clearNotifToasts();
  if (burst.n > 1) toast(`${burst.n} new notifications`, { action: 'View', onAction: openNotifications, ms: 5000 });
  else toast(d.fresh.text, { action: 'View', onAction: () => openTarget(d.fresh), ms: 5000 });
  document.getElementById('toast-root')?.lastElementChild?.classList.add('notif-toast');
});

export function prefsHtml() {
  const prefs = state.me?.notifyPrefs || {};
  const admin = state.me?.isAdmin;
  return Object.entries(KINDS).filter(([, k]) => !k.locked && (!k.admin || admin)).map(([key, k]) => `
    <div class="row"><div class="grow"><div class="label">${esc(k.label)}</div><div class="help">${esc(k.help)}</div></div>
      <label class="switch"><input type="checkbox" data-notify="${key}" ${prefs[key] ? 'checked' : ''} aria-label="${esc(k.label)}"><span></span></label></div>`).join('');
}
export function bindPrefs(root) {
  root.querySelectorAll('[data-notify]').forEach((i) => i.onchange = async () => {
    const r = await op('notif.prefs', { prefs: { [i.dataset.notify]: i.checked } });
    if (r.ok === false) { toast(r.error); i.checked = !i.checked; return; }
    if (state.me) state.me.notifyPrefs = r.prefs;
  });
}
