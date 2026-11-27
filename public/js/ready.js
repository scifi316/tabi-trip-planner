// Ready for Japan (TA-36): the card at the top of Settings, the sheet shown once after sign-in,
// this phone's report to the server, and the admins' Nudge. The words come from readycheck.js.
import { state, on, emit, op, wsSend, today } from './store.js';
import { esc, icon, toast, openSheet, fmtDay } from './ui.js';
import { status as pushStatus, turnOn, isIOS, standalone, HELP as PUSH_HELP } from './push.js';
import { inApp, onAndroid, openAndroidSheet } from './android.js';
import { stopsPackState } from './offline.js';
import { recoveryAction, recoveryPromptThisLoad } from './account.js';
import { openPhotoEditor } from './photo.js';
import { when } from './owntracks.js';
import { readyModel, cardHidden, memberLine, promptDue } from './readycheck.js';

// ---------- this phone ----------
const DEVICE_KEY = 'tabi.device';
let memoryId = null;
const newId = () => Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, '0')).join('');
export function deviceId() {
  try {
    let id = localStorage.getItem(DEVICE_KEY);
    if (!id) { id = newId(); localStorage.setItem(DEVICE_KEY, id); }
    return id;
  } catch { return (memoryId ||= newId()); }
}
const platform = () => (isIOS() ? 'ios' : onAndroid() ? 'android' : 'other');
let pushInfo = null; // { support, on, blocked, endpoint }, from the last check
let pushCheckedAt = 0;
function local() {
  const app = !!inApp();
  return { installed: standalone() || app, android: app, inApp: app, platform: platform(), androidApp: !!state.config.androidApp,
    push: pushInfo || { support: 'ok', on: false }, maps: stopsPackState() };
}
export const model = () => readyModel(state.me?.ready, deviceId(), local(), { when, pushHelp: PUSH_HELP });
export const readyCardShown = () => !!state.me && !cardHidden(state.trip, today());

// Tell the server what only the phone knows: home screen or app, its notification subscription, offline maps.
// Sent when it connects and whenever one of those changes.
let lastSent = '';
export async function reportDevice({ push = false } = {}) {
  if (!state.me) return;
  if (push || !pushInfo) {
    pushCheckedAt = Date.now();
    pushInfo = await pushStatus().catch(() => ({ support: 'unsupported', on: false }));
  }
  const l = local();
  const msg = { t: 'device', id: deviceId(), installed: l.installed, android: l.android, endpoint: pushInfo.on ? pushInfo.endpoint || null : null,
    blocked: !!pushInfo.blocked, maps: l.maps.state, mapsAt: l.maps.at };
  const json = JSON.stringify(msg);
  if (json === lastSent || state.conn !== 'online') return;
  lastSent = json;
  wsSend(msg);
  emit('device-ready');
}
let placesTimer = null;
on('state', () => { lastSent = ''; reportDevice({ push: true }); maybePromptReady(); }); // a new connection: report again
on('places', () => { clearTimeout(placesTimer); placesTimer = setTimeout(() => reportDevice(), 1500); }); // offline maps may need saving again
addEventListener('tabi:push', () => reportDevice({ push: true })); // turned on or off in Settings
document.addEventListener('visibilitychange', () => { if (!document.hidden && Date.now() - pushCheckedAt > 60e3) reportDevice({ push: true }); });

// ---------- the card at the top of Settings ----------
let detailsOpen = false; // a ready card is shrunk to one line until tapped
const pill = (i) => (i.label ? ` <span class="ready-pill" data-tone="${esc(i.tone)}">${esc(i.label)}</span>` : '');
function itemHtml(i, { downloading }) {
  const busy = i.action?.id === 'maps' && downloading;
  return `<div class="row ready-item" data-ok="${i.ok}" data-ready-item="${esc(i.key)}">
    <span class="ready-tick" aria-label="${i.ok ? 'Done' : 'Not done yet'}">${i.ok ? icon('check', 'small') : ''}</span>
    <div class="grow"><div class="label">${esc(i.title)}${i.optional ? ` <span class="ready-opt">${esc(i.optional)}</span>` : ''}${pill(i)}</div>
      <div class="help">${esc(i.text)}</div></div>
    ${i.action ? `<button class="btn small${!i.optional ? ' primary' : ''}" data-ready-fix="${esc(i.action.id)}"${busy ? ' disabled' : ''}>${busy ? 'Saving…' : esc(i.action.label)}</button>` : ''}
  </div>`;
}
export function readyCardHtml({ downloading = false } = {}) {
  if (!readyCardShown()) return '';
  const m = model();
  if (m.deviceReady && !detailsOpen) {
    const extra = m.items.filter((i) => i.optional && !i.ok).map((i) => i.title.toLowerCase());
    return `<div class="ready-done" data-section="ready" role="status"><span class="ready-badge">${icon('check')}</span>
      <div class="grow"><b>You’re ready for Japan</b><div class="help">Everything that matters is set on this phone.${extra.length ? ` Still worth doing: ${esc(extra.join(' and '))}.` : ''}</div></div>
      <button class="btn small" data-ready-toggle>Details</button></div>`;
  }
  const start = state.trip?.start;
  const title = m.deviceReady ? 'You’re ready for Japan' : m.otherDevice ? 'You’re ready on your other phone' : 'Get ready for Japan';
  const sub = m.deviceReady ? 'Everything that matters is ticked.'
    : m.otherDevice ? 'This phone can be set up too, if you’ll use it on the trip.'
      : `${m.done} of ${m.total} done on this phone.${start && today() <= start ? ` Finish before ${fmtDay(start)}.` : ''}`;
  return `<section class="section ready-sec" data-section="ready"><div class="card ready-card">
    <div class="row ready-head"><div class="ready-ring" style="--p:${(m.done / m.total).toFixed(3)}" aria-hidden="true"><span class="num">${m.done}/${m.total}</span></div>
      <div class="grow"><div class="label">${esc(title)}</div><div class="help">${esc(sub)}</div></div>
      ${m.deviceReady ? '<button class="btn small" data-ready-toggle>Hide</button>' : ''}</div>
    ${m.items.map((i) => itemHtml(i, { downloading })).join('')}
  </div></section>`;
}

