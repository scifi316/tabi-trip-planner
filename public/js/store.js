// Client state, WebSocket sync and the offline outbox.
import { todayIn, addDays, daysBetween } from './ui.js';

const LS = {
  token: 'tabi.token',
  state: 'tabi.state',
  outbox: 'tabi.outbox',
};

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
  token: localStorage.getItem(LS.token),
  me: null,
  trip: { name: 'Japan trip', timezone: 'Asia/Tokyo' },
  users: [],
  places: new Map(),
  locations: {},
  online: [],
  activity: [],
  config: {},
  conn: 'offline', // online | offline | connecting
  outbox: JSON.parse(localStorage.getItem(LS.outbox) || '[]'),
};

// ---------- persistence ----------
function persist() {
  try {
    localStorage.setItem(LS.state, JSON.stringify({
      me: state.me, trip: state.trip, users: state.users, places: [...state.places.values()],
      locations: state.locations, activity: state.activity.slice(0, 30), config: state.config,
    }));
  } catch { /* quota: ignore */ }
}
const persistSoon = (() => { let t; return () => { clearTimeout(t); t = setTimeout(persist, 400); }; })();
function saveOutbox() { localStorage.setItem(LS.outbox, JSON.stringify(state.outbox)); }

export function loadCached() {
  try {
    const c = JSON.parse(localStorage.getItem(LS.state) || 'null');
    if (!c || !c.me) return false;
    Object.assign(state, { me: c.me, trip: c.trip, users: c.users, locations: c.locations || {}, activity: c.activity || [], config: c.config || {} });
    state.places = new Map((c.places || []).map((p) => [p.id, p]));
    for (const o of state.outbox) applyLocal(o.op, o.data);
    return true;
  } catch { return false; }
}

export function setToken(t) {
  state.token = t;
  if (t) localStorage.setItem(LS.token, t); else localStorage.removeItem(LS.token);
}
export function signOutLocal() {
  setToken(null);
  localStorage.removeItem(LS.state);
  localStorage.removeItem(LS.outbox);
  state.outbox = [];
  state.me = null;
  ws?.close();
}

// ---------- REST ----------
export async function api(path, { method = 'GET', body, raw } = {}) {
  const res = await fetch(path, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (raw) {
    if (!res.ok) { let m; try { m = (await res.json()).error; } catch { /* */ } throw new Error(m || `Request failed (${res.status})`); }
    return res;
  }
  let data = {};
  try { data = await res.json(); } catch { /* empty */ }
  if (!res.ok) {
    if (res.status === 401 && state.token && !path.includes('/login')) emit('unauthorized');
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
  if (!state.token) return;
  clearTimeout(retryTimer);
  if (ws && (ws.readyState === 0 || ws.readyState === 1)) return;
  setConn('connecting');
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const sock = new WebSocket(`${proto}://${location.host}/ws?token=${encodeURIComponent(state.token)}`);
  ws = sock;
  let opened = false;
  sock.onopen = () => { opened = true; retry = 0; };
  sock.onmessage = (e) => handle(JSON.parse(e.data));
  sock.onclose = (e) => {
    if (ws !== sock) return;
    ws = null;
    setConn('offline');
    if (!opened && retry > 1) {
      // Token may be revoked; check over HTTP once
      api('/api/status').catch(() => {});
    }
    if (!state.token) return;
    retry = Math.min(retry + 1, 6);
    retryTimer = setTimeout(connect, 600 * 2 ** retry);
  };
}
export function reconnectNow() { retry = 0; connect(); }
document.addEventListener('visibilitychange', () => { if (!document.hidden && state.token && !ws) reconnectNow(); });
addEventListener('online', () => state.token && reconnectNow());

function setConn(c) { state.conn = c; emit('conn', c); }

function handle(m) {
  switch (m.t) {
    case 'state':
      state.me = m.me; state.trip = m.trip; state.users = m.users; state.locations = m.locations;
      state.online = m.online; state.activity = m.activity; state.config = m.config || {};
      state.places = new Map(m.places.map((p) => [p.id, p]));
      for (const o of state.outbox) applyLocal(o.op, o.data); // keep unsent edits visible
      setConn('online');
      flushOutbox();
      persistSoon();
      emit('state');
      emit('places');
      emit('users');
      emit('locations');
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
    case 'kicked': emit('unauthorized'); break;
  }
}

function flushOutbox() {
  if (!ws || ws.readyState !== 1) return;
  for (const o of state.outbox) ws.send(JSON.stringify({ t: 'op', id: o.id, op: o.op, data: o.data }));
}

// Ops that change shared data go through the outbox so they survive being offline.
const QUEUED = new Set(['place.add', 'place.bulk', 'place.update', 'place.delete', 'place.vote', 'place.reorder']);

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
    case 'place.delete': state.places.delete(d.id); break;
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
    default: return;
  }
  emit('places');
  persistSoon();
}

// ---------- derived data ----------
export const userById = (id) => state.users.find((u) => u.id === +id);
export const today = () => todayIn(state.trip.timezone || 'Asia/Tokyo');

export function effectiveStatus(p, t = today()) {
  if (p.status === 'confirmed' && p.day && p.day < t) return 'missed';
  return p.status;
}

export function tripDays() {
  const set = new Set();
  const { start, end } = state.trip;
  if (start && end && daysBetween(start, end) <= 90) {
    for (let d = start; d <= end; d = addDays(d, 1)) set.add(d);
  }
  for (const p of state.places.values()) if (p.day) set.add(p.day);
  return [...set].sort();
}

// Plan order is the manual order. Setting a time slots a stop in among the other timed stops (see place.js).
export function byPlan(a, b) {
  return (a.sort ?? 0) - (b.sort ?? 0) || String(a.time || '').localeCompare(String(b.time || ''));
}

// Stops on the "line" for a day: confirmed + visited + skipped, in plan order.
export function dayStops(day) {
  const t = today();
  return [...state.places.values()]
    .filter((p) => p.day === day && ['confirmed', 'visited', 'skipped'].includes(p.status))
    .sort(byPlan)
    .map((p) => ({ place: p, state: p.status === 'visited' ? 'visited' : p.status === 'skipped' ? 'skipped' : (day < t ? 'missed' : 'todo') }));
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
