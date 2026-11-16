// First-run tips: a short spotlight tour for each screen. Skippable, and replayable from Settings.
import { esc } from './ui.js';

const KEY = 'tabi.tour.v1.';
const TOURS = {
  map: [
    { title: 'Welcome to Tabi', text: 'A quick look around takes about 30 seconds. You can skip it and replay the tips any time from Settings.', welcome: true },
    { sel: '#screen-map [data-me-btn]', title: 'This is you', text: 'Tap your picture for notifications and to add a profile photo. A red ! means something new. The dot is green when you’re connected and amber when you’re offline.' },
    { sel: '#screen-map .search', title: 'Search or paste a link', text: 'Search anywhere in Japan, or paste a Google Maps, Apple Maps or My Maps link right here. Press and hold the map to drop a pin.' },
    { sel: '#friend-row', title: 'Friends and subgroups', text: 'Tap Friends to find someone on the map, see their plan for the day, or settle up with them. Tap “Split up” when the group heads off in different directions.' },
    { sel: '#line-strip', title: 'The day’s line', text: 'Each circle is a confirmed stop, in order, like stations on a train line. Filled circles are done and the pulsing one is next. Use the arrows to look at other days.' },
    { sel: '#fab-add', title: 'Add places', text: 'Import your Google My Maps, paste a bunch of links, or search.' },
    { sel: '#tabbar', title: 'Get around', text: 'Switch between the map, the itinerary, money and settings. The arrow hides this bar when you want more map.' },
  ],
  itinerary: [
    { sel: '#screen-itinerary .days', title: 'Pick a day', text: 'Every day of the trip, with how many places are planned. “Unscheduled” holds ideas without a day yet.' },
    { sel: '#screen-itinerary .chips', title: 'Filter by status', text: 'Confirmed stops make up each day’s line. Maybe and Suggested are still up for discussion; Missed shows confirmed stops whose day has passed.' },
    { sel: '#screen-itinerary .vote-mini', title: 'Vote', text: 'Thumbs up or down on any place. Open a place to confirm it, veto it, set a time, or get directions.' },
    { sel: '#screen-itinerary [data-add]', title: 'Anyone can add', text: 'Everyone can add and remove places. Removing asks first, and the trip admin can always bring a place back.' },
  ],
  // Shown once to people who already finished the map tour before these features existed.
  'new-1.3': [
    { sel: '#screen-map [data-me-btn]', title: 'New: notifications', text: 'A red ! on your picture means something new, like being added to a subgroup, someone owing you money, or a change to today’s plan. Tap it to read them. Choose what you get in Settings.' },
    { sel: '#screen-map [data-me-btn]', title: 'New: profile photos', text: 'Tap your picture to add a photo. Friends see it on the map instead of your initials.' },
    { sel: '#tabbar [data-tab=money]', title: 'New: currency converter', text: 'Money has a Convert tab for quick prices in your home currency. It keeps the last rates, so it works offline too.' },
  ],
  money: [
    { sel: '#screen-money .money-summary', title: 'Who owes whom', text: 'Your running total, plus exactly what you owe each person or what they owe you. Record a payment when someone pays you back.' },
    { sel: '#screen-money [data-add]', title: 'Add an expense', text: 'Snap the receipt and tap “Read receipt” to fill in the total and items. Split equally, by exact amounts, by shares, or item by item.' },
    { sel: '#screen-money .chips', title: 'Private expenses', text: 'Mark an expense private and only the people in it can see it. Everything else is shared with the group.' },
  ],
  settings: [
    { sel: '#screen-settings [data-section=location]', title: 'Location sharing', text: 'Off until you turn it on. For sharing while your phone is locked, set up the free OwnTracks app here.' },
    { sel: '#screen-settings [data-section=offline]', title: 'Before you fly', text: 'Save maps on Wi-Fi so the places you planned still show up without a signal.' },
  ],
};

let active = null;

export function tourDone(screen) { return localStorage.getItem(KEY + screen) === 'done'; }
export function resetTours() { Object.keys(TOURS).forEach((s) => localStorage.removeItem(KEY + s)); }
function finish(screen, all = false) {
  (all ? Object.keys(TOURS) : screen === 'map' ? ['map', 'new-1.3'] : [screen]).forEach((s) => localStorage.setItem(KEY + s, 'done'));
  active?.el.remove();
  removeEventListener('resize', place);
  active = null;
}

