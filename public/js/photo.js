// Profile photo: pick an image, move/zoom/rotate it inside a square, and save it at 240, 320 or 640 px.
// Everything happens in the browser; only the finished square image is uploaded.
import { state, api } from './store.js';
import { openSheet, icon, avatar, toast } from './ui.js';

const SIZES = [[240, 'Small'], [320, 'Standard'], [640, 'Sharp']];
const MAX_SOURCE = 1600; // big phone photos are scaled down first so dragging stays smooth
const MAX_ZOOM = 5;

export function openPhotoEditor() {
  const me = state.me;
  const s = openSheet({
    title: 'Profile photo',
    sub: 'Friends see it on the map and next to everything you do.',
    className: 'photo-sheet',
    body: `
      <div data-pick class="photo-pick">
        <div class="photo-current">${avatar(me, 'huge')}</div>
        <input type="file" accept="image/*" data-file hidden>
        <button class="btn primary" data-choose>${icon('camera')}${me.avatar ? 'Choose a new photo' : 'Choose a photo'}</button>
        ${me.avatar ? `<button class="btn danger" data-remove>${icon('trash')}Remove photo</button>` : ''}
        <p class="hint">Take one or pick from your library. You can move and zoom it next.</p>
      </div>
      <div data-crop hidden>
        <div class="crop-stage" data-stage tabindex="0" aria-label="Photo crop area. Drag to move, pinch or use plus and minus to zoom.">
          <canvas data-view></canvas><div class="crop-ring" aria-hidden="true"></div>
        </div>
        <div class="crop-tools">
          <button class="icon-btn" data-zoom-out aria-label="Zoom out"><span aria-hidden="true">−</span></button>
          <input type="range" min="1" max="${MAX_ZOOM}" step="0.01" value="1" data-zoom aria-label="Zoom">
          <button class="icon-btn" data-zoom-in aria-label="Zoom in">${icon('plus')}</button>
          <button class="icon-btn" data-rotate aria-label="Rotate 90 degrees">${icon('restore')}</button>
        </div>
        <div class="crop-preview" aria-hidden="true">
          <canvas data-prev="64"></canvas><canvas data-prev="40"></canvas><canvas data-prev="28"></canvas>
          <span class="help">How it looks in Tabi</span>
        </div>
        <div class="label" style="margin:14px 0 8px">Size</div>
        <div class="seg" role="group" aria-label="Photo size">${SIZES.map(([px, l]) => `<button data-size="${px}" aria-pressed="${px === 320}">${l} <span class="num faint">${px}×${px}</span></button>`).join('')}</div>
        <p class="help num" data-bytes style="margin:8px 2px 0">&nbsp;</p>
        <p class="err" data-err hidden></p>
      </div>`,
    foot: `<button class="btn" data-close>Cancel</button><button class="btn primary" data-save disabled>Save photo</button>`,
  });
  const $ = (q) => s.el.querySelector(q);
  const fileInput = $('[data-file]');
  $('[data-choose]').onclick = () => fileInput.click();
  $('[data-remove]')?.addEventListener('click', async (e) => {
    const b = e.currentTarget;
    if (!b.dataset.armed) { b.dataset.armed = 1; b.lastChild.textContent = 'Tap again to remove'; return; }
    try { await api('/api/avatar', { method: 'DELETE' }); toast('Profile photo removed'); s.close(); }
    catch (err) { toast(err.message); }
  });
  fileInput.onchange = () => { const f = fileInput.files?.[0]; if (f) startCrop(s, f); };
  return s;
}

async function loadSource(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode(); // browsers apply the photo's EXIF rotation when drawing an <img>
    const w = img.naturalWidth, h = img.naturalHeight;
    if (!w || !h) throw new Error('empty');
    const k = Math.min(1, MAX_SOURCE / Math.max(w, h));
    const c = document.createElement('canvas');
    c.width = Math.round(w * k); c.height = Math.round(h * k);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return c;
  } finally { URL.revokeObjectURL(url); }
}

