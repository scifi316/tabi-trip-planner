// Notifications: the list in the account sheet, the red "!" badge, the home-screen icon badge,
// and the per-person switches shown in Settings.
import { state, on, op, emit, userById } from './store.js';
import { esc, icon, avatar, ago, toast } from './ui.js';

export const KINDS = {
  groups: { label: 'Subgroups', help: 'You’re added to or taken out of a subgroup, or one you’re in changes or ends.', icon: 'users' },
  expenses: { label: 'Expenses that include you', help: 'Someone adds, changes or deletes an expense you’re part of, with what you now owe or are owed.', icon: 'yen' },
  payments: { label: 'Payments', help: 'Someone records a payment to you or from you.', icon: 'swap' },
  myPlaces: { label: 'Places you added', help: 'One of them is confirmed, vetoed or removed.', icon: 'pin' },
  plan: { label: 'Plan changes', help: 'A confirmed stop in your plan is added, moved or dropped, from today on.', icon: 'calendar' },
  people: { label: 'People', help: 'Someone joins the trip, or you’re made an admin.', icon: 'users' },
  newPlaces: { label: 'New places', help: 'Anyone adds or imports places. Off to start with, because it gets busy while you’re planning.', icon: 'plus' },
  removed: { label: 'Removed places', help: 'Someone removes a place, so you can bring it back from Previously interested. Admins only.', icon: 'trash', admin: true },
};

export const unreadCount = () => state.unread || 0;

export function markAllRead() {
  if (!state.unread && !state.notifications.some((n) => !n.read)) return;
  state.notifications.forEach((n) => { n.read = true; });
  state.unread = 0;
  emit('notifs');
  op('notif.read', {});
}

export function listHtml(list = state.notifications, { limit = 40, fresh = new Set() } = {}) {
  if (!list.length) return `<div class="notif-empty">${icon('bell')}<div><b>Nothing new</b><div class="help">You’ll see it here when you’re added to a subgroup, owed money, or the plan changes. Choose what you hear about in Settings.</div></div></div>`;
  return `<div class="notif-list">${list.slice(0, limit).map((n) => {
    const who = userById(n.actorId);
    const k = KINDS[n.kind] || { icon: 'info' };
    return `<button class="notif ${fresh.has(n.id) ? 'unread' : ''}" data-notif="${n.id}">
      <span class="notif-av">${who ? avatar(who) : `<span class="avatar notif-sys">${icon(k.icon, 'small')}</span>`}<span class="notif-kind">${icon(k.icon, 'small')}</span></span>
      <span class="notif-main"><span class="notif-text">${esc(n.text)}</span><time>${ago(n.ts)}</time></span></button>`;
  }).join('')}</div>`;
}

export function bindList(root, close) {
  root.querySelectorAll('[data-notif]').forEach((b) => b.onclick = () => {
    const n = state.notifications.find((x) => String(x.id) === b.dataset.notif);
    if (!n) return;
    close?.();
    openTarget(n);
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

// One short toast when something arrives while the app is open (unless the list is already showing).
// Several arriving together become "3 new notifications", which opens the list.
let burst = { n: 0, at: 0 };
export const clearNotifToasts = () => document.querySelectorAll('.toast.notif-toast').forEach((t) => t.remove());
on('notifs', (d) => {
  if (!d?.fresh || document.hidden) return;
  if (document.querySelector('.sheet.account-sheet:not(.closing)')) return;
  const now = Date.now();
  burst = now - burst.at < 6000 ? { n: burst.n + 1, at: now } : { n: 1, at: now };
  clearNotifToasts();
  if (burst.n > 1) toast(`${burst.n} new notifications`, { action: 'View', onAction: () => document.querySelector('[data-me-btn]')?.click(), ms: 5000 });
  else toast(d.fresh.text, { action: 'View', onAction: () => openTarget(d.fresh), ms: 5000 });
  document.getElementById('toast-root')?.lastElementChild?.classList.add('notif-toast');
});

export function prefsHtml() {
  const prefs = state.me?.notifyPrefs || {};
  const admin = state.me?.isAdmin;
  return Object.entries(KINDS).filter(([, k]) => !k.admin || admin).map(([key, k]) => `
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
