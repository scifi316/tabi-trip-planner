// The Tabi Android app: a full-screen Tabi (Chrome underneath, so sign-in and notifications carry
// over) plus background location sharing, without OwnTracks. Admins upload each build here; people
// on Android phones download it and connect it to their account with one tap.
import { state, api, emit, op } from './store.js';
import { esc, icon, toast, openSheet, confirmSheet, ago } from './ui.js';

const KEY = 'tabi.android';
// Inside the app, Tabi is opened as /?app=android&appv=<version code>; remembered for this install
export function rememberApp() {
  const u = new URL(location.href);
  if (u.searchParams.get('app') !== 'android') return;
  try { localStorage.setItem(KEY, JSON.stringify({ v: +u.searchParams.get('appv') || 0 })); } catch { /* private mode */ }
  u.searchParams.delete('app'); u.searchParams.delete('appv');
  history.replaceState(null, '', u.pathname + u.search + u.hash);
}
export const inApp = () => { try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { return null; } };
export const onAndroid = () => /Android/i.test(navigator.userAgent);
const app = () => state.config.androidApp || null;
export const updateWaiting = () => { const a = app(), me = inApp(); return !!(a && me && a.code > (me.v || 0)); };
const mb = (b) => `${(b / 1048576).toFixed(b >= 10485760 ? 0 : 1)} MB`;

// One tap hands the app what it needs: this site, its private-link key, your name and your OwnTracks token
export function setupLink() {
  const me = state.me;
  const q = new URLSearchParams({ h: location.hostname, u: me?.name || '', t: me?.owntracksToken || '', start: '1' });
  if (state.config.gate) q.set('g', state.config.gate);
  return `tabi://setup?${q}`;
}

// ---------- Settings › Location: the "share when Tabi is closed" row ----------
export function closedSharingHtml(badge) {
  const a = app();
  if (inApp()) {
    return `<div class="row stack" data-android-row>
      <div class="label">Share even when Tabi is closed</div>
      <div class="help">The Tabi app can keep sharing in the background, like Find My. It asks Android for location permission, and shows a notification while it shares, with a Stop button.</div>
      ${badge}
      <div class="btn-row"><a class="btn small primary" href="${esc(setupLink())}" data-android-setup>${icon('pin', 'small')}Set up background sharing</a>
        ${updateWaiting() ? (inApp().v >= 3 // 1.1.0 and later update themselves in place
    ? `<a class="btn small" href="tabi://update">${icon('download', 'small')}Update the app (${esc(a.version)})</a>`
    : `<button class="btn small" data-android-sheet>${icon('download', 'small')}Update the app (${esc(a.version)})</button>`) : ''}</div>
      <button class="linklike" data-owntracks>Or use OwnTracks instead</button>
    </div>`;
  }
  if (onAndroid() && a) {
    return `<div class="row stack" data-android-row>
      <div class="label">Share even when Tabi is closed</div>
      <div class="help">Get the Tabi app for Android: Tabi on your home screen, and it keeps sharing your location in the background. No OwnTracks needed.</div>
      ${badge}
      <div class="btn-row"><button class="btn small primary" data-android-sheet>${icon('download', 'small')}Get the Android app</button>
        <button class="btn small" data-owntracks>Use OwnTracks instead</button></div>
    </div>`;
  }
  return null; // the OwnTracks row as before
}
export function bindClosedSharing(root, ownTracksSheet) {
  root.querySelector('[data-android-sheet]')?.addEventListener('click', openAndroidSheet);
  root.querySelector('[data-android-row] [data-owntracks]')?.addEventListener('click', ownTracksSheet);
  root.querySelector('[data-android-setup]')?.addEventListener('click', connecting);
}
// Connecting the app means you want to share: switch sharing on too, or the app would sit paused
// TA-4: wait for the server to have it before opening the app. Otherwise the app's first report
// could arrive first, hear "sharing is off", and pause.
async function connecting(e) {
  if (!state.me?.owntracksToken) { e.preventDefault(); toast('Your account has no location token yet. Open “Use OwnTracks instead” and tap “Make a new token”, then try again.'); return; }
  if (state.me.shareLocation) return; // the link opens the app as it is
  e.preventDefault();
  const href = e.currentTarget.href;
  await Promise.race([op('loc.share', { on: true }), new Promise((r) => setTimeout(r, 2500))]);
  location.href = href;
}

