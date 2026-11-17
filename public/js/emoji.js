// Custom emojis: anyone can add one (a name like :ramen: and a small square picture), and use it in
// reactions. Pictures are cropped and shrunk to 128×128 in the browser, with transparency kept.
import { state, on, api, emit } from './store.js';
import { esc, icon, openSheet, toast } from './ui.js';

const PX = 128, MAX_BYTES = 64 * 1024, MAX_SOURCE = 1024;
const byName = () => new Map((state.customEmojis || []).map((e) => [e.name, e]));
export const isCustom = (s) => /^:[a-z0-9_]{2,24}:$/.test(s || '');

// An emoji as HTML: standard ones as text, custom ones as a picture (or :name: if it was removed).
export function emojiHtml(s, cls = '') {
  if (!isCustom(s)) return esc(s);
  const e = byName().get(s.slice(1, -1));
  return e ? `<img class="cemoji ${cls}" src="${esc(e.url)}" alt="${esc(s)}" title="${esc(s)}" draggable="false">` : `<span class="cemoji-gone">${esc(s)}</span>`;
}
// Text that may contain :name: (notifications): escape it, then swap in the pictures.
export function withEmojis(text) {
  const m = byName();
  return esc(text).replace(/:([a-z0-9_]{2,24}):/g, (all, n) => (m.has(n) ? `<img class="cemoji inline" src="${esc(m.get(n).url)}" alt=":${n}:" title=":${n}:">` : all));
}

// ---------- picker: tap one to use it ----------
export function openEmojiPicker({ title = 'Custom emojis', onPick } = {}) {
  let managing = false;
  const s = openSheet({ title, sub: onPick ? 'Made by people on the trip. Tap one to send it.' : 'Made by people on the trip. Send them from anyone’s card on the map.', className: 'emoji-sheet', body: '<div data-grid></div>' });
  const render = () => {
    const list = state.customEmojis || [];
    const me = state.me;
    s.body.innerHTML = `
      <div class="emoji-grid">
        ${list.map((e) => (managing
          ? `<div class="emoji-cell"><img src="${esc(e.url)}" alt=""><span>:${esc(e.name)}:</span>
              ${e.by === me?.id || me?.isAdmin ? `<button class="emoji-del" data-del="${esc(e.name)}" aria-label="Remove :${esc(e.name)}:">${icon('x', 'small')}</button>` : ''}</div>`
          : `<button class="emoji-cell" data-pick="${esc(e.name)}" aria-label="Send :${esc(e.name)}:"><img src="${esc(e.url)}" alt=""><span>:${esc(e.name)}:</span></button>`)).join('')}
        ${managing ? '' : `<button class="emoji-cell add" data-add>${icon('plus')}<span>Add one</span></button>`}
      </div>
      ${list.length ? '' : '<p class="hint">Nobody has added one yet. Add a photo of your group, a mascot, your favourite ramen…</p>'}
      ${list.some((e) => e.by === me?.id || me?.isAdmin) ? `<button class="btn small ghost" data-manage>${managing ? 'Done' : 'Remove emojis…'}</button>` : ''}
      <p class="help emoji-limits">Square pictures, shown at up to 128×128 pixels. ${list.length} of 100 used.</p>`;
    s.body.querySelectorAll('[data-pick]').forEach((b) => b.onclick = () => { if (!onPick) return; s.close(); onPick(`:${b.dataset.pick}:`); });
    s.body.querySelectorAll('[data-del]').forEach((b) => b.onclick = async () => {
      try { await api(`/api/emoji/${b.dataset.del}`, { method: 'DELETE' }); toast(`Removed :${b.dataset.del}:`); } catch (e) { toast(e.message); }
    });
    s.body.querySelector('[data-add]')?.addEventListener('click', () => openEmojiEditor({ onSaved: (name) => { if (!s.closed && onPick && !managing) { s.close(); onPick(`:${name}:`); } } }));
    s.body.querySelector('[data-manage]')?.addEventListener('click', () => { managing = !managing; render(); });
  };
  render();
  const off = on('emojis', () => (s.closed ? off() : render()));
  return s;
}

