// Tooltips for icon buttons on computers: shown on mouse hover (after a short pause) and on keyboard
// focus. Never for touch, where a long press already does other things.
// Each event says whether it came from a mouse, which is what we go by. (Laptops with a touchscreen
// report "no hover" for the whole page in Chrome, so a media query hid tooltips there entirely.)
// Text comes from data-tip, or the button's aria-label.
const SEL = '[data-tip], .ctl, .icon-btn[aria-label], .fab';
let tip = null, current = null, timer = 0;

function textOf(el) { return el.dataset.tip || el.getAttribute('aria-label') || ''; }

function place(el) {
  const r = el.getBoundingClientRect();
  const t = tip.getBoundingClientRect();
  const gap = 8, m = 8;
  // Map controls sit on the right edge: show to their left. Things near the top: below. Otherwise above.
  let x, y;
  if (r.right > innerWidth - 90 && r.left - t.width - gap > m) { x = r.left - t.width - gap; y = r.top + r.height / 2 - t.height / 2; }
  else if (r.top - t.height - gap < m || r.top < 90) { x = r.left + r.width / 2 - t.width / 2; y = r.bottom + gap; }
  else { x = r.left + r.width / 2 - t.width / 2; y = r.top - t.height - gap; }
  tip.style.left = `${Math.round(Math.max(m, Math.min(innerWidth - t.width - m, x)))}px`;
  tip.style.top = `${Math.round(Math.max(m, Math.min(innerHeight - t.height - m, y)))}px`;
}

function show(el) {
  const text = textOf(el);
  if (!text || !el.isConnected) return;
  if (!tip) {
    tip = document.createElement('div');
    tip.id = 'tooltip';
    tip.className = 'tooltip';
    tip.setAttribute('role', 'tooltip');
    document.body.appendChild(tip);
  }
  current = el;
  tip.textContent = text;
  tip.classList.remove('show');
  tip.style.left = '-9999px';
  place(el);
  tip.classList.add('show');
  // Screen readers already hear the aria-label; only describe when the tip adds something
  if (el.dataset.tip && el.dataset.tip !== el.getAttribute('aria-label')) el.setAttribute('aria-describedby', 'tooltip');
}
export function hideTip() {
  clearTimeout(timer);
  if (current?.getAttribute('aria-describedby') === 'tooltip') current.removeAttribute('aria-describedby');
  current = null;
  tip?.classList.remove('show');
}

document.addEventListener('pointerover', (e) => {
  if (e.pointerType !== 'mouse') return;
  const el = e.target.closest?.(SEL);
  if (!el || el === current) return;
  hideTip();
  timer = setTimeout(() => show(el), 450);
});
document.addEventListener('pointerout', (e) => {
  const el = e.target.closest?.(SEL);
  if (el && !el.contains(e.relatedTarget)) hideTip();
});
document.addEventListener('focusin', (e) => {
  const el = e.target.closest?.(SEL);
  if (el && el.matches(':focus-visible')) show(el); else hideTip();
});
document.addEventListener('focusout', hideTip);
document.addEventListener('pointerdown', hideTip, true);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideTip(); });
addEventListener('scroll', hideTip, true);
addEventListener('resize', hideTip);
