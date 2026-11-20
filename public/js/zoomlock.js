// TA-15: on a phone Tabi should feel like an app, not a web page, so the page itself never zooms.
// Pinching and double-tapping inside the map, the full-screen photo viewer (photozoom.js) and the
// profile photo crop keep working: they handle their own touches rather than zooming the page.
//
// Each phone browser listens to a different switch, so there are three:
//  - the viewport tag in index.html (maximum-scale=1, user-scalable=no). Chrome honours it, and the
//    Android app is Chrome underneath (a Trusted Web Activity), so this is the Android fix. It also
//    stops iOS zooming in when a text box is tapped.
//  - touch-action: pan-x pan-y on the page (app.css): scrolling only, no pinch or double-tap zoom.
//  - Safari's own pinch events, cancelled here. iOS ignores user-scalable=no on purpose, so this is
//    what stops the page pinching on an iPhone.

const GESTURES = ['gesturestart', 'gesturechange', 'gestureend'];

// Only on touch-first devices: on a Mac, pinching the trackpad in Safari stays the browser's business.
export function lockZoom(win = globalThis) {
  if (!win.matchMedia?.('(pointer: coarse)').matches) return false;
  const stop = (e) => e.preventDefault();
  for (const type of GESTURES) win.document.addEventListener(type, stop, { passive: false });
  return true;
}

// Strips the zoom limits from a viewport tag's content, keeping everything else as it was.
export function unlockedViewport(content) {
  return content.split(',').map((s) => s.trim()).filter((s) => s && !/^(maximum-scale|user-scalable)\s*=/i.test(s)).join(', ');
}

// TA-13: turning an iPhone can leave a home-screen app zoomed in, which shifts the fixed layout so taps
// land in the wrong place. If the page has been left zoomed, lift the limits for a moment and put them
// back: WebKit applies maximum-scale=1 as it comes back, which returns the page to 100%.
export function resetZoom(win = globalThis) {
  const vv = win.visualViewport, meta = win.document.querySelector('meta[name=viewport]');
  if (!vv || !meta || Math.abs(vv.scale - 1) <= 0.01) return false;
  const was = meta.content;
  meta.content = unlockedViewport(was);
  win.setTimeout(() => { meta.content = was; }, 100);
  return true;
}