// ---------- the download sheet ----------
export function openAndroidSheet() {
  const a = app();
  if (!a) { toast('The Android app isn’t available on this trip yet. Ask a trip admin.'); return; }
  const s = openSheet({
    title: 'Tabi for Android', sub: `Version ${a.version}, ${mb(a.size)}`, className: 'android-sheet',
    body: `
      ${a.test ? '<p class="callout warn">This is a test version. When the finished app arrives you’ll need to uninstall this one first.</p>' : ''}
      <ol class="android-steps">
        <li><b>Download and install it.</b>
          <span class="help">Android asks whether your browser may install apps. Allow it for this one, then tap Install. Android may also say the app is from an unknown developer: it’s from your trip admin, so tap “Install anyway”.</span>
          <a class="btn primary" href="/api/app/tabi.apk" download>${icon('download', 'small')}Download Tabi ${esc(a.version)}</a></li>
        <li><b>Connect it to your account.</b>
          <span class="help">Opens the app, which asks for location permission and starts sharing. You can stop any time from its notification.</span>
          <a class="btn" href="${esc(setupLink())}" data-android-connect>${icon('pin', 'small')}Connect the app</a></li>
        <li><b>Open Tabi from your home screen.</b>
          <span class="help">It opens full screen, already signed in. You can remove Tabi from your browser’s home screen if you added it before.</span></li>
      </ol>`,
  });
  s.el.querySelector('[data-android-connect]').addEventListener('click', connecting);
  return s;
}

// ---------- Settings › Android app (admins) ----------
export function adminHtml() {
  const a = app();
  return `<section class="section" data-section="android"><h2>Android app (admins)</h2><div class="card">
    <div class="row stack"><div class="help">Build the app on GitHub (the <b>Android app</b> workflow), download the APK from the <b>android-build</b> release, and upload it here. People on Android then see “Get the Android app” in Settings, and phones that have it are told about updates.</div></div>
    <div class="row"><div class="grow"><div class="label">${a ? `Version ${esc(a.version)}${a.test ? ' <span class="tag new">Test build</span>' : ''}` : 'Not uploaded yet'}</div>
      ${a ? `<div class="help">${mb(a.size)}, uploaded ${esc(ago(a.at))}</div>` : ''}</div>
      <label class="btn small">${icon('download', 'small')}${a ? 'Upload a new version' : 'Upload APK'}<input type="file" accept=".apk,application/vnd.android.package-archive" data-apk hidden></label></div>
    <p class="err" data-apk-msg hidden></p>
    ${a ? '<div class="row"><div class="grow"><div class="label">Remove the app</div><div class="help">Hides the download. Phones that have it keep working.</div></div><button class="btn small danger" data-apk-remove>Remove…</button></div>' : ''}
  </div></section>`;
}
export function bindAdmin(root) {
  const input = root.querySelector('[data-apk]');
  const msg = root.querySelector('[data-apk-msg]');
  input?.addEventListener('change', async () => {
    const f = input.files[0];
    input.value = '';
    if (!f) return;
    msg.hidden = false; msg.className = 'help'; msg.textContent = `Uploading ${mb(f.size)}…`;
    try {
      const r = await api('/api/app/apk', { method: 'POST', body: f, headers: { 'Content-Type': 'application/vnd.android.package-archive' } });
      state.config.androidApp = r.app; emit('app');
      toast(`Uploaded version ${r.app.version}`);
      const m = root.querySelector('[data-apk-msg]');
      if (m && r.warnings?.length) { m.hidden = false; m.className = 'callout warn'; m.textContent = r.warnings.join(' '); }
    } catch (e) {
      const m = root.querySelector('[data-apk-msg]') || msg;
      m.hidden = false; m.className = 'err'; m.textContent = e.message;
    }
  });
  root.querySelector('[data-apk-remove]')?.addEventListener('click', async () => {
    if (!(await confirmSheet({ title: 'Remove the Android app?', body: 'The download goes away. Phones that already have it keep working.', confirm: 'Remove', danger: true }))) return;
    try { await api('/api/app/apk', { method: 'DELETE' }); state.config.androidApp = null; emit('app'); } catch (e) { toast(e.message); }
  });
}
