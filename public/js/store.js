// Client state, WebSocket sync and the offline outbox.
// Sign-in uses an HttpOnly cookie, so nothing secret is kept in localStorage.
import { todayIn, addDays, daysBetween } from './ui.js';

const LS = { signedIn: 'tabi.signedIn', state: 'tabi.state', outbox: 'tabi.outbox', legacyToken: 'tabi.token' };

const listeners = new Map();
export function on(evt, fn) {
  if (!listeners.has(evt)) listeners.set(evt, new Set());
  listeners.get(evt).add(fn);
  return () => listeners.get(evt).delete(fn);
}
export function emit(evt, data) {
  listeners.get(evt)?.forEach((fn) => { try { fn(data); } catch (e) { console.error(e); } });
}

export const state = {
  signedIn: localStorage.getItem(LS.signedIn) === '1' || !!localStorage.getItem(LS.legacyToken),
  me: null,
  trip: { name: 'Japan trip', timezone: 'Asia/Tokyo', currency: 'JPY' },
  users: [],
  places: new Map(),
  subgroups: [],
  expenses: new Map(),
  locations: {},
  online: [],
  activity: [],
  notifications: [],
  unread: 0,
  config: {},
  conn: 'offline', // online | offline | connecting
  outbox: JSON.parse(localStorage.getItem(LS.outbox) || '[]'),
};

// ---------- persistence ----------
function persist() {
  try {
    localStorage.setItem(LS.state, JSON.stringify({
      me: state.me, trip: state.trip, users: state.users, places: [...state.places.values()], subgroups: state.subgroups,
      expenses: [...state.expenses.values()], locations: state.locations, activity: state.activity.slice(0, 30), config: state.config,
      notifications: state.notifications.slice(0, 60), unread: state.unread,
    }));
  } catch { /* quota: ignore */ }
}
const persistSoon = (() => { let t; return () => { clearTimeout(t); t = setTimeout(persist, 400); }; })();
function saveOutbox() { localStorage.setItem(LS.outbox, JSON.stringify(state.outbox)); }

export function loadCached() {
  try {
    const c = JSON.parse(localStorage.getItem(LS.state) || 'null');
    if (!c || !c.me) return false;
    Object.assign(state, { me: c.me, trip: c.trip, users: c.users, subgroups: c.subgroups || [], locations: c.locations || {}, activity: c.activity || [], config: c.config || {},
      notifications: c.notifications || [], unread: c.unread || 0 });
    state.places = new Map((c.places || []).map((p) => [p.id, p]));
    state.expenses = new Map((c.expenses || []).map((e) => [e.id, e]));
    for (const o of state.outbox) applyLocal(o.op, o.data);
    return true;
  } catch { return false; }
}

export function markSignedIn() {
  state.signedIn = true;
  localStorage.setItem(LS.signedIn, '1');
}
export function signOutLocal() {
  state.signedIn = false;
  for (const k of Object.values(LS)) localStorage.removeItem(k);
  state.outbox = [];
  state.me = null;
  ws?.close();
  caches?.delete('tabi-receipts').catch(() => {});
}

// ---------- REST ----------
export async function api(path, { method = 'GET', body, raw, headers = {} } = {}) {
  const legacy = localStorage.getItem(LS.legacyToken); // older builds kept a bearer token; the server swaps it for a cookie
  const isJson = body && !(body instanceof Blob) && !(body instanceof ArrayBuffer);
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: { ...(isJson ? { 'Content-Type': 'application/json' } : {}), ...(legacy ? { Authorization: `Bearer ${legacy}` } : {}), ...headers },
    body: isJson ? JSON.stringify(body) : body,
  });
  if (legacy && res.ok) localStorage.removeItem(LS.legacyToken);
  if (raw) {
    if (!res.ok) { let m; try { m = (await res.json()).error; } catch { /* */ } throw new Error(m || `Request failed (${res.status})`); }
    return res;
  }
  let data = {};
  try { data = await res.json(); } catch { /* empty */ }
  if (!res.ok) {
    if (res.status === 401 && state.signedIn && !/\/api\/(login|password)/.test(path)) emit('unauthorized');
    throw new Error(data.error || `Request failed (${res.status})`);
  }
  return data;
}

