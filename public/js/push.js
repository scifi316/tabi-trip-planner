// Notifications when Tabi is closed (Web Push), switched on per device.
// Which notifications you get is still decided by the switches in Settings; this only decides
// whether this phone or computer also gets them on the lock screen.
import { esc, icon, toast } from './ui.js';

export const isIOS = () => /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
export const standalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

// What this device can do: 'ok' | 'ios-install' (iPhone, not opened from the Home Screen) | 'old-ios' | 'unsupported' | 'insecure'
export function support() {
  if (!isSecureContext) return 'insecure';
  if (isIOS() && !standalone()) return 'PushManager' in window || /OS (1[6-9]|[2-9]\d)_/.test(navigator.userAgent) ? 'ios-install' : 'old-ios';
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return isIOS() ? 'old-ios' : 'unsupported';
  return 'ok';
}

async function registration() {
  const reg = await navigator.serviceWorker.getRegistration() || await navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' });
  return navigator.serviceWorker.ready.then(() => reg).catch(() => reg);
}
async function post(path, body) {
  const r = await fetch(path, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `Error ${r.status}`);
  return j;
}

// Is it on for this device? (Asks the server too: it forgets devices whose push service said "gone".)
export async function status() {
  const s = support();
  if (s !== 'ok') return { support: s, on: false };
  if (Notification.permission === 'denied') return { support: s, on: false, blocked: true };
  try {
    const reg = await registration();
    const sub = await reg.pushManager.getSubscription();
    if (!sub) return { support: s, on: false };
    const r = await post('/api/push/status', { endpoint: sub.endpoint });
    if (!r.on) await post('/api/push/subscribe', { subscription: sub.toJSON() }).then(() => { r.on = true; }).catch(() => {}); // re-register quietly
    return { support: s, on: r.on, endpoint: sub.endpoint };
  } catch { return { support: s, on: false, error: true }; }
}

// Must be called from a tap (iPhone requires it for the permission prompt).
export async function turnOn() {
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error(perm === 'denied' ? 'Notifications are blocked for Tabi. Allow them in this browser’s site settings (or iPhone Settings › Notifications › Tabi), then try again.' : 'You didn’t allow notifications.');
  const reg = await registration();
  const { publicKey } = await (await fetch('/api/push/key', { credentials: 'same-origin' })).json();
  let sub = await reg.pushManager.getSubscription();
  // A subscription made with another key (a different server) has to be replaced
  const key = sub?.options?.applicationServerKey;
  if (sub && key && btoa(String.fromCharCode(...new Uint8Array(key))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') !== publicKey) { await sub.unsubscribe(); sub = null; }
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: publicKey });
  await post('/api/push/subscribe', { subscription: sub.toJSON() });
  localStorage.setItem('tabi.push.asked', 'on');
  dispatchEvent(new Event('tabi:push')); // the Ready for Japan check reports this phone again
}
export async function turnOff() {
  const reg = await registration();
  const sub = await reg.pushManager.getSubscription();
  if (sub) { await post('/api/push/unsubscribe', { endpoint: sub.endpoint }).catch(() => {}); await sub.unsubscribe().catch(() => {}); }
  localStorage.setItem('tabi.push.asked', 'off');
  dispatchEvent(new Event('tabi:push'));
}
export async function sendTest() {
  const reg = await registration();
  const sub = await reg.pushManager.getSubscription();
  if (!sub) throw new Error('Notifications aren’t on for this device.');
  await post('/api/push/test', { endpoint: sub.endpoint });
}

// ---------- the block in Settings ----------
export function pushBlockHtml() {
  return `<div class="row" data-push-row><div class="grow"><div class="label">When Tabi is closed</div>
      <div class="help" data-push-help>Checking this device…</div></div>
      <label class="switch"><input type="checkbox" data-push-toggle disabled aria-label="Notifications on this device when Tabi is closed"><span></span></label></div>
    <div class="row push-test" data-push-test-row hidden><div class="grow help">Notifications are on for this device.</div><button class="btn small" data-push-test>Send a test</button></div>`;
}
export const HELP = {
  'ios-install': 'On iPhone this needs Tabi on your Home Screen: in Safari tap Share › Add to Home Screen, open Tabi from there, then turn this on.',
  'old-ios': 'Needs iOS 16.4 or newer, with Tabi added to the Home Screen.',
  unsupported: 'This browser can’t show notifications when Tabi is closed.',
  insecure: 'Only works on the secure (https) address of Tabi.',
};
export async function bindPushBlock(root) {
  const row = root.querySelector('[data-push-row]');
  if (!row) return;
  const help = row.querySelector('[data-push-help]');
  const box = row.querySelector('[data-push-toggle]');
  const testRow = root.querySelector('[data-push-test-row]');
  const show = (st) => {
    box.checked = !!st.on;
    box.disabled = st.support !== 'ok' || !!st.blocked;
    testRow.hidden = !st.on;
    help.textContent = st.support !== 'ok' ? HELP[st.support]
      : st.blocked ? 'Notifications are blocked for Tabi in this browser’s settings. Allow them there, then turn this on.'
        : st.on ? 'On for this device: you’ll get the notifications you chose below on the lock screen.'
          : 'Get the notifications you chose below on this device’s lock screen, too.';
  };
  show(await status());
  box.onchange = async () => {
    box.disabled = true;
    try {
      if (box.checked) { await turnOn(); toast('Notifications are on for this device'); } else { await turnOff(); toast('Notifications are off for this device'); }
    } catch (e) { toast(e.message, { ms: 7000 }); }
    show(await status());
  };
  const testBtn = root.querySelector('[data-push-test]');
  testBtn.onclick = async () => {
    testBtn.disabled = true;
    try { await sendTest(); toast('Sent. It shows up as a notification (if Tabi is open, look in the notification centre).'); } catch (er) { toast(er.message, { ms: 7000 }); }
    testBtn.disabled = false;
  };
}

// ---------- a one-time nudge in the account sheet ----------
export async function pushNudgeHtml() {
  if (localStorage.getItem('tabi.push.asked')) return '';
  const st = await status().catch(() => null);
  if (!st || st.on || st.blocked || !['ok', 'ios-install'].includes(st.support)) return '';
  return `<div class="push-nudge">${icon('bell')}<div class="grow"><b>Get notified when Tabi is closed</b>
      <div class="help">${st.support === 'ok' ? 'On the lock screen, for the things you chose.' : esc(HELP['ios-install'])}</div></div>
      ${st.support === 'ok' ? '<button class="btn small primary" data-push-on>Turn on</button>' : ''}
      <button class="icon-btn small" data-push-dismiss aria-label="Not now">${icon('x', 'small')}</button></div>`;
}
export function bindPushNudge(root) {
  root.querySelector('[data-push-dismiss]')?.addEventListener('click', (e) => { localStorage.setItem('tabi.push.asked', 'later'); e.currentTarget.closest('.push-nudge').remove(); });
  root.querySelector('[data-push-on]')?.addEventListener('click', async (e) => {
    const n = e.currentTarget.closest('.push-nudge');
    try { await turnOn(); toast('Notifications are on for this device'); n.remove(); } catch (er) { toast(er.message, { ms: 7000 }); }
  });
}
