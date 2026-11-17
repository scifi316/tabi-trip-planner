// Account recovery: "Forgot password?" on the sign-in screen, one-time reset links from an admin,
// and the recovery code everyone is asked to set up once.
import { state, api, op } from './store.js';
import { esc, icon, openSheet, toast } from './ui.js';
import { LOGO } from './main.js';


// ---------- the code itself ----------
function codeBlock(code, name) {
  return `
    <div class="rc-code num" data-rc aria-label="Recovery code ${esc(code.split('').join(' '))}">${esc(code)}</div>
    <div class="rc-actions">
      <button type="button" class="btn small" data-rc-copy>${icon('copy', 'small')}Copy</button>
      <button type="button" class="btn small" data-rc-file>${icon('download', 'small')}Save as a file</button>
      ${navigator.share ? `<button type="button" class="btn small" data-rc-share>${icon('share', 'small')}Share to Notes…</button>` : ''}
    </div>
    <p class="help rc-help">Keep it somewhere only you can open: a password manager, your notes app, or a screenshot. Anyone with this code and your name can set a new password for ${esc(name)}.</p>
    <label class="check-row rc-check"><input type="checkbox" data-rc-saved> I’ve saved my recovery code</label>`;
}
function bindCodeBlock(root, code, name, onSaved) {
  const text = `Tabi recovery code for ${name}${state.trip?.name ? ` (${state.trip.name})` : ''}:\n\n${code}\n\nIf you forget your password, choose “Forgot password?” on the Tabi sign-in screen and enter this code. It works once; Tabi then gives you a new one.`;
  root.querySelector('[data-rc-copy]').onclick = async () => {
    try { await navigator.clipboard.writeText(code); toast('Recovery code copied'); } catch { selectCode(root); }
  };
  root.querySelector('[data-rc-file]').onclick = () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    a.download = 'tabi-recovery-code.txt';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  };
  root.querySelector('[data-rc-share]')?.addEventListener('click', () => navigator.share({ title: 'Tabi recovery code', text }).catch(() => {}));
  const box = root.querySelector('[data-rc-saved]');
  box.onchange = () => onSaved(box.checked);
}
function selectCode(root) {
  const r = document.createRange();
  r.selectNodeContents(root.querySelector('[data-rc]'));
  getSelection().removeAllRanges();
  getSelection().addRange(r);
}

// ---------- the recovery code's states ----------
// none        – never set up
// pending     – made, and works, but not confirmed as saved: it can be shown again from Settings
// unconfirmed – made before v1.6, when we didn't ask; it works, but can't be shown again
// saved       – confirmed as saved, and hidden for good
export const recoveryStatus = () => state.me?.recovery?.status || (state.me?.recovery?.set ? 'saved' : 'none');

// Show a code, with "I've saved it" to hide it. Closing the sheet any other way keeps it in Settings.
function showCode(code, { title, sub }) {
  shownThisLoad = true; // they've just seen it; don't also nag this visit
  const name = state.me.name;
  let acked = false;
  const s = openSheet({
    title, sub, className: 'rc-sheet',
    onClose: () => { if (!acked) toast('Your code stays in Settings › Account recovery until you’ve saved it.', { ms: 5000 }); },
    body: codeBlock(code, name),
    foot: '<button class="btn" data-later>Later</button><button class="btn primary" data-done disabled>I’ve saved it, hide it</button>',
  });
  const done = s.el.querySelector('[data-done]');
  bindCodeBlock(s.el, code, name, (ok) => { done.disabled = !ok; });
  s.el.querySelector('[data-later]').onclick = () => s.close();
  done.onclick = async () => {
    done.disabled = true;
    const r = await op('recovery.ack');
    if (r.ok === false) { done.disabled = false; return toast(r.error || 'You need to be online to do this.'); }
    acked = true;
    s.close();
    toast('Account recovery is set up');
  };
  return s;
}

