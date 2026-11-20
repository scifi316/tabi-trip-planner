// Picture a day: the group's photos, up to 5 for each day of the trip, from anyone.
// Photos are shrunk in the browser before upload (2048 px, WebP or JPEG, a few hundred KB) with a
// small thumbnail for lists, and re-drawn on a canvas so the location and camera data are gone.
import { state, on, op, emit, userById, today, tripDays } from './store.js';
import { esc, icon, avatar, ago, openSheet, toast, confirmSheet, fmtDay } from './ui.js';
import { photoZoom } from './photozoom.js';

const PER_DAY = 5;
const FULL_PX = 2048, THUMB_PX = 480;

export const photosOn = (day) => (state.photos?.list || []).filter((p) => p.day === day);
// The day's cover: the most liked, then the first added
export const coverOf = (day) => photosOn(day).slice().sort((a, b) => b.likes.length - a.likes.length || a.id - b.id)[0] || null;
export const canAddOn = (day) => !!day && day <= today() && (!state.trip.start || day >= state.trip.start) && (!state.trip.end || day <= state.trip.end);
const dayName = (d) => (d === today() ? 'Today' : fmtDay(d, { weekday: 'long', day: 'numeric', month: 'short' }));
const mb = (b) => (b >= 1073741824 ? `${+(b / 1073741824).toFixed(1)} GB` : b >= 1048576 ? `${(b / 1048576).toFixed(b >= 10485760 ? 0 : 1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);

// ---------- one day ----------
let daySheet = null;
export function openDayPhotos(day) {
  if (daySheet && !daySheet.closed) daySheet.close();
  daySheet = openSheet({ className: 'photo-day-sheet', title: dayName(day), sub: '', body: '<div data-photos></div>' });
  const s = daySheet;
  const render = () => {
    const list = photosOn(day);
    const cover = coverOf(day);
    const ordered = cover ? [cover, ...list.filter((p) => p !== cover)] : list;
    s.el.querySelector('.sheet-head .sub')?.remove();
    s.el.querySelector('.sheet-head h2').insertAdjacentHTML('afterend', `<div class="sub">Picture a day: ${list.length} of ${PER_DAY} photos</div>`);
    s.body.innerHTML = `
      ${ordered.length ? `<div class="photo-grid">${ordered.map((p, i) => tileHtml(p, i === 0)).join('')}</div>` : `
        <div class="photo-empty">${icon('camera')}<div><b>No photo for this day yet</b>
          <div class="help">${canAddOn(day) ? `Anyone can add one, up to ${PER_DAY}. The most liked one becomes the day’s cover.` : 'Photos can be added from the day itself.'}</div></div></div>`}
      ${canAddOn(day) && list.length < PER_DAY ? `<label class="btn primary block photo-add">${icon('plus')}Add a photo<input type="file" accept="image/*" data-file hidden></label>` : ''}
      ${list.length >= PER_DAY ? `<p class="help" style="text-align:center">This day has its ${PER_DAY} photos. Remove one to add another.</p>` : ''}
      <button class="btn block ghost" data-album>${icon('calendar')}All the trip’s photos</button>`;
    s.body.querySelectorAll('[data-photo]').forEach((b) => b.onclick = () => openViewer(ordered, ordered.findIndex((p) => p.id === +b.dataset.photo)));
    s.body.querySelector('[data-file]')?.addEventListener('change', (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) addPhoto(day, f); });
    s.body.querySelector('[data-album]').onclick = () => { s.close(); openAlbum(); };
  };
  render();
  const off = on('photos', () => (s.closed ? off() : render()));
  return s;
}
function tileHtml(p, cover) {
  const u = userById(p.by);
  return `<button class="photo-tile ${cover ? 'cover' : ''}" data-photo="${p.id}" aria-label="Photo by ${esc(u?.name || 'someone')}${p.caption ? `: ${esc(p.caption)}` : ''}">
    <img src="${esc(p.thumb)}" alt="" loading="lazy">
    <span class="photo-meta">${u ? avatar(u) : ''}${p.likes.length ? `<span class="photo-likes">${icon('heart', 'small')}${p.likes.length}</span>` : ''}</span>
    ${cover && photosOn(p.day).length > 1 ? '<span class="photo-cover">Cover</span>' : ''}</button>`;
}

// ---------- adding one ----------
async function decode(file) {
  try { return await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch { /* older Safari */ }
  const url = URL.createObjectURL(file);
  try { const img = new Image(); img.src = url; await img.decode(); return img; } finally { setTimeout(() => URL.revokeObjectURL(url), 1000); }
}
async function shrink(img, max, quality) {
  const w0 = img.width || img.naturalWidth, h0 = img.height || img.naturalHeight;
  const k = Math.min(1, max / Math.max(w0, h0));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w0 * k)); c.height = Math.max(1, Math.round(h0 * k));
  const ctx = c.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, c.width, c.height);
  const as = (type, q) => new Promise((r) => c.toBlob(r, type, q));
  let b = await as('image/webp', quality);
  if (!b || b.type !== 'image/webp') b = await as('image/jpeg', quality + 0.03); // Safari before 17 can't make WebP
  return { blob: b, w: c.width, h: c.height };
}
export { decode as decodeImage, shrink as shrinkImage };
export async function preparePhoto(file) {
  const img = await decode(file);
  let full = await shrink(img, FULL_PX, 0.82);
  if (full.blob.size > 2.5 * 1048576) full = await shrink(img, FULL_PX, 0.66); // very detailed photos
  const thumb = await shrink(img, THUMB_PX, 0.72);
  img.close?.();
  return { full, thumb };
}

function addPhoto(day, file) {
  const s = openSheet({
    title: `Add a photo for ${dayName(day).replace(/^Today$/, 'today')}`, className: 'photo-add-sheet',
    body: `<div class="photo-preview" data-preview><div class="spinner"></div></div>
      <label class="field"><span>Caption (optional)</span><input class="input" data-caption maxlength="140" placeholder="Where, who, what happened"></label>
      <p class="help" data-info>Getting it ready…</p>
      <div class="progress" data-progress hidden><div></div></div>
      <p class="err" data-err hidden></p>`,
    foot: '<button class="btn" data-cancel>Cancel</button><button class="btn primary" data-go disabled>Add photo</button>',
  });
  const $ = (q) => s.el.querySelector(q);
  $('[data-cancel]').onclick = () => { xhr?.abort(); s.close(); };
  let prepared = null, xhr = null;
  preparePhoto(file).then((p) => {
    prepared = p;
    const url = URL.createObjectURL(p.full.blob);
    $('[data-preview]').innerHTML = `<img src="${url}" alt="">`;
    $('[data-info]').textContent = `${p.full.w}×${p.full.h}, ${mb(p.full.blob.size)}. Location and camera details are removed.`;
    $('[data-go]').disabled = false;
  }).catch(() => {
    $('[data-preview]').innerHTML = '';
    $('[data-info]').textContent = '';
    const err = $('[data-err]'); err.hidden = false;
    err.textContent = 'This browser can’t open that photo. On a computer, HEIC photos from an iPhone need converting first; on the phone itself they work.';
  });
  $('[data-go]').onclick = () => {
    if (!prepared) return;
    $('[data-go]').disabled = true;
    const head = new Uint8Array(4);
    new DataView(head.buffer).setUint32(0, prepared.thumb.blob.size);
    const body = new Blob([head, prepared.thumb.blob, prepared.full.blob]);
    const meta = encodeURIComponent(JSON.stringify({ day, caption: $('[data-caption]').value.trim(), takenAt: file.lastModified || null }));
    const bar = $('[data-progress]'); bar.hidden = false;
    xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/photos');
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.setRequestHeader('X-Photo-Meta', meta);
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) bar.firstElementChild.style.width = `${Math.round((e.loaded / e.total) * 100)}%`; };
    xhr.onload = () => {
      let j = {}; try { j = JSON.parse(xhr.responseText); } catch { /* */ }
      if (xhr.status === 200) { s.close(); toast('Photo added'); return; }
      bar.hidden = true;
      const err = $('[data-err]'); err.hidden = false; err.textContent = j.error || `Couldn’t add it (${xhr.status}).`;
      $('[data-go]').disabled = false;
    };
    xhr.onerror = () => { bar.hidden = true; const err = $('[data-err]'); err.hidden = false; err.textContent = 'Couldn’t reach Tabi. Check your connection and try again.'; $('[data-go]').disabled = false; };
    xhr.send(body);
  };
}

// ---------- full-screen viewer ----------
export function openViewer(list, index = 0) {
  if (!list.length) return;
  let i = Math.max(0, index);
  const el = document.createElement('div');
  el.className = 'photo-viewer';
  el.setAttribute('role', 'dialog'); el.setAttribute('aria-modal', 'true'); el.setAttribute('aria-label', 'Photo');
  el.tabIndex = -1;
  document.body.appendChild(el);
  const close = () => { el.remove(); removeEventListener('keydown', key); offPhotos(); };
  const key = (e) => { if (e.key === 'Escape') close(); if (e.key === 'ArrowRight') go(1); if (e.key === 'ArrowLeft') go(-1); };
  addEventListener('keydown', key);
  const go = (d) => { i = (i + d + list.length) % list.length; render(); };
  const offPhotos = on('photos', () => {
    const fresh = state.photos.list;
    list = list.map((p) => fresh.find((x) => x.id === p.id)).filter(Boolean);
    if (!list.length) return close();
    i = Math.min(i, list.length - 1); render();
  });
  function render() {
    const p = list[i];
    const u = userById(p.by);
    const mine = p.by === state.me?.id, admin = state.me?.isAdmin;
    const liked = p.likes.includes(state.me?.id);
    const likers = p.likes.map((id) => userById(id)?.name).filter(Boolean);
    el.innerHTML = `
      <div class="pv-top"><button class="icon-btn pv-close" data-close aria-label="Close">${icon('x')}</button>
        <span class="pv-count num">${list.length > 1 ? `${i + 1} of ${list.length}` : ''}</span>
        <span class="grow"></span>
        <a class="icon-btn" href="${esc(p.url)}" download="tabi-${esc(p.day)}-${p.id}.${p.url.split('.').pop()}" aria-label="Download" data-tip="Download">${icon('download')}</a>
        ${navigator.canShare ? `<button class="icon-btn" data-share aria-label="Share" data-tip="Share">${icon('share')}</button>` : ''}
        ${mine || admin ? `<button class="icon-btn" data-del aria-label="Remove this photo" data-tip="Remove">${icon('trash')}</button>` : ''}</div>
      <div class="pv-stage" data-stage>
        <img src="${esc(p.thumb)}" alt="" class="pv-low"><img src="${esc(p.url)}" alt="${esc(p.caption || `Photo by ${u?.name || 'someone'}`)}" class="pv-img">
        ${list.length > 1 ? `<button class="pv-nav prev" data-prev aria-label="Previous">${icon('chevron-left')}</button><button class="pv-nav next" data-next aria-label="Next">${icon('chevron-right')}</button>` : ''}
      </div>
      <div class="pv-foot">
        <div class="pv-who">${u ? avatar(u) : ''}<div class="grow"><b>${esc(u?.name || 'Someone')}</b> <span class="faint">${esc(dayName(p.day))}, added ${ago(p.at)}</span>
          ${mine || admin ? `<input class="pv-caption" data-caption value="${esc(p.caption)}" maxlength="140" placeholder="Add a caption" aria-label="Caption">` : (p.caption ? `<div class="pv-caption-text">${esc(p.caption)}</div>` : '')}</div>
          <button class="pv-like ${liked ? 'on' : ''}" data-like aria-pressed="${liked}" aria-label="${liked ? 'Unlike' : 'Like'}">${icon('heart')}<span class="num">${p.likes.length || ''}</span></button></div>
        ${likers.length ? `<div class="pv-likers">Liked by ${esc(likers.join(', '))}</div>` : ''}
      </div>`;
    el.querySelector('[data-close]').onclick = close;
    el.querySelector('[data-prev]')?.addEventListener('click', () => go(-1));
    el.querySelector('[data-next]')?.addEventListener('click', () => go(1));
    el.querySelector('[data-like]').onclick = () => { op('photo.like', { id: p.id, on: !liked }); };
    const cap = el.querySelector('[data-caption]');
    if (cap) cap.onchange = () => op('photo.caption', { id: p.id, caption: cap.value.trim() });
    el.querySelector('[data-share]')?.addEventListener('click', async () => {
      try {
        const blob = await (await fetch(p.url)).blob();
        const f = new File([blob], `tabi-${p.day}.${p.url.split('.').pop()}`, { type: blob.type });
        if (navigator.canShare({ files: [f] })) await navigator.share({ files: [f], title: state.trip.name });
      } catch { /* cancelled */ }
    });
    el.querySelector('[data-del]')?.addEventListener('click', async () => {
      if (!(await confirmSheet({ title: 'Remove this photo?', body: 'It’s removed for everyone.', confirm: 'Remove', danger: true }))) return;
      const r = await fetch(`/api/photos/${p.id}`, { method: 'DELETE', credentials: 'same-origin' });
      if (!r.ok) toast((await r.json().catch(() => ({}))).error || 'Couldn’t remove it.');
    });
    // pinch or double-tap to zoom; swipe between photos when not zoomed in
    photoZoom(el.querySelector('[data-stage]'), { onSwipe: (d) => { if (list.length > 1) go(d); } });
  }
  render();
  el.focus();
}

// ---------- the album: every day ----------
export function openAlbum() {
  const s = openSheet({ title: 'Trip photos', className: 'album-sheet', body: '<div data-album></div>' });
  const render = () => {
    const all = state.photos?.list || [];
    const days = [...new Set([...tripDays().filter((d) => d <= today()), ...all.map((p) => p.day)])].sort().reverse();
    const used = state.photos?.bytes || 0, limit = state.photos?.limit || 1;
    s.body.innerHTML = `
      ${days.length ? `<div class="album-days">${days.map((d) => {
        const list = photosOn(d), c = coverOf(d);
        return `<button class="album-day" data-day="${d}">${c ? `<img src="${esc(c.thumb)}" alt="" loading="lazy">` : `<span class="album-none">${icon('camera')}</span>`}
          <span class="album-label"><b>${esc(d === today() ? 'Today' : fmtDay(d, { weekday: 'short', day: 'numeric', month: 'short' }))}</b><span>${list.length ? `${list.length} photo${list.length > 1 ? 's' : ''}` : (canAddOn(d) ? 'Add one' : 'None')}</span></span></button>`;
      }).join('')}</div>` : '<p class="hint">Photos appear here once the trip starts.</p>'}
      ${all.length ? `<button class="btn block" data-zip>${icon('download')}Download all ${all.length} (${mb(all.reduce((n, p) => n + (p.bytes || 0), 0))})</button>` : ''}
      ${state.me?.isAdmin ? `<p class="help album-space">Photo space used: ${mb(used)} of ${mb(limit)}.</p>` : ''}`;
    s.body.querySelectorAll('[data-day]').forEach((b) => b.onclick = () => { s.close(); openDayPhotos(b.dataset.day); });
    s.body.querySelector('[data-zip]')?.addEventListener('click', (e) => downloadAll(e.currentTarget));
  };
  render();
  const off = on('photos', () => (s.closed ? off() : render()));
}

async function downloadAll(btn) {
  const all = state.photos?.list || [];
  btn.disabled = true;
  const label = btn.innerHTML;
  try {
    const { zipSync } = await import('/vendor/fflate/browser.js');
    const files = {};
    let k = 0;
    for (const p of all) {
      btn.textContent = `Downloading ${++k} of ${all.length}…`;
      const buf = new Uint8Array(await (await fetch(p.url, { credentials: 'same-origin' })).arrayBuffer());
      const who = (userById(p.by)?.name || 'someone').replace(/[^\w-]+/g, '_');
      files[`${p.day}_${String(p.id).padStart(4, '0')}_${who}.${p.url.split('.').pop()}`] = [buf, { level: 0 }]; // already compressed
    }
    const zip = zipSync(files);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([zip], { type: 'application/zip' }));
    a.download = `${(state.trip.name || 'trip').replace(/[^\w-]+/g, '_')}-photos.zip`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  } catch { toast('Couldn’t make the download. Check your connection.'); }
  btn.disabled = false; btn.innerHTML = label;
}

// A small button for the day strip and itinerary: camera + count, highlighted when today has none yet
export function dayPhotoButton(day, cls = '') {
  if (!day || (!canAddOn(day) && !photosOn(day).length)) return '';
  const n = photosOn(day).length;
  const nudge = !n && day === today() && new Date().getHours() >= 15;
  return `<button class="day-photo-btn ${cls} ${nudge ? 'nudge' : ''}" data-day-photos="${day}" aria-label="Photos for ${esc(dayName(day))}: ${n} of ${PER_DAY}" data-tip="Picture a day: ${n ? `${n} photo${n > 1 ? 's' : ''}` : 'add the day’s photo'}">${icon('camera', 'small')}<span class="num">${n || '+'}</span></button>`;
}
export const bindDayPhotoButtons = (root) => root.querySelectorAll('[data-day-photos]').forEach((b) => b.onclick = (e) => { e.stopPropagation(); openDayPhotos(b.dataset.dayPhotos); });

on('photos', () => emit('photos-changed'));
