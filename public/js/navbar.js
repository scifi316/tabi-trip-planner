// 1.9: the navigation bar is permanent, like Google Maps'. It can no longer be hidden, and stays put on every screen
// except an open chat conversation on a phone, which hides it like messaging apps do (app.css, .chat-convo). The
// other time it steps aside is while you type on a phone: the on-screen keyboard already takes half the screen, and
// a bar sitting on top of it would only push the text box out of sight.
//
// That's done with a class on <html> rather than on #app, because the bottom sheets (#sheet-root) sit outside #app
// and dock above the bar, so they need to know too. app.css does the rest with --tab-h.

// Fields that bring up the on-screen keyboard. Checkboxes, buttons, sliders, pickers and the like don't.
const TEXT_TYPES = new Set(['', 'text', 'search', 'email', 'url', 'tel', 'password', 'number']);
export function isTextField(el) {
  if (!el || el.nodeType !== 1) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  if (tag === 'TEXTAREA') return !el.readOnly && !el.disabled;
  if (tag !== 'INPUT') return false;
  return TEXT_TYPES.has((el.getAttribute('type') || '').toLowerCase()) && !el.readOnly && !el.disabled;
}

// Only touch screens get an on-screen keyboard. On a computer the bar (there a rail) never moves.
export function initNavbar(win = window) {
  const doc = win.document, root = doc.documentElement;
  const touch = () => !!win.matchMedia?.('(pointer: coarse)').matches;
  let timer = null;
  const set = (on) => {
    clearTimeout(timer);
    if (on === root.classList.contains('kb-open')) return;
    root.classList.toggle('kb-open', on);
    win.dispatchEvent?.(new win.Event('navbar'));
  };
  doc.addEventListener('focusin', (e) => { if (touch() && isTextField(e.target)) set(true); });
  // Moving from one text box straight to the next fires focusout then focusin: wait a moment so the bar
  // doesn't flash back in between.
  doc.addEventListener('focusout', () => {
    clearTimeout(timer);
    timer = win.setTimeout(() => { if (!isTextField(doc.activeElement) || !touch()) set(false); }, 120);
  });
  // Android's back gesture or "hide keyboard" closes the keyboard without moving focus, and tapping the same box
  // opens it again without a new focusin. With resizes-content (index.html) the page shrinks while the keyboard is
  // up, so follow the page height while a text box has focus. iOS doesn't resize the page, so there focus decides.
  let full = win.innerHeight, lastW = win.innerWidth;
  const android = /Android/i.test(win.navigator?.userAgent || '');
  win.addEventListener('resize', () => {
    const h = win.innerHeight, w = win.innerWidth;
    // Turned the phone: start again from this height and decide nothing yet, since the keyboard may be up
    if (Math.abs(w - lastW) > 80) { full = h; lastW = w; return; }
    if (h > full) full = h;
    if (!android || !touch() || !isTextField(doc.activeElement)) return;
    if (h < full - 150) set(true);
    else if (h >= full - 80) set(false);
  });
  return { set };
}