// ---------- editor: pick a picture, frame it, name it ----------
export function openEmojiEditor({ onSaved } = {}) {
  const s = openSheet({
    title: 'Add a custom emoji', className: 'emoji-editor',
    body: `
      <div data-pick-step>
        <label class="drop" style="display:grid;place-items:center;gap:6px;padding:28px 12px;cursor:pointer">
          ${icon('camera')}<b>Choose a picture</b><span class="help">PNG with a see-through background works best. Animated GIFs become still.</span>
          <input type="file" accept="image/png,image/webp,image/jpeg,image/gif" data-file hidden></label>
      </div>
      <div data-edit-step hidden>
        <div class="emoji-stage" data-stage tabindex="0" aria-label="Drag to move, pinch or scroll to zoom"><canvas data-view></canvas></div>
        <div class="emoji-zoom"><button class="icon-btn small" data-zoom-out aria-label="Zoom out">−</button>
          <input type="range" min="0.4" max="4" step="0.01" value="1" data-zoom aria-label="Zoom">
          <button class="icon-btn small" data-zoom-in aria-label="Zoom in">+</button></div>
        <div class="emoji-previews" aria-hidden="true">
          <div><canvas data-prev="48"></canvas><span>Reactions</span></div>
          <div><canvas data-prev="22"></canvas><span>In text</span></div>
          <div class="dark"><canvas data-prev="48"></canvas><span>Dark mode</span></div>
        </div>
        <label class="field"><span>Name</span><div class="emoji-name"><span>:</span><input class="input" data-name maxlength="24" placeholder="ramen" autocomplete="off" autocapitalize="none" spellcheck="false"><span>:</span></div></label>
        <p class="help" data-bytes></p>
        <p class="err" data-err hidden></p>
      </div>`,
    foot: '<button class="btn" data-cancel>Cancel</button><button class="btn primary" data-save disabled>Add emoji</button>',
  });
  const $ = (q) => s.el.querySelector(q);
  $('[data-cancel]').onclick = () => s.close();
  let src = null;
  const t = { z: 1, ox: 0, oy: 0 };
  const V = () => $('[data-stage]').clientWidth || 220;
  // z = 1: the whole picture fits; bigger zooms in. The square stays see-through outside the picture.
  const scale = () => (V() / Math.max(src.width, src.height)) * t.z;
  function draw(canvas, px, bg) {
    const ctx = canvas.getContext('2d');
    canvas.width = px; canvas.height = px;
    ctx.clearRect(0, 0, px, px);
    if (bg) { ctx.fillStyle = bg; ctx.fillRect(0, 0, px, px); }
    const k = px / V();
    ctx.imageSmoothingQuality = 'high';
    ctx.translate(px / 2 + t.ox * k, px / 2 + t.oy * k);
    ctx.scale(scale() * k, scale() * k);
    ctx.drawImage(src, -src.width / 2, -src.height / 2);
  }
  let frame = 0;
  const paint = () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      draw($('[data-view]'), Math.round(V() * (devicePixelRatio || 1)));
      s.el.querySelectorAll('[data-prev]').forEach((c) => { draw(c, +c.dataset.prev * 2); c.style.width = c.style.height = `${c.dataset.prev}px`; });
      $('[data-zoom]').value = t.z;
      measure();
    });
  };
  let mt;
  const measure = () => { clearTimeout(mt); mt = setTimeout(async () => { const b = await encode(); if (b) $('[data-bytes]').textContent = `${PX}×${PX} pixels, ${Math.max(1, Math.round(b.size / 1024))} KB`; }, 200); };
  async function encode() {
    const out = document.createElement('canvas');
    draw(out, PX);
    const as = (type, q) => new Promise((r) => out.toBlob(r, type, q));
    for (const q of [0.92, 0.8, 0.65]) {
      const b = await as('image/webp', q);
      if (b && b.type === 'image/webp' && b.size <= MAX_BYTES) return b;
      if (!b || b.type !== 'image/webp') break; // this browser can't make WebP
    }
    const png = await as('image/png');
    return png && png.size <= MAX_BYTES ? png : null;
  }
  const zoomTo = (z) => { t.z = Math.max(0.4, Math.min(4, z)); paint(); };
  $('[data-file]').onchange = async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    const u = URL.createObjectURL(f);
    try {
      const img = new Image(); img.src = u; await img.decode();
      const k = Math.min(1, MAX_SOURCE / Math.max(img.naturalWidth, img.naturalHeight));
      src = document.createElement('canvas');
      src.width = Math.max(1, Math.round(img.naturalWidth * k)); src.height = Math.max(1, Math.round(img.naturalHeight * k));
      src.getContext('2d').drawImage(img, 0, 0, src.width, src.height);
    } catch { toast('That file couldn’t be opened as a picture.'); return; } finally { URL.revokeObjectURL(u); }
    $('[data-pick-step]').hidden = true; $('[data-edit-step]').hidden = false;
    const base = (f.name || '').replace(/\.[^.]+$/, '').toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 24);
    if (base.length >= 2 && !/^(img|image|photo|screenshot|dsc|pxl)_?\d*/.test(base)) $('[data-name]').value = base;
    validate();
    new ResizeObserver(paint).observe($('[data-stage]'));
    paint();
  };
  // drag to move, pinch / wheel to zoom
  const stage = $('[data-stage]');
  const pts = new Map(); let last = null;
  const g = () => { const p = [...pts.values()]; return p.length > 1 ? { x: (p[0].x + p[1].x) / 2, y: (p[0].y + p[1].y) / 2, d: Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y) } : { ...p[0], d: 0 }; };
  stage.addEventListener('pointerdown', (e) => { stage.setPointerCapture(e.pointerId); pts.set(e.pointerId, { x: e.clientX, y: e.clientY }); last = g(); });
  stage.addEventListener('pointermove', (e) => {
    if (!pts.has(e.pointerId) || !src) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const n = g();
    if (last) { t.ox += n.x - last.x; t.oy += n.y - last.y; if (n.d && last.d) t.z = Math.max(0.4, Math.min(4, t.z * (n.d / last.d))); paint(); }
    last = n;
  });
  const up = (e) => { pts.delete(e.pointerId); last = pts.size ? g() : null; };
  stage.addEventListener('pointerup', up); stage.addEventListener('pointercancel', up);
  stage.addEventListener('wheel', (e) => { if (!src) return; e.preventDefault(); zoomTo(t.z * Math.exp(-e.deltaY / 400)); }, { passive: false });
  $('[data-zoom]').oninput = (e) => zoomTo(+e.target.value);
  $('[data-zoom-in]').onclick = () => zoomTo(t.z * 1.2);
  $('[data-zoom-out]').onclick = () => zoomTo(t.z / 1.2);

  const nameOk = (n) => /^[a-z0-9_]{2,24}$/.test(n);
  function validate() {
    const el = $('[data-name]');
    el.value = el.value.toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/^:+|:+$/g, '');
    const n = el.value;
    const taken = (state.customEmojis || []).some((e) => e.name === n);
    const err = $('[data-err]');
    err.hidden = !(n && (taken || (n.length >= 2 && !nameOk(n))));
    err.textContent = taken ? `There’s already a :${n}:.` : 'Use 2 to 24 letters, numbers or _.';
    $('[data-save]').disabled = !src || !nameOk(n) || taken;
  }
  $('[data-name]').oninput = validate;
  $('[data-save]').onclick = async () => {
    const btn = $('[data-save]'); btn.disabled = true;
    const name = $('[data-name]').value;
    try {
      const blob = await encode();
      if (!blob) throw new Error('Couldn’t make it small enough. Zoom in a little, or use a simpler picture.');
      await api(`/api/emoji?name=${encodeURIComponent(name)}`, { method: 'POST', body: blob, headers: { 'Content-Type': blob.type } });
      toast(`Added :${name}:`);
      s.close();
      onSaved?.(name);
    } catch (e) { const err = $('[data-err]'); err.hidden = false; err.textContent = e.message; btn.disabled = false; }
  };
  return s;
}

on('emojis', () => emit('reaction-refresh'));
