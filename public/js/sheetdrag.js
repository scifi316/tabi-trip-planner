// TA-18: pull a bottom sheet (a place card, a friend card, any panel) down to put it away.
//
// Two things went wrong before:
//  - Only the thin strip with the little bar on it could be grabbed (22px), so a finger often missed it.
//    Now the whole header grabs too, apart from its buttons, links and fields. A mouse still only
//    grabs the strip, so on a computer the title can still be selected and copied.
//  - The drag followed the finger with pointer events captured to that strip. On an iPhone, Safari
//    doesn't reliably keep sending captured pointer events once the finger slides off the element,
//    so a drag could stop halfway without ever seeing the finger lift. The unfinished drag then held
//    on to the next tap, which is why the X needed pressing twice. Touches are now followed with
//    touch events, which Safari always sends to where the touch began, nothing is captured, a
//    cancelled touch puts the sheet back, and any new press ends a drag that didn't finish.

export const DRAG_START_PX = 6;   // a press on the header has to move this far before it counts as a drag
export const CLOSE_PX = 80;       // pulled this far down and let go: close
export const FLICK_PX = 24;       // or a quick flick down of at least this far ...
export const FLICK_SPEED = 0.5;   // ... moving at this many px per ms when the finger lifts

// Things inside the header that keep their own taps.
const OWN_TAPS = 'button, a, input, select, textarea, label, summary, [contenteditable], [data-no-drag]';

// Does a press on `target` start pulling the sheet? `touch` is true for a finger or pen.
export function startsDrag(target, touch) {
  if (!target?.closest) return false;
  if (target.closest('.sheet-grab')) return true;
  if (!touch) return false;
  return !!target.closest('.sheet-head') && !target.closest(OWN_TAPS);
}

// How far the sheet sits below its resting place while being pulled: never above it.
export const offsetFor = (dy) => Math.max(0, Math.round(dy));

// Let go at `dy` px below where the press started, moving down at `speed` px per ms.
export function shouldClose(dy, speed = 0) {
  if (dy >= CLOSE_PX) return true;
  return dy >= FLICK_PX && speed >= FLICK_SPEED;
}

// Speed over the last ~100ms of movement, from samples of { y, t }.
export function speedOf(samples) {
  if (samples.length < 2) return 0;
  const last = samples[samples.length - 1];
  let first = samples[0];
  for (const s of samples) if (last.t - s.t <= 100) { first = s; break; }
  const ms = last.t - first.t;
  return ms > 0 ? (last.y - first.y) / ms : 0;
}

// Wires a sheet so it can be pulled down. `onDismiss` runs when it's let go far or fast enough.
// Returns { cancel(), dragging() }: cancel() puts a half-pulled sheet back.
export function attachSheetDrag(el, { onDismiss, win = globalThis, now = () => win.performance?.now?.() ?? Date.now() } = {}) {
  let g = null; // { kind: 'touch' | 'pointer', id, startY, samples, moved }

  const move = (y) => {
    if (!g) return;
    const dy = y - g.startY;
    g.samples.push({ y, t: now() });
    if (g.samples.length > 12) g.samples.shift();
    if (!g.moved) {
      if (Math.abs(dy) < DRAG_START_PX) return;
      g.moved = true;
      el.classList.add('dragging');
    }
    el.style.transform = `translateY(${offsetFor(dy)}px)`;
  };

  const settle = () => {
    el.classList.remove('dragging');
    el.style.transform = '';
  };

  const stopListening = () => {
    win.removeEventListener('pointermove', onPointerMove);
    win.removeEventListener('pointerup', onPointerUp);
    win.removeEventListener('pointercancel', onPointerCancel);
  };

  const finish = (y, letGo) => {
    if (!g) return;
    const { moved, startY, samples } = g;
    g = null;
    stopListening();
    if (!moved) { settle(); return; }
    if (letGo && y != null) {
      samples.push({ y, t: now() });
      if (shouldClose(y - startY, speedOf(samples))) {
        el.classList.remove('dragging');
        onDismiss?.();
        return;
      }
    }
    settle();
  };

  const begin = (kind, id, y) => {
    if (g) finish(null, false); // a drag that never finished must not swallow this press
    g = { kind, id, startY: y, samples: [{ y, t: now() }], moved: false };
    if (kind === 'pointer') {
      win.addEventListener('pointermove', onPointerMove);
      win.addEventListener('pointerup', onPointerUp);
      win.addEventListener('pointercancel', onPointerCancel);
    }
  };

  // Fingers: touch events keep coming to the element the touch started on, wherever the finger goes.
  const touchOf = (e) => (g?.kind === 'touch' ? [...(e.changedTouches || [])].find((t) => t.identifier === g.id) : null);
  el.addEventListener('touchstart', (e) => {
    if (e.touches?.length > 1) { if (g) finish(null, false); return; } // two fingers: not a drag
    const t = e.changedTouches?.[0];
    if (!t || !startsDrag(e.target, true)) { if (g) finish(null, false); return; }
    begin('touch', t.identifier, t.clientY);
  }, { passive: true });
  el.addEventListener('touchmove', (e) => {
    const t = touchOf(e);
    if (!t) return;
    move(t.clientY);
    if (g?.moved && e.cancelable) e.preventDefault(); // the page mustn't scroll underneath
  }, { passive: false });
  el.addEventListener('touchend', (e) => { const t = touchOf(e); if (t) finish(t.clientY, true); });
  el.addEventListener('touchcancel', (e) => { if (touchOf(e)) finish(null, false); });

  // Mouse and pen: followed on the window, so leaving the strip doesn't lose the drag.
  function onPointerMove(e) { if (g?.kind === 'pointer' && e.pointerId === g.id) move(e.clientY); }
  function onPointerUp(e) { if (g?.kind === 'pointer' && e.pointerId === g.id) finish(e.clientY, true); }
  function onPointerCancel(e) { if (g?.kind === 'pointer' && e.pointerId === g.id) finish(null, false); }
  el.addEventListener('pointerdown', (e) => {
    // Fingers, and a pen wherever the browser also sends it as a touch (an Apple Pencil on an iPad),
    // are handled by the touch events above.
    if (e.pointerType === 'touch' || (e.pointerType === 'pen' && 'ontouchstart' in win)) return;
    if (e.button > 0) return;
    if (!startsDrag(e.target, e.pointerType === 'pen')) return;
    begin('pointer', e.pointerId, e.clientY);
  });

  return { cancel: () => finish(null, false), dragging: () => !!g?.moved };
}