// ---------- set up (or replace) the recovery code, from the prompt or Settings ----------
export async function openRecoverySetup({ replacing = false } = {}) {
  const r = await op('recovery.setup');
  if (r.ok === false) return toast(r.error || 'You need to be online to do this.');
  showCode(r.code, {
    title: replacing ? 'Your new recovery code' : 'Your recovery code',
    sub: replacing ? 'The old code no longer works.' : 'If you ever forget your password, this lets you set a new one yourself.',
  });
}

// "View code" in Settings, while it hasn't been confirmed as saved
export async function viewRecoveryCode() {
  const r = await op('recovery.view');
  if (r.ok === false) return toast(r.error || 'You need to be online to see your code.');
  showCode(r.code, { title: 'Your recovery code', sub: 'Save it somewhere safe, then hide it. It already works.' });
}

// Codes made before we asked: did they save it?
export function confirmOldCode({ onLater } = {}) {
  const at = state.me?.recovery?.setAt;
  const s = openSheet({
    title: 'Did you save your recovery code?',
    className: 'rc-sheet',
    body: `
      <div class="rc-intro"><div class="rc-icon">${icon('lock')}</div>
        <p>You made one${at ? ` on ${new Date(at).toLocaleDateString([], { day: 'numeric', month: 'short' })}` : ''}. For safety Tabi only keeps a scrambled copy, so it can’t be shown again.</p></div>
      <p class="help">If you can’t find it, make a new one: the old code stops working.</p>
      ${onLater ? '<button class="linklike" data-later>Remind me later</button>' : ''}`,
    foot: '<button class="btn" data-new>Make a new code</button><button class="btn primary" data-yes>Yes, I saved it</button>',
  });
  s.el.querySelector('[data-new]').onclick = () => { s.close(); openRecoverySetup({ replacing: true }); };
  s.el.querySelector('[data-later]')?.addEventListener('click', () => { onLater(); s.close(); });
  s.el.querySelector('[data-yes]').onclick = async () => {
    const r = await op('recovery.ack');
    if (r.ok === false) return toast(r.error || 'You need to be online to do this.');
    s.close();
    toast('Thanks. Account recovery is set up');
  };
}

// The Settings button does whatever the next step is
export function recoveryAction() {
  const st = recoveryStatus();
  if (st === 'pending') return viewRecoveryCode();
  if (st === 'unconfirmed') return confirmOldCode();
  return openRecoverySetup({ replacing: st === 'saved' });
}

// Asked after signing in (and again 3 days after "Remind me later") until the code is saved.
// Checked whenever the account changes, not just once per load, so it isn't missed when the
// app starts offline or from a saved copy.
let prompting = false;
let shownThisLoad = false;
const due = () => {
  const rec = state.me?.recovery;
  return !!rec && recoveryStatus() !== 'saved' && !(rec.snoozeUntil && rec.snoozeUntil > Date.now());
};
export function maybePromptRecovery() {
  if (prompting || shownThisLoad || !due()) return;
  prompting = true;
  const show = () => {
    if (!due()) { prompting = false; return; } // saved or snoozed meanwhile
    // Wait for tours, other sheets and sign-in to finish first
    if (document.querySelector('.tour, .sheet:not(.closing)') || document.getElementById('app')?.hidden) return setTimeout(show, 3000);
    prompting = false;
    shownThisLoad = true;
    const st = recoveryStatus();
    const later = () => { op('recovery.snooze'); s.close(); };
    let s;
    if (st === 'pending') {
      s = openSheet({
        title: 'Finish protecting your account',
        sub: 'Your recovery code is ready.',
        className: 'rc-sheet',
        body: `<div class="rc-intro"><div class="rc-icon">${icon('lock')}</div>
          <p>You haven’t confirmed that you saved it yet. Save it in your password manager or notes, then hide it.</p></div>`,
        foot: '<button class="btn" data-later>Remind me later</button><button class="btn primary" data-now>Show my code</button>',
      });
      s.el.querySelector('[data-now]').onclick = () => { s.close(); viewRecoveryCode(); };
    } else if (st === 'unconfirmed') {
      confirmOldCode({ onLater: () => op('recovery.snooze') });
      return;
    } else {
      s = openSheet({
        title: 'Protect your account',
        sub: 'Takes 30 seconds.',
        className: 'rc-sheet',
        body: `
          <div class="rc-intro">
            <div class="rc-icon">${icon('lock')}</div>
            <p>If you forget your password, a <b>recovery code</b> lets you set a new one yourself, without a trip admin, and without losing your expenses or anything else.</p>
          </div>
          <p class="help">You’ll get a code like <span class="num">K7QF-2MXD-9PRA-W4ZT</span>. Save it in your password manager or notes.</p>`,
        foot: '<button class="btn" data-later>Remind me later</button><button class="btn primary" data-now>Set it up</button>',
      });
      s.el.querySelector('[data-now]').onclick = () => { s.close(); openRecoverySetup(); };
    }
    s.el.querySelector('[data-later]').onclick = later;
  };
  setTimeout(show, 2500);
}