// ---------- WebSocket ----------
let ws = null;
let retry = 0;
let retryTimer = null;
const pendingAcks = new Map();

export function connect() {
  if (!state.signedIn) return;
  clearTimeout(retryTimer);
  if (ws && (ws.readyState === 0 || ws.readyState === 1)) return;
  setConn('connecting');
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const sock = new WebSocket(`${proto}://${location.host}/ws`);
  ws = sock;
  let opened = false;
  sock.onopen = () => { opened = true; retry = 0; };
  sock.onmessage = (e) => handle(JSON.parse(e.data));
  sock.onclose = () => {
    if (ws !== sock) return;
    ws = null;
    setConn('offline');
    // A refused socket might mean the session ended: ask over HTTP (401 signs us out).
    if (!opened && navigator.onLine) api('/api/status').then((s) => { if (s && s.signedIn === false) emit('unauthorized'); }).catch(() => {});
    if (!state.signedIn) return;
    retry = Math.min(retry + 1, 6);
    retryTimer = setTimeout(connect, 600 * 2 ** retry);
  };
}
export function reconnectNow() { retry = 0; connect(); }
document.addEventListener('visibilitychange', () => { if (!document.hidden && state.signedIn && !ws) reconnectNow(); });
addEventListener('online', () => state.signedIn && reconnectNow());

function setConn(c) { state.conn = c; emit('conn', c); }

function handle(m) {
  switch (m.t) {
    case 'state':
      state.me = m.me; state.trip = m.trip; state.users = m.users; state.locations = m.locations;
      state.online = m.online; state.activity = m.activity; state.config = m.config || {};
      state.subgroups = m.subgroups || [];
      state.notifications = m.notifications || []; state.unread = m.unread || 0;
      state.places = new Map(m.places.map((p) => [p.id, p]));
      state.expenses = new Map((m.expenses || []).map((e) => [e.id, e]));
      for (const o of state.outbox) applyLocal(o.op, o.data); // keep unsent edits visible
      setConn('online');
      flushOutbox();
      persistSoon();
      ['state', 'places', 'users', 'locations', 'subgroups', 'expenses', 'notifs'].forEach((e) => emit(e));
      break;
    case 'ack': {
      const idx = state.outbox.findIndex((o) => o.id === m.id);
      if (idx >= 0) { state.outbox.splice(idx, 1); saveOutbox(); emit('outbox'); }
      const cb = pendingAcks.get(m.id);
      if (cb) { pendingAcks.delete(m.id); cb(m); }
      if (!m.ok && m.error) emit('error', m.error);
      break;
    }
    case 'place': state.places.set(m.place.id, m.place); emit('places', { changed: [m.place.id] }); persistSoon(); break;
    case 'places': for (const p of m.places) state.places.set(p.id, p); emit('places', { changed: m.places.map((p) => p.id) }); persistSoon(); break;
    case 'place.del': state.places.delete(m.id); emit('places', { removed: [m.id] }); persistSoon(); break;
    case 'subgroups': state.subgroups = m.subgroups; emit('subgroups'); emit('places'); persistSoon(); break;
    case 'expense': state.expenses.set(m.expense.id, m.expense); emit('expenses'); persistSoon(); break;
    case 'expense.del': if (state.expenses.delete(m.id)) { emit('expenses'); persistSoon(); } break;
    case 'loc':
      if (m.loc) state.locations[m.userId] = m.loc; else delete state.locations[m.userId];
      emit('locations'); persistSoon(); break;
    case 'presence': state.online = m.online; emit('users'); break;
    case 'users': {
      state.users = m.users;
      const mine = m.users.find((u) => u.id === state.me?.id);
      if (mine) state.me = { ...state.me, ...mine };
      emit('users'); persistSoon(); break;
    }
    case 'trip': state.trip = m.trip; emit('trip'); emit('places'); persistSoon(); break;
    case 'activity': state.activity.unshift(m.item); state.activity.length = Math.min(state.activity.length, 100); emit('activity'); break;
    case 'notif': {
      const i = state.notifications.findIndex((n) => n.id === m.item.id);
      if (i >= 0) state.notifications.splice(i, 1);
      state.notifications.unshift(m.item);
      state.notifications.length = Math.min(state.notifications.length, 100);
      state.unread = m.unread;
      emit('notifs', { fresh: m.item }); persistSoon(); break;
    }
    case 'notif.unread': state.unread = m.unread; emit('notifs'); persistSoon(); break;
    case 'notif.prefs': if (state.me) state.me.notifyPrefs = m.prefs; emit('notif-prefs'); persistSoon(); break;
    case 'kicked': emit('unauthorized'); break;
  }
}