// Don't pop a tour over someone who's already busy: if they tap within the delay, wait for next visit.
let lastTouch = 0;
addEventListener('pointerdown', () => { lastTouch = Date.now(); }, true);

const SCREEN_OF = { 'new-1.3': 'map' };
export function maybeStartTour(screen, { delay = 700, force = false } = {}) {
  if (screen === 'map' && !force && tourDone('map') && !tourDone('new-1.3')) screen = 'new-1.3';
  if (!TOURS[screen] || (!force && tourDone(screen))) return;
  const openedAt = Date.now();
  setTimeout(() => {
    if (active || document.getElementById(`screen-${SCREEN_OF[screen] || screen}`)?.hidden) return;
    if (!force && lastTouch > openedAt + 50) return;
    if (document.querySelector('.sheet:not(.closing)')) return; // don't interrupt something in progress
    start(screen);
  }, delay);
}

function visibleTarget(sel) {
  if (!sel) return null;
  const el = document.querySelector(sel);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return r.width > 4 && r.height > 4 && r.bottom > 0 && r.top < innerHeight ? el : null;
}

function start(screen) {
  const steps = TOURS[screen].filter((s) => s.welcome || visibleTarget(s.sel));
  if (!steps.length) return finish(screen);
  const el = document.createElement('div');
  el.className = 'tour';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-modal', 'true');
  el.innerHTML = '<div class="tour-spot"></div><div class="tour-card" tabindex="-1"></div>';
  document.body.appendChild(el);
  active = { el, screen, steps, i: 0 };
  addEventListener('resize', place);
  render();
}

function render() {
  const { el, steps, i, screen } = active;
  const s = steps[i];
  const card = el.querySelector('.tour-card');
  const real = steps.filter((x) => !x.welcome).length;
  const n = steps.slice(0, i + 1).filter((x) => !x.welcome).length;
  card.innerHTML = s.welcome ? `
      <h3>${esc(s.title)}</h3><p>${esc(s.text)}</p>
      <div class="tour-actions"><button class="btn" data-skip-all>Skip tips</button><button class="btn primary" data-next>Show me around</button></div>`
    : `<div class="tour-count num">${n} of ${real}</div>
      <h3>${esc(s.title)}</h3><p>${esc(s.text)}</p>
      <div class="tour-actions"><button class="btn" data-skip>Skip</button><button class="btn primary" data-next>${i === steps.length - 1 ? 'Done' : 'Next'}</button></div>`;
  card.querySelector('[data-next]').onclick = () => { if (active.i < steps.length - 1) { active.i++; render(); } else finish(screen); };
  card.querySelector('[data-skip]')?.addEventListener('click', () => finish(screen));
  card.querySelector('[data-skip-all]')?.addEventListener('click', () => finish(screen, true));
  card.onkeydown = (e) => { if (e.key === 'Escape') finish(screen); };
  place();
  card.focus({ preventScroll: true });
}

function place() {
  if (!active) return;
  const { el, steps, i } = active;
  const s = steps[i];
  const spot = el.querySelector('.tour-spot');
  const card = el.querySelector('.tour-card');
  const target = visibleTarget(s.sel);
  if (!target) {
    spot.style.cssText = 'left:50%;top:40%;width:0;height:0';
    card.style.cssText = 'left:50%;top:50%;transform:translate(-50%,-50%)';
    return;
  }
  const r = target.getBoundingClientRect();
  const pad = 6;
  spot.style.cssText = `left:${r.left - pad}px;top:${r.top - pad}px;width:${r.width + pad * 2}px;height:${r.height + pad * 2}px`;
  const cw = Math.min(340, innerWidth - 24);
  const left = Math.max(12, Math.min(innerWidth - cw - 12, r.left + r.width / 2 - cw / 2));
  const below = r.bottom + 14;
  const ch = card.offsetHeight || 170;
  const top = below + ch < innerHeight - 12 ? below : Math.max(12, r.top - 14 - ch);
  card.style.cssText = `left:${left}px;top:${top}px;width:${cw}px`;
}
