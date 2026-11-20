// Pinch, double-tap and drag to look closer at a photo in the full-screen viewer. On a phone the page
// itself never zooms (TA-15, see zoomlock.js), so the viewer zooms the picture instead.

export const MAX_ZOOM = 5;
const DOUBLE_TAP_ZOOM = 2.5;
const DOUBLE_TAP_MS = 300;
const TAP_SLOP = 10; // px a finger can wander and still count as a tap
const SWIPE = 50; // px sideways to move to the next photo

// The size a photo of nw x nh is drawn at inside a w x h stage with object-fit: contain.
// Before the photo has loaded its size is unknown, so the whole stage stands in for it.
export function fittedSize(w, h, nw, nh) {
  if (!(nw > 0 && nh > 0)) return { iw: w, ih: h };
  const f = Math.min(w / nw, h / nh);
  return { iw: nw * f, ih: nh * f };
}

// t is { z, x, y }: the zoom and how far the picture's centre has moved from the stage's centre.
// Keeps the zoom in range and the photo (iw x ih as drawn at 1x, inside a w x h stage) on screen: a side
// that's wider than the stage can be dragged until its edge meets the stage's edge, and a side that
// still fits stays centred, so the photo can never be dragged out of view.
export function clampView(t, w, h, iw = w, ih = h) {
  const z = Math.min(MAX_ZOOM, Math.max(1, t.z));
  const mx = Math.max(0, (iw * z - w) / 2), my = Math.max(0, (ih * z - h) / 2);
  const fit = (v, m) => Math.min(m, Math.max(-m, v)) || 0; // || 0 turns -0 into 0
  return { z, x: fit(t.x, mx), y: fit(t.y, my) };
}

// Zooms to z around a point (cx, cy, measured from the stage's centre) so that point stays under the fingers.
export function zoomAround(t, z, cx, cy, w, h, iw = w, ih = h) {
  const nz = Math.min(MAX_ZOOM, Math.max(1, z));
  const f = nz / t.z;
  return clampView({ z: nz, x: cx - (cx - t.x) * f, y: cy - (cy - t.y) * f }, w, h, iw, ih);
}

// Wires a viewer's stage up. onSwipe(1 | -1) moves to the next or previous photo when the picture isn't zoomed.
export function photoZoom(stage, { onSwipe } = {}) {
  let t = { z: 1, x: 0, y: 0 };
  const pts = new Map();
  let last = null; // { x, y, d } of the previous move
  let start = null; // where a one-finger touch began, while it may still be a tap or a swipe
  let pinched = false; // two fingers were down at some point in this touch
  let lastTap = null; // { at, x, y }

  const box = () => stage.getBoundingClientRect();
  // The stage's size and the photo's size as drawn in it
  const size = () => {
    const r = box(), img = stage.querySelector('.pv-img');
    const { iw, ih } = fittedSize(r.width, r.height, img?.naturalWidth, img?.naturalHeight);
    return [r.width, r.height, iw, ih];
  };
  const fromCentre = (x, y) => { const r = box(); return [x - (r.left + r.width / 2), y - (r.top + r.height / 2)]; };
  const paint = () => {
    for (const img of stage.querySelectorAll('img')) img.style.transform = t.z === 1 ? '' : `translate(${t.x}px, ${t.y}px) scale(${t.z})`;
    stage.classList.toggle('zoomed', t.z > 1);
  };
  const set = (next) => { t = next.z < 1.02 ? { z: 1, x: 0, y: 0 } : next; paint(); };
  const zoomTo = (z, px, py) => { const [cx, cy] = fromCentre(px, py); set(zoomAround(t, z, cx, cy, ...size())); };
  const read = () => {
    const p = [...pts.values()];
    if (p.length === 1) return { x: p[0].x, y: p[0].y, d: 0 };
    return { x: (p[0].x + p[1].x) / 2, y: (p[0].y + p[1].y) / 2, d: Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y) };
  };

  stage.addEventListener('pointerdown', (e) => {
    if (e.target.closest?.('button, a')) return; // the arrows keep working as buttons
    stage.setPointerCapture?.(e.pointerId);
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pts.size === 1) { start = { x: e.clientX, y: e.clientY }; pinched = false; }
    if (pts.size > 1) pinched = true;
    last = read();
  });
  stage.addEventListener('pointermove', (e) => {
    if (!pts.has(e.pointerId)) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const g = read();
    if (last && pts.size >= 2 && last.d) {
      const [cx, cy] = fromCentre(g.x, g.y);
      const moved = { ...t, x: t.x + g.x - last.x, y: t.y + g.y - last.y };
      set(zoomAround(moved, t.z * (g.d / last.d), cx, cy, ...size()));
    } else if (last && pts.size === 1 && !last.d && t.z > 1) {
      set(clampView({ ...t, x: t.x + g.x - last.x, y: t.y + g.y - last.y }, ...size()));
    }
    last = g;
  });
  const up = (e) => {
    if (!pts.has(e.pointerId)) return;
    pts.delete(e.pointerId);
    last = pts.size ? read() : null;
    if (pts.size || !start || pinched || e.type === 'pointercancel') return;
    const dx = e.clientX - start.x, dy = e.clientY - start.y;
    start = null;
    if (Math.hypot(dx, dy) < TAP_SLOP) {
      const now = e.timeStamp ?? Date.now();
      if (lastTap && now - lastTap.at < DOUBLE_TAP_MS && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < TAP_SLOP * 3) {
        lastTap = null;
        if (t.z > 1) set({ z: 1, x: 0, y: 0 }); else zoomTo(DOUBLE_TAP_ZOOM, e.clientX, e.clientY);
      } else lastTap = { at: now, x: e.clientX, y: e.clientY };
    } else if (t.z === 1 && Math.abs(dx) > SWIPE && Math.abs(dx) > Math.abs(dy)) onSwipe?.(dx < 0 ? 1 : -1);
  };
  stage.addEventListener('pointerup', up);
  stage.addEventListener('pointercancel', up);
  // A trackpad pinch arrives as a wheel with ctrl held
  stage.addEventListener('wheel', (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    zoomTo(t.z * Math.exp(-e.deltaY / 100), e.clientX, e.clientY);
  }, { passive: false });

  return { get view() { return { ...t }; }, reset: () => set({ z: 1, x: 0, y: 0 }) };
}