function flushOutbox() {
  if (!ws || ws.readyState !== 1) return;
  for (const o of state.outbox) ws.send(JSON.stringify({ t: 'op', id: o.id, op: o.op, data: o.data }));
}

// Ops that change shared data go through the outbox so they survive being offline.
const QUEUED = new Set(['place.add', 'place.bulk', 'place.update', 'place.delete', 'place.vote', 'place.reorder',
  'expense.save', 'expense.delete', 'group.save', 'group.member', 'group.delete']);

export function op(name, data = {}) {
  const id = Math.random().toString(36).slice(2) + Date.now().toString(36);
  applyLocal(name, data);
  return new Promise((resolve) => {
    if (QUEUED.has(name)) {
      state.outbox.push({ id, op: name, data });
      saveOutbox();
      emit('outbox');
      pendingAcks.set(id, resolve);
      if (ws?.readyState === 1) ws.send(JSON.stringify({ t: 'op', id, op: name, data }));
      else resolve({ ok: true, queued: true });
    } else if (ws?.readyState === 1) {
      pendingAcks.set(id, resolve);
      ws.send(JSON.stringify({ t: 'op', id, op: name, data }));
    } else {
      resolve({ ok: false, error: 'You are offline. Try again when you are connected.' });
    }
  });
}
// Fire-and-forget (location pings) — not queued, no optimistic state.
export function send(name, data) {
  if (ws?.readyState === 1) ws.send(JSON.stringify({ t: 'op', op: name, data }));
}

function applyLocal(name, d) {
  const meId = state.me?.id;
  const now = Date.now();
  let evt = 'places';
  switch (name) {
    case 'place.add': {
      const p = d.place;
      if (p && !state.places.has(p.id)) state.places.set(p.id, { status: 'suggested', votes: {}, sort: now, createdBy: meId, createdAt: now, ...p });
      break;
    }
    case 'place.bulk':
      for (const p of d.places || []) if (!state.places.has(p.id)) state.places.set(p.id, { status: 'suggested', votes: {}, sort: now, createdBy: meId, createdAt: now, ...p });
      break;
    case 'place.update': {
      const p = state.places.get(d.id);
      if (p) state.places.set(d.id, { ...p, ...d.patch, updatedAt: now, updatedBy: meId });
      break;
    }
    case 'place.delete': {
      const p = state.places.get(d.id);
      if (!p) break;
      if (state.me?.isAdmin) state.places.set(d.id, { ...p, removedAt: now, removedBy: meId });
      else state.places.delete(d.id);
      break;
    }
    case 'place.vote': {
      const p = state.places.get(d.id);
      if (!p) break;
      const votes = { ...p.votes };
      if (d.value == null) delete votes[meId]; else votes[meId] = d.value;
      let status = p.status;
      if (d.value === 'veto' && state.trip.vetoRule === 'single') status = 'vetoed';
      state.places.set(d.id, { ...p, votes, status });
      break;
    }
    case 'place.reorder':
      (d.ids || []).forEach((id, i) => { const p = state.places.get(id); if (p) state.places.set(id, { ...p, sort: i + 1 }); });
      break;
    case 'expense.save': {
      const e = d.expense;
      const prev = state.expenses.get(e.id);
      state.expenses.set(e.id, { createdBy: meId, createdAt: now, ...prev, ...e, attachments: (e.attachmentIds || []).map((id) => prev?.attachments?.find((a) => a.id === id) || { id }), updatedAt: now });
      evt = 'expenses';
      break;
    }
    case 'expense.delete': state.expenses.delete(d.id); evt = 'expenses'; break;
    case 'group.save': {
      const g = d.group;
      const i = state.subgroups.findIndex((x) => x.id === g.id);
      const next = { createdBy: meId, ...(i >= 0 ? state.subgroups[i] : {}), ...g, endDay: g.endDay || g.startDay || null };
      if (i >= 0) state.subgroups[i] = next; else state.subgroups.push(next);
      evt = 'subgroups';
      break;
    }
    case 'group.member': {
      const g = state.subgroups.find((x) => x.id === d.id);
      if (g) g.memberIds = d.on ? [...new Set([...g.memberIds, +d.userId])] : g.memberIds.filter((u) => u !== +d.userId);
      evt = 'subgroups';
      break;
    }
    case 'group.delete':
      state.subgroups = state.subgroups.filter((g) => g.id !== d.id);
      for (const p of state.places.values()) if (p.groupId === d.id) p.groupId = null;
      evt = 'subgroups';
      break;
    default: return;
  }
  emit(evt);
  if (evt === 'subgroups') emit('places');
  persistSoon();
}