async function startCrop(s, file) {
  const $ = (q) => s.el.querySelector(q);
  let src;
  try { src = await loadSource(file); }
  catch { toast('That file couldn’t be opened as a photo. Try a JPEG or PNG.'); return; }
  $('[data-pick]').hidden = true;
  $('[data-crop]').hidden = false;

  const stage = $('[data-stage]');
  const view = $('[data-view]');
  const zoomEl = $('[data-zoom]');
  const save = $('[data-save]');
  let size = 320;
  // t: rotation (quarter turns), z: zoom (1 = photo just covers the square), ox/oy: photo centre offset in CSS px
  const t = { r: 0, z: 1, ox: 0, oy: 0 };
  const V = () => stage.clientWidth || 280;
  const dims = () => (t.r % 2 ? [src.height, src.width] : [src.width, src.height]);
  const scale = () => { const [w, h] = dims(); return (V() / Math.min(w, h)) * t.z; };
  function clamp() {
    const [w, h] = dims(), sc = scale(), v = V();
    const mx = Math.max(0, (w * sc - v) / 2), my = Math.max(0, (h * sc - v) / 2);
    t.ox = Math.max(-mx, Math.min(mx, t.ox));
    t.oy = Math.max(-my, Math.min(my, t.oy));
  }
  function draw(canvas, px) {
    const ctx = canvas.getContext('2d');
    const k = px / V();
    canvas.width = px; canvas.height = px;
    ctx.imageSmoothingQuality = 'high';
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, px, px);
    ctx.translate(px / 2 + t.ox * k, px / 2 + t.oy * k);
    ctx.rotate((t.r * Math.PI) / 2);
    ctx.scale(scale() * k, scale() * k);
    ctx.drawImage(src, -src.width / 2, -src.height / 2);
  }
  let frame = 0;
  function paint() {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      clamp();
      draw(view, Math.round(V() * (devicePixelRatio || 1)));
      s.el.querySelectorAll('[data-prev]').forEach((c) => draw(c, +c.dataset.prev * 2));
      zoomEl.value = t.z;
      measure();
    });
  }
  // Show what the saved file will weigh, so it's clear the photo stays small.
  let measureTimer;
  function measure() {
    clearTimeout(measureTimer);
    measureTimer = setTimeout(async () => {
      const b = await encode();
      if (b) $('[data-bytes]').textContent = `${size}×${size} pixels, about ${Math.max(1, Math.round(b.size / 1024))} KB`;
    }, 250);
  }
  async function encode() {
    const out = document.createElement('canvas');
    draw(out, size);
    const as = (type, q) => new Promise((r) => out.toBlob(r, type, q));
    const webp = await as('image/webp', 0.86);
    if (webp && webp.type === 'image/webp') return webp;
    return as('image/jpeg', 0.88); // Safari before 17 can't make WebP
  }

  // Zoom around a point (CSS px from the stage centre) so what's under your fingers stays put.
  function zoomTo(z, cx = 0, cy = 0) {
    const before = scale();
    t.z = Math.max(1, Math.min(MAX_ZOOM, z));
    const f = scale() / before;
    t.ox = cx + (t.ox - cx) * f;
    t.oy = cy + (t.oy - cy) * f;
    paint();
  }

  // Dragging and pinching
  const pts = new Map();
  let last = null; // { x, y, d }
  const centre = () => { const r = stage.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; };
  const gesture = () => {
    const p = [...pts.values()];
    if (p.length === 1) return { x: p[0].x, y: p[0].y, d: 0 };
    return { x: (p[0].x + p[1].x) / 2, y: (p[0].y + p[1].y) / 2, d: Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y) };
  };
  stage.addEventListener('pointerdown', (e) => { stage.setPointerCapture(e.pointerId); pts.set(e.pointerId, { x: e.clientX, y: e.clientY }); last = gesture(); });
  stage.addEventListener('pointermove', (e) => {
    if (!pts.has(e.pointerId)) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const g = gesture();
    if (last && pts.size === (last.d ? 2 : 1)) {
      t.ox += g.x - last.x; t.oy += g.y - last.y;
      if (g.d && last.d) { const [cx, cy] = centre(); zoomTo(t.z * (g.d / last.d), g.x - cx, g.y - cy); } else paint();
    }
    last = g;
  });
  const up = (e) => { pts.delete(e.pointerId); last = pts.size ? gesture() : null; };
  stage.addEventListener('pointerup', up);
  stage.addEventListener('pointercancel', up);
  stage.addEventListener('wheel', (e) => {
    e.preventDefault();
    const [cx, cy] = centre();
    zoomTo(t.z * Math.exp(-e.deltaY / 400), e.clientX - cx, e.clientY - cy);
  }, { passive: false });
  stage.addEventListener('keydown', (e) => {
    const step = e.shiftKey ? 30 : 8;
    const k = { ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] }[e.key];
    if (k) { t.ox += k[0]; t.oy += k[1]; paint(); e.preventDefault(); }
    if (e.key === '+' || e.key === '=') { zoomTo(t.z * 1.15); e.preventDefault(); }
    if (e.key === '-') { zoomTo(t.z / 1.15); e.preventDefault(); }
  });
  zoomEl.oninput = () => zoomTo(+zoomEl.value);
  $('[data-zoom-in]').onclick = () => zoomTo(t.z * 1.25);
  $('[data-zoom-out]').onclick = () => zoomTo(t.z / 1.25);
  $('[data-rotate]').onclick = () => { t.r = (t.r + 1) % 4; t.ox = 0; t.oy = 0; paint(); };
  s.el.querySelectorAll('[data-size]').forEach((b) => b.onclick = () => {
    size = +b.dataset.size;
    s.el.querySelectorAll('[data-size]').forEach((x) => x.setAttribute('aria-pressed', x === b));
    measure();
  });
  new ResizeObserver(paint).observe(stage);

  save.disabled = false;
  save.onclick = async () => {
    save.disabled = true;
    const err = $('[data-err]');
    err.hidden = true;
    try {
      const blob = await encode();
      if (!blob) throw new Error('Your browser couldn’t make the image.');
      await api('/api/avatar', { method: 'POST', body: blob, headers: { 'Content-Type': blob.type } });
      toast('Profile photo saved');
      s.close();
    } catch (e) {
      err.hidden = false;
      err.textContent = e.message;
      save.disabled = false;
    }
  };
  stage.focus({ preventScroll: true });
  paint();
}
