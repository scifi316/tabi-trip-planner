// Small UI toolkit: escaping, icons, avatars, sheets, toasts, date helpers.

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const icon = (name, cls = '') => `<svg class="i ${cls}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export const STATUS = {
  confirmed: { label: 'Confirmed', color: 'var(--c-confirmed)' },
  maybe: { label: 'Maybe', color: 'var(--c-maybe)' },
  suggested: { label: 'Suggested', color: 'var(--c-suggested)' },
  visited: { label: 'Visited', color: 'var(--c-visited)' },
  missed: { label: 'Missed', color: 'var(--c-missed)' },
  skipped: { label: 'Skipped', color: 'var(--c-skipped)' },
  vetoed: { label: 'Vetoed', color: 'var(--c-vetoed)' },
  removed: { label: 'Previously interested', color: 'var(--ink-3)' },
};
export const STATUS_ORDER = ['confirmed', 'maybe', 'suggested', 'visited', 'missed', 'skipped', 'vetoed'];

export function initials(name = '?') {
  const parts = String(name).trim().split(/\s+/);
  const s = parts.length > 1 ? parts[0][0] + parts[1][0] : String(name).slice(0, 2);
  return s.toUpperCase();
}
export function avatar(user, cls = '') {
  if (!user) return `<span class="avatar ${cls}" style="background:var(--surface-3);color:var(--ink-2)">?</span>`;
  // Initials sit underneath the photo, so a photo that fails to load falls back to them.
  const photo = user.avatar ? `<img src="${esc(user.avatar)}" alt="" loading="lazy" decoding="async" onerror="this.remove()">` : '';
  return `<span class="avatar ${cls}" style="background:${esc(user.color)}" title="${esc(user.name)}">${esc(initials(user.name))}${photo}</span>`;
}

export function uid() {
  const a = crypto.getRandomValues(new Uint8Array(12));
  return 'p' + [...a].map((b) => b.toString(36).padStart(2, '0')).join('').slice(0, 18);
}

export function ago(ts) {
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

// ---- dates (all trip days are plain YYYY-MM-DD strings in the trip's time zone) ----
export function todayIn(tz = 'Asia/Tokyo') {
  try { return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()); }
  catch { return new Date().toISOString().slice(0, 10); }
}
const asDate = (d) => new Date(d + 'T00:00:00Z');
export function fmtDay(d, opts = { weekday: 'short', day: 'numeric', month: 'short' }) {
  if (!d) return 'Unscheduled';
  return new Intl.DateTimeFormat('en-GB', { ...opts, timeZone: 'UTC' }).format(asDate(d));
}
export function dayParts(d) {
  const dt = asDate(d);
  const f = (o) => new Intl.DateTimeFormat('en-GB', { ...o, timeZone: 'UTC' }).format(dt);
  return { dow: f({ weekday: 'short' }), num: f({ day: 'numeric' }), mon: f({ month: 'short' }) };
}
export function addDays(d, n) {
  const dt = asDate(d);
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}
export function daysBetween(a, b) {
  return Math.round((asDate(b) - asDate(a)) / 864e5);
}
export function fmtTime(t) { return t || ''; }

// ---- toasts ----
export function toast(message, { action, onAction, ms = 3200 } = {}) {
  const root = document.getElementById('toast-root');
  const el = document.createElement('div');
  el.className = 'toast';
  el.innerHTML = `<span>${esc(message)}</span>${action ? `<button>${esc(action)}</button>` : ''}`;
  if (action) el.querySelector('button').onclick = () => { onAction?.(); el.remove(); };
  root.appendChild(el);
  setTimeout(() => el.remove(), ms);
}

// ---- bottom sheets ----
let sheetStack = [];
export function openSheet({ title = '', sub = '', head = '', body = '', foot = '', peek = false, onClose, className = '' } = {}) {
  const root = document.getElementById('sheet-root');
  if (peek) closePeekSheets();
  const scrim = peek ? null : Object.assign(document.createElement('div'), { className: 'scrim' });
  const el = document.createElement('section');
  el.className = `sheet ${peek ? 'peek' : ''} ${className}`;
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-modal', peek ? 'false' : 'true');
  el.innerHTML = `
    <div class="sheet-grab" aria-hidden="true"></div>
    <div class="sheet-head">${head || `<div class="grow"><h2>${esc(title)}</h2>${sub ? `<div class="sub">${esc(sub)}</div>` : ''}</div>`}
      <button class="icon-btn" data-close aria-label="Close">${icon('x')}</button></div>
    <div class="sheet-body"></div>
    ${foot ? `<div class="sheet-foot"></div>` : ''}`;
  const bodyEl = el.querySelector('.sheet-body');
  if (typeof body === 'string') bodyEl.innerHTML = body; else if (body) bodyEl.appendChild(body);
  if (foot) { const f = el.querySelector('.sheet-foot'); if (typeof foot === 'string') f.innerHTML = foot; else f.appendChild(foot); }
  if (scrim) root.appendChild(scrim);
  root.appendChild(el);

  const api = {
    el, body: bodyEl, peek,
    close() {
      if (api.closed) return;
      api.closed = true;
      sheetStack = sheetStack.filter((s) => s !== api);
      el.classList.add('closing');
      scrim?.remove();
      setTimeout(() => el.remove(), 200);
      onClose?.();
    },
    setHead(html) { el.querySelector('.sheet-head').innerHTML = html + `<button class="icon-btn" data-close aria-label="Close">${icon('x')}</button>`; },
  };
  el.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) api.close(); });
  // Only close on a tap that started on the scrim (a long-press that opened this sheet must not close it on release)
  let scrimDown = false;
  scrim?.addEventListener('pointerdown', () => { scrimDown = true; });
  scrim?.addEventListener('click', () => { if (scrimDown) api.close(); scrimDown = false; });

  // drag the grab handle down to dismiss
  const grab = el.querySelector('.sheet-grab');
  let startY = null;
  grab.addEventListener('pointerdown', (e) => { startY = e.clientY; grab.setPointerCapture(e.pointerId); });
  grab.addEventListener('pointermove', (e) => { if (startY != null) el.style.transform = `translateY(${Math.max(0, e.clientY - startY)}px)`; });
  grab.addEventListener('pointerup', (e) => {
    const dy = e.clientY - (startY ?? e.clientY);
    startY = null;
    if (dy > 80) api.close(); else el.style.transform = '';
  });

  sheetStack.push(api);
  el.tabIndex = -1;
  if (!peek) setTimeout(() => (el.querySelector('[autofocus]') || el).focus({ preventScroll: true }), 50);
  return api;
}
// A yes/no confirmation sheet. Resolves true when confirmed.
export function confirmSheet({ title, body = '', confirm = 'Confirm', cancel = 'Cancel', danger = false }) {
  return new Promise((resolve) => {
    let done = false;
    const s = openSheet({
      title,
      body: body ? `<p class="hint" style="font-size:14.5px">${body}</p>` : '',
      foot: `<button class="btn" data-no>${esc(cancel)}</button><button class="btn ${danger ? 'danger-fill' : 'primary'}" data-yes autofocus>${esc(confirm)}</button>`,
      onClose: () => { if (!done) resolve(false); },
    });
    s.el.querySelector('[data-no]').onclick = () => s.close();
    s.el.querySelector('[data-yes]').onclick = () => { done = true; resolve(true); s.close(); };
  });
}

export function closePeekSheets() { sheetStack.filter((s) => s.peek).forEach((s) => s.close()); }
export function closeAllSheets() { [...sheetStack].forEach((s) => s.close()); }
export function topSheet() { return sheetStack[sheetStack.length - 1]; }
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') topSheet()?.close(); });

export function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

export function distanceM(a, b) {
  const R = 6371e3, toR = Math.PI / 180;
  const dLat = (b.lat - a.lat) * toR, dLng = (b.lng - a.lng) * toR;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * toR) * Math.cos(b.lat * toR) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

export function googleDirections(p, mode = 'transit') {
  return `https://www.google.com/maps/dir/?api=1&destination=${p.lat},${p.lng}&travelmode=${mode}`;
}
export function googlePlace(p) {
  if (p.url && /google\.[a-z.]+\/maps|maps\.app\.goo\.gl|goo\.gl\/maps/.test(p.url)) return p.url;
  return `https://www.google.com/maps/search/?api=1&query=${p.lat},${p.lng}`;
}