// ---------- signed out: "Forgot password?" ----------
export function forgotScreen(el, { tripName, name = '', back }) {
  el.innerHTML = `
    <form class="auth-card" novalidate>
      <div class="auth-mark">${LOGO}<div><h1>Forgot your password?</h1><p>${esc(tripName || 'Tabi')}</p></div></div>
      <p class="muted" style="margin-top:0">Enter your name and the recovery code you saved, then choose a new password. Your account, expenses and everything else stay as they are.</p>
      <label class="field"><span>Your name</span><input class="input" name="name" value="${esc(name)}" autocomplete="username" required></label>
      <label class="field"><span>Recovery code</span><input class="input num" name="code" placeholder="XXXX-XXXX-XXXX-XXXX" autocomplete="one-time-code" autocapitalize="characters" spellcheck="false" required></label>
      <label class="field"><span>New password</span><input class="input" type="password" name="password" autocomplete="new-password" minlength="6" required></label>
      <button class="btn primary">Set new password</button>
      <p class="err" data-err hidden></p>
      <div class="auth-alt">
        <p><b>No recovery code?</b> A trip admin can send you a link to set a new password.</p>
        <button type="button" class="btn" data-help>Ask a trip admin</button>
        <p class="ok-msg" data-help-msg hidden></p>
      </div>
      <button type="button" class="linklike" data-back>Back to sign in</button>
    </form>`;
  const form = el.querySelector('form');
  const err = el.querySelector('[data-err]');
  el.querySelector('[data-back]').onclick = back;
  el.querySelector('[data-help]').onclick = async (e) => {
    const nm = form.name.value.trim();
    if (!nm) { err.hidden = false; err.textContent = 'Enter your name first, exactly as you signed up.'; form.name.focus(); return; }
    e.target.disabled = true;
    try {
      await api('/api/recover/help', { method: 'POST', body: { name: nm } });
      const m = el.querySelector('[data-help-msg]');
      m.hidden = false;
      m.textContent = `Done. If ${nm} is on the trip, the admins got a notification. They’ll send you a link to set a new password; it works once, for 24 hours.`;
      err.hidden = true;
    } catch (ex) { err.hidden = false; err.textContent = ex.message; e.target.disabled = false; }
  };
  form.onsubmit = async (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(form));
    const btn = form.querySelector('.btn.primary');
    btn.disabled = true;
    try {
      const r = await api('/api/recover', { method: 'POST', body: data });
      newCodeScreen(el, { name: data.name, code: r.code });
    } catch (ex) { err.hidden = false; err.textContent = ex.message; btn.disabled = false; }
  };
  // Only if you haven't already started typing somewhere (focus jumping mid-word put text in the wrong box)
  setTimeout(() => { if (!form.contains(document.activeElement)) (name ? form.code : form.name).focus(); }, 50);
}

