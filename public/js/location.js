// GPS: in-app location sharing (while the app is open) + one-off "where am I".
// Background tracking when the app is closed is handled by OwnTracks (see Settings).
import { state, on, emit, send } from './store.js';
import { distanceM, toast } from './ui.js';

const DEVICE_KEY = 'tabi.gps.device'; // this device sends location (per device, so a laptop doesn't override your phone)
let watchId = null;
let pos = null;
let lastSent = null;
let wakeLock = null;

export const myPosition = () => pos;
export const deviceSending = () => localStorage.getItem(DEVICE_KEY) !== 'off';
export const isWatching = () => watchId != null;
// Following yourself on the map needs live GPS even when you aren't sharing; nothing is sent unless sharing is on.
let followWanted = false;
export function setFollowGps(on) { followWanted = on; syncWatcher(); }

function onPos(p) {
  pos = { lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy, heading: p.coords.heading, speed: p.coords.speed, ts: p.timestamp || Date.now() };
  emit('mypos', pos);
  maybeSend();
}

function maybeSend(force = false) {
  if (!pos || !state.me?.shareLocation || !deviceSending()) return;
  const now = Date.now();
  const moved = lastSent ? distanceM(lastSent, pos) : Infinity;
  const elapsed = lastSent ? now - lastSent.at : Infinity;
  // Send when we've moved 20 m, or every 60 s while stationary; never more than every 4 s.
  if (force || (elapsed > 4000 && (moved > 20 || elapsed > 60000))) {
    send('loc.update', { lat: pos.lat, lng: pos.lng, acc: pos.acc, heading: pos.heading, speed: pos.speed, ts: pos.ts, batt: battery });
    lastSent = { ...pos, at: now };
  }
}

let battery = null;
navigator.getBattery?.().then((b) => {
  const upd = () => { battery = Math.round(b.level * 100); };
  upd(); b.addEventListener('levelchange', upd);
}).catch(() => {});

export function startWatching() {
  if (watchId != null || !('geolocation' in navigator)) return;
  if (!isSecureContext) { toast('Location needs HTTPS. Open the app through your https:// address.'); return; }
  watchId = navigator.geolocation.watchPosition(onPos, (err) => {
    if (err.code === 1) {
      toast('Location permission is off for this site. Turn it on in your browser settings to share.');
      stopWatching();
    }
  }, { enableHighAccuracy: true, maximumAge: 10000, timeout: 30000 });
  if (localStorage.getItem('tabi.wake') === 'on') requestWake();
}

export function stopWatching() {
  if (watchId != null) navigator.geolocation.clearWatch(watchId);
  watchId = null;
  wakeLock?.release().catch(() => {});
  wakeLock = null;
}

export function locateOnce() {
  return new Promise((resolve, reject) => {
    if (!('geolocation' in navigator)) return reject(new Error('This browser cannot share location.'));
    if (!isSecureContext) return reject(new Error('Location needs HTTPS. Open the app through your https:// address.'));
    if (pos && Date.now() - pos.ts < 15000) return resolve(pos);
    navigator.geolocation.getCurrentPosition((p) => { onPos(p); resolve(pos); },
      (e) => reject(new Error(e.code === 1 ? 'Location permission is off for this site.' : 'Could not get your location. Try again outside or near a window.')),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 5000 });
  });
}

export async function requestWake() {
  try {
    if ('wakeLock' in navigator && !document.hidden) wakeLock = await navigator.wakeLock.request('screen');
  } catch { /* not allowed right now */ }
}

// Keep watching while sharing is on and the app is visible.
export function syncWatcher() {
  const want = (state.me?.shareLocation && deviceSending()) || followWanted;
  if (want && !document.hidden) { startWatching(); maybeSend(true); }
  else if (!want) stopWatching();
}
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) { syncWatcher(); if (watchId && localStorage.getItem('tabi.wake') === 'on') requestWake(); }
});
on('users', syncWatcher);
on('state', syncWatcher);
on('conn', (c) => { if (c === 'online') { lastSent = null; maybeSend(true); } });