// ---------- derived data ----------
export const userById = (id) => state.users.find((u) => u.id === +id);
export const groupById = (id) => state.subgroups.find((g) => g.id === id);
export const today = () => todayIn(state.trip.timezone || 'Asia/Tokyo');
export const livePlaces = () => [...state.places.values()].filter((p) => !p.removedAt);

export function effectiveStatus(p, t = today()) {
  if (p.removedAt) return 'removed';
  if (p.status === 'confirmed' && p.day && p.day < t) return 'missed';
  return p.status;
}

export function tripDays() {
  const set = new Set();
  const { start, end } = state.trip;
  if (start && end && daysBetween(start, end) <= 90) {
    for (let d = start; d <= end; d = addDays(d, 1)) set.add(d);
  }
  for (const p of livePlaces()) if (p.day) set.add(p.day);
  return [...set].sort();
}

// Plan order is the manual order. Setting a time slots a stop in among the other timed stops (see place.js).
export function byPlan(a, b) {
  return (a.sort ?? 0) - (b.sort ?? 0) || String(a.time || '').localeCompare(String(b.time || ''));
}

// Subgroups active on a day (no dates = the whole trip).
export function groupsOn(day) {
  return state.subgroups.filter((g) => !day || ((!g.startDay || g.startDay <= day) && (!g.endDay || g.endDay >= day)));
}
export function myGroupOn(day) {
  return groupsOn(day).find((g) => g.memberIds.includes(state.me?.id)) || null;
}

// Stops on the "line" for a day: confirmed + visited + skipped, in plan order.
// groupId: null = every stop; an id = that subgroup's stops plus stops for everyone.
export function dayStops(day, groupId = null) {
  const t = today();
  return livePlaces()
    .filter((p) => p.day === day && ['confirmed', 'visited', 'skipped'].includes(p.status) && (!groupId || !p.groupId || p.groupId === groupId))
    .sort(byPlan)
    .map((p) => ({ place: p, state: p.status === 'visited' ? 'visited' : p.status === 'skipped' ? 'skipped' : (day < t ? 'missed' : 'todo') }));
}

// A person's own plan: stops for everyone, plus stops for subgroups they belong to.
export function personSees(place, userId) {
  if (!place.groupId) return true;
  const g = groupById(place.groupId);
  return !g || g.memberIds.includes(+userId);
}
export function personDayStops(day, userId) {
  return dayStops(day).filter((s) => personSees(s.place, userId));
}

export function defaultDay() {
  const days = tripDays();
  if (!days.length) return null;
  const t = today();
  if (days.includes(t)) return t;
  return days.find((d) => d > t) || days[days.length - 1];
}

export function voteCounts(p) {
  const c = { up: 0, down: 0, veto: 0 };
  for (const v of Object.values(p.votes || {})) if (c[v] != null) c[v]++;
  return c;
}