// After recovering with a code: the old one is used up, so show the new one before going in.
function newCodeScreen(el, { name, code }) {
  el.innerHTML = `
    <div class="auth-card">
      <div class="auth-mark">${LOGO}<div><h1>You’re back in</h1><p>Your new password is set</p></div></div>
      <p class="muted" style="margin-top:0">Your old recovery code is used up. Here’s a new one; save it the same way.</p>
      ${codeBlock(code, name)}
      <button class="btn primary" data-go disabled>Continue to Tabi</button>
    </div>`;
  const go = el.querySelector('[data-go]');
  bindCodeBlock(el, code, name, (ok) => { go.disabled = !ok; });
  go.onclick = async () => {
    go.disabled = true;
    // They ticked "I've saved it": hide the code. (If this fails it simply stays viewable in Settings.)
    await api('/api/recovery/ack', { method: 'POST' }).catch(() => {});
    location.replace('/');
  };
}

// ---------- a reset link from an admin ----------
export async function resetScreen(el, token) {
  let info;
  try { info = await api(`/api/reset?token=${encodeURIComponent(token)}`); }
  catch (ex) {
    el.innerHTML = `<div class="auth-card"><div class="auth-mark">${LOGO}<div><h1>Reset link</h1><p>Tabi</p></div></div>
      <p class="muted">${esc(ex.message)}</p><a class="btn primary" href="/">Go to sign in</a></div>`;
    return;
  }
  el.innerHTML = `
    <form class="auth-card" novalidate>
      <div class="auth-mark">${LOGO}<div><h1>Set a new password</h1><p>for ${esc(info.name)}</p></div></div>
      <p class="muted" style="margin-top:0">A trip admin sent you this link. It works once. Your account, expenses and everything else stay as they are, and you’ll be signed out on your other devices.</p>
      <input type="text" name="username" value="${esc(info.name)}" autocomplete="username" hidden>
      <label class="field"><span>New password</span><input class="input" type="password" name="password" autocomplete="new-password" minlength="6" required></label>
      <label class="field"><span>Type it again</span><input class="input" type="password" name="again" autocomplete="new-password" minlength="6" required></label>
      <button class="btn primary">Set password and sign in</button>
      <p class="err" data-err hidden></p>
    </form>`;
  const form = el.querySelector('form');
  form.onsubmit = async (e) => {
    e.preventDefault();
    const err = el.querySelector('[data-err]');
    if (form.password.value !== form.again.value) { err.hidden = false; err.textContent = 'The two passwords don’t match.'; return; }
    const btn = form.querySelector('.btn.primary');
    btn.disabled = true;
    try {
      await api('/api/reset', { method: 'POST', body: { token, password: form.password.value } });
      location.replace('/'); // signed in; the app then asks them to set up a recovery code
    } catch (ex) { err.hidden = false; err.textContent = ex.message; btn.disabled = false; }
  };
  setTimeout(() => { if (!form.contains(document.activeElement)) form.password.focus(); }, 50);
}

// ---------- admins: make a reset link for someone ----------
export async function openResetLink(u) {
  const r = await op('user.resetLink', { id: u.id });
  if (r.ok === false) return toast(r.error);
  const url = `${location.origin}/?${r.gate ? `gate=${r.gate}&` : ''}reset=${r.token}`;
  const until = new Date(r.expiresAt).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
  const s = openSheet({
    title: `Reset link for ${u.name}`,
    sub: `Works once, until ${until}.`,
    body: `
      <p class="hint" style="margin-top:0">Send it to ${esc(u.name)} privately (a direct message, not the group chat). Opening it lets them choose a new password and signs them out everywhere else. Their expenses and everything else stay.</p>
      <div class="copy-field num" data-url>${esc(url)}</div>
      <p class="help">Making another link cancels this one.</p>`,
    foot: `${navigator.share ? '<button class="btn" data-share>Share…</button>' : ''}<button class="btn primary" data-copy>Copy link</button>`,
  });
  s.el.querySelector('[data-copy]').onclick = async () => {
    try { await navigator.clipboard.writeText(url); toast('Reset link copied'); } catch { /* select it instead */ }
  };
  s.el.querySelector('[data-share]')?.addEventListener('click', () => navigator.share({ title: `Tabi reset link for ${u.name}`, url }).catch(() => {}));
}