// deps: what only Settings has: { render, ownTracksSheet, startDownload }
export function bindReadyCard(el, deps) {
  el.querySelector('[data-ready-toggle]')?.addEventListener('click', () => { detailsOpen = !detailsOpen; deps.render(); });
  el.querySelectorAll('[data-ready-fix]').forEach((b) => b.onclick = () => fix(b.dataset.readyFix, b, deps));
}
async function fix(id, btn, deps) {
  switch (id) {
    case 'install': return installSheet();
    case 'android': return openAndroidSheet();
    case 'push-on': {
      btn.disabled = true;
      try { await turnOn(); toast('Notifications are on for this phone'); } catch (e) { toast(e.message, { ms: 7000 }); }
      await reportDevice({ push: true });
      return deps.render();
    }
    case 'share-on': {
      const r = await op('loc.share', { on: true });
      return toast(r.ok === false ? r.error : 'Sharing on. Your location updates while Tabi is open.');
    }
    case 'share-setup': // keep sharing when Tabi is closed: the Android app, or OwnTracks
      if (inApp()) return document.querySelector('[data-section=location]')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      if (onAndroid() && state.config.androidApp) return openAndroidSheet();
      return deps.ownTracksSheet();
    case 'recovery': return recoveryAction();
    case 'photo': return openPhotoEditor();
    case 'maps': return deps.startDownload('stops');
  }
}

function installSheet() {
  const p = platform();
  const steps = p === 'ios' ? [
    'Open Tabi in <b>Safari</b>.',
    'Tap the <b>Share</b> button, then <b>Add to Home Screen</b>.',
    'Open <b>Tabi</b> from your home screen. If it asks, sign in again.',
  ] : p === 'android' ? [
    'In Chrome, tap the <b>⋮</b> menu.',
    'Tap <b>Add to Home screen</b> or <b>Install app</b>.',
    'Open <b>Tabi</b> from your home screen.',
  ] : ['In your browser’s menu, choose <b>Install app</b> or <b>Add to Home Screen</b>.', 'Open Tabi from there.'];
  openSheet({ title: 'Put Tabi on your home screen', sub: 'It opens full screen, and it can show notifications on the lock screen.',
    body: `<ol class="ready-steps">${steps.map((s) => `<li>${s}</li>`).join('')}</ol>` });
}

// Open Settings at the card (from the sign-in sheet, or an admin's nudge)
export function showReadyCard() {
  emit('go', 'settings');
  setTimeout(() => document.querySelector('[data-section=ready]')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 200);
}

// ---------- once after sign-in, with "Remind me later" ----------
const promptKey = () => `tabi.ready.prompt.${state.me?.id}`;
const readPrompt = () => { try { return JSON.parse(localStorage.getItem(promptKey()) || 'null'); } catch { return null; } };
const savePrompt = (v) => { try { localStorage.setItem(promptKey(), JSON.stringify(v)); } catch { /* private mode */ } };
let promptTimer = null, promptedThisLoad = false;
export function maybePromptReady() {
  if (promptTimer || promptedThisLoad) return;
  const check = () => {
    promptTimer = null;
    if (promptedThisLoad || !state.me?.ready || !readyCardShown() || !promptDue(readPrompt())) return;
    if (recoveryPromptThisLoad()) return; // one prompt per load: the recovery code asks first, this waits for the next
    const m = model();
    if (m.deviceReady || m.personReady) return;
    // Wait for tours, other sheets and sign-in to finish
    if (document.querySelector('.tour, .sheet:not(.closing)') || document.getElementById('app')?.hidden) { promptTimer = setTimeout(check, 3000); return; }
    promptedThisLoad = true;
    savePrompt({ shown: Date.now() });
    const todo = m.items.filter((i) => !i.ok && !i.optional);
    const s = openSheet({
      title: 'Ready for Japan?', sub: `${m.done} of ${m.total} done on this phone`, className: 'ready-sheet',
      body: `<p>A few things to set up before the trip, so you hear about changes and the group can find you:</p>
        <ul class="ready-todo">${todo.map((i) => `<li>${esc(i.title)}</li>`).join('')}</ul>
        <p class="help">They’re at the top of Settings, each with a button that does it.</p>`,
      foot: '<button class="btn" data-later>Remind me later</button><button class="btn primary" data-now>Show me</button>',
    });
    s.el.querySelector('[data-later]').onclick = () => { savePrompt({ until: Date.now() + 864e5 }); s.close(); };
    s.el.querySelector('[data-now]').onclick = () => { s.close(); showReadyCard(); };
  };
  promptTimer = setTimeout(check, 4000);
}
if (state.me && state.conn === 'online') { reportDevice({ push: true }); maybePromptReady(); } // loaded after the first state arrived

// ---------- admins: everyone's check in the member list ----------
export function memberReady(u) {
  if (!state.me?.isAdmin || !state.ready || !readyCardShown()) return null;
  return memberLine(state.ready.find((r) => r.id === u.id));
}
export async function nudge(u, btn) {
  btn.disabled = true;
  const r = await op('ready.nudge', { id: u.id });
  if (r.ok === false) { toast(r.error); btn.disabled = false; return; }
  btn.textContent = 'Nudged';
  toast(`Nudged ${u.name}. They’ll see what’s left at the top of Settings.`);
}
