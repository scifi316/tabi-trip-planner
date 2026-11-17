// Stays: where the group sleeps. Each is a house on the map, with the nights it covers, so
// "Home" always means tonight's place, and anyone can get directions back to it.
import { state, on, op, emit, today, api } from './store.js';
import { esc, icon, openSheet, toast, confirmSheet, fmtDay, distanceM, uid } from './ui.js';
import { myPosition } from './location.js';

export const stayById = (id) => (state.stays || []).find((s) => s.id === id);
const covers = (s, d) => (!s.startDay || s.startDay <= d) && (!s.endDay || s.endDay >= d);
// Tonight's stay; otherwise the next one coming up; otherwise the last one.
export function stayFor(day = today()) {
  const list = state.stays || [];
  return list.find((s) => covers(s, day)) || list.filter((s) => s.startDay && s.startDay > day).sort((a, b) => (a.startDay < b.startDay ? -1 : 1))[0] || list.at(-1) || null;
}
// The stay covering tonight, if any (the only one called "Home")
export const stayTonight = (day = today()) => (state.stays || []).find((s) => covers(s, day)) || null;
const nights = (s) => (s.startDay && s.endDay ? Math.round((Date.parse(s.endDay) - Date.parse(s.startDay)) / 864e5) + 1 : 0);
export function whenText(s) {
  if (!s.startDay) return 'Whole trip';
  const f = (d) => fmtDay(d, { weekday: 'short', day: 'numeric', month: 'short' });
  const n = nights(s);
  return s.startDay === s.endDay ? `Night of ${f(s.startDay)}` : `${n} nights, ${f(s.startDay)} to ${f(s.endDay)}`;
}
const directions = (s, mode = 'transit') => `https://www.google.com/maps/dir/?api=1&destination=${s.lat},${s.lng}&travelmode=${mode}`;

// ---------- the card ----------
let card = null;
export function openStay(id) {
  const s = stayById(id);
  if (!s) return;
  if (card && !card.closed) card.close();
  card = openSheet({ peek: true, className: 'stay-sheet' });
  const render = () => {
    const st = stayById(id);
    if (!st) return card.close();
    const me = myPosition();
    const away = me ? distanceM(me, st) : null;
    const isTonight = st === stayTonight();
    card.setHead(`<div style="display:flex;gap:12px;align-items:center" class="grow"><span class="stay-badge">${icon('home')}</span>
      <div><h2>${esc(st.name)}</h2><div class="sub">${isTonight ? 'Home tonight. ' : ''}${esc(whenText(st))}</div></div></div>`);
    card.body.innerHTML = `
      ${st.address ? `<p class="stay-address">${esc(st.address)}</p>` : ''}
      ${away != null ? `<p class="help">${away < 1000 ? `${Math.round(away / 10) * 10} m` : `${(away / 1000).toFixed(away < 10000 ? 1 : 0)} km`} from you</p>` : ''}
      ${st.notes ? `<p class="stay-notes">${esc(st.notes)}</p>` : ''}
      <div class="links">
        <a class="btn primary" href="${directions(st)}" target="_blank" rel="noopener">${icon('route')}Directions home</a>
        <a class="btn" href="${directions(st, 'walking')}" target="_blank" rel="noopener">${icon('walk')}Walk</a>
      </div>
      <div class="links" style="margin-top:-6px">
        ${st.address ? `<button class="btn" data-copy>${icon('copy')}Copy address</button>` : ''}
        <button class="btn" data-edit>${icon('settings')}Edit</button>
      </div>
      ${(state.stays || []).length > 1 ? `<p class="help">The group has ${state.stays.length} stays. <button class="linklike" data-all-stays>See them all</button></p>` : ''}`;
    card.body.querySelector('[data-copy]')?.addEventListener('click', async () => { try { await navigator.clipboard.writeText(st.address); toast('Address copied'); } catch { toast(st.address); } });
    card.body.querySelector('[data-edit]').onclick = () => openStayEditor(st.id);
    card.body.querySelector('[data-all-stays]')?.addEventListener('click', () => openStays());
  };
  render();
  const off = on('stays', () => (card.closed ? off() : render()));
  emit('focus-stay', id);
}

// ---------- all of them ----------
export function openStays() {
  const s = openSheet({ title: 'Where we’re staying', sub: 'Shown on the map as houses. “Home” is tonight’s.', body: '<div data-list></div>' });
  const render = () => {
    const list = state.stays || [];
    s.body.innerHTML = `${list.length ? `<div class="card" style="margin:0 0 12px;border:1px solid var(--line)">${list.map((x) => `
        <button class="row friend-row-item" data-open="${esc(x.id)}"><span class="stay-badge small">${icon('home', 'small')}</span>
          <span class="grow"><span class="label">${esc(x.name)}${x === stayTonight() ? ' <span class="tag new">Tonight</span>' : ''}</span><span class="help">${esc(whenText(x))}</span></span>${icon('chevron-right')}</button>`).join('')}</div>`
      : '<p class="hint">Add your hotel, Airbnb or ryokan so everyone can find their way back.</p>'}
      <button class="btn primary block" data-new>${icon('plus')}Add a stay</button>`;
    s.body.querySelectorAll('[data-open]').forEach((b) => b.onclick = () => { s.close(); emit('go', 'map'); openStay(b.dataset.open); });
    s.body.querySelector('[data-new]').onclick = () => openStayEditor();
  };
  render();
  const off = on('stays', () => (s.closed ? off() : render()));
}

// ---------- adding or changing one ----------
export function openStayEditor(id = null, draft = null) {
  const prev = id ? stayById(id) : null;
  const v = draft || (prev ? { ...prev } : { id: `s_${uid()}`, name: '', address: '', lat: null, lng: null, startDay: '', endDay: '', notes: '' });
  const tr = state.trip;
  const s = openSheet({
    title: prev ? 'Edit stay' : 'Add where we’re staying', className: 'stay-editor',
    body: `
      <label class="field"><span>Address, or a Google Maps link</span>
        <div class="stay-find"><input class="input" data-addr placeholder="Hotel name, address, or paste a link" value="${esc(v.address)}" autocomplete="street-address">
        <button class="btn" data-find>Find</button></div></label>
      <div data-results></div>
      <p class="help stay-spot" data-spot>${v.lat != null ? `Pinned at ${v.lat.toFixed(5)}, ${v.lng.toFixed(5)}.` : 'Not on the map yet.'} <button class="linklike" data-on-map>Set it on the map</button></p>
      <label class="field"><span>Name</span><input class="input" data-name maxlength="80" placeholder="Hotel Gracery Shinjuku" value="${esc(v.name)}"></label>
      <div class="inline-fields">
        <label class="field"><span>First night</span><input class="input" type="date" data-start value="${esc(v.startDay || '')}" ${tr.start ? `min="${tr.start}"` : ''} ${tr.end ? `max="${tr.end}"` : ''}></label>
        <label class="field"><span>Last night</span><input class="input" type="date" data-end value="${esc(v.endDay || '')}" ${tr.start ? `min="${tr.start}"` : ''} ${tr.end ? `max="${tr.end}"` : ''}></label>
      </div>
      <p class="help" style="margin-top:-6px">Leave the dates empty if it’s the same place the whole trip.</p>
      <label class="field"><span>Notes (optional)</span><textarea class="input" data-notes maxlength="400" rows="2" placeholder="Check-in from 15:00, the entrance is round the back">${esc(v.notes)}</textarea></label>
      <p class="help">Everyone on the trip can see this. Don’t put door codes here.</p>
      <p class="err" data-err hidden></p>`,
    foot: `${prev ? '<button class="btn danger" data-del>Remove</button>' : '<button class="btn" data-cancel>Cancel</button>'}<button class="btn primary" data-save>Save</button>`,
  });
  const $ = (q) => s.el.querySelector(q);
  const spot = () => { $('[data-spot]').firstChild.textContent = v.lat != null ? `Pinned at ${v.lat.toFixed(5)}, ${v.lng.toFixed(5)}. ` : 'Not on the map yet. '; };
  const err = (m) => { const e = $('[data-err]'); e.hidden = !m; e.textContent = m || ''; };
  $('[data-cancel]')?.addEventListener('click', () => s.close());
  async function find() {
    const q = $('[data-addr]').value.trim();
    if (!q) return;
    const box = $('[data-results]');
    box.innerHTML = '<p class="help">Looking…</p>';
    try {
      const r = await api(`/api/address?q=${encodeURIComponent(q)}`);
      if (!r.results.length) { box.innerHTML = '<p class="help">Couldn’t find that. Try the hotel’s name, paste its Google Maps link, or set it on the map.</p>'; return; }
      box.innerHTML = `${r.approximate ? `<p class="help">The exact address isn’t on the map, so these are near it (“${esc(r.used)}”). Pick one, then adjust it on the map if you like.</p>` : ''}
        <div class="stay-results">${r.results.map((x, i) => `<button class="result" data-r="${i}">${icon('pin')}<span class="result-body"><span class="result-name">${esc(x.name)}</span><span class="result-sub">${esc(x.address || '')}</span></span></button>`).join('')}</div>`;
      box.querySelectorAll('[data-r]').forEach((b) => b.onclick = () => {
        const x = r.results[+b.dataset.r];
        Object.assign(v, { lat: x.lat, lng: x.lng });
        if (!$('[data-name]').value.trim() && !r.approximate) $('[data-name]').value = x.name;
        if (!/^https?:/i.test(q)) v.address = q; else if (x.address) { v.address = x.address; $('[data-addr]').value = x.address; }
        box.innerHTML = `<p class="help ok-msg">${icon('check', 'small')} Found: ${esc(x.name)}${x.address ? `, ${esc(x.address)}` : ''}</p>`;
        spot(); err('');
      });
    } catch (e) { box.innerHTML = `<p class="err">${esc(e.message)}</p>`; }
  }
  $('[data-find]').onclick = find;
  $('[data-addr]').onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); find(); } };
  $('[data-addr]').oninput = () => { v.address = $('[data-addr]').value.trim(); };
  const collect = () => Object.assign(v, { name: $('[data-name]').value.trim(), address: $('[data-addr]').value.trim(), startDay: $('[data-start]').value || '', endDay: $('[data-end]').value || '', notes: $('[data-notes]').value.trim() });
  $('[data-on-map]').onclick = () => {
    collect();
    s.close();
    emit('go', 'map');
    emit('pick-location', {
      at: v.lat != null ? { lat: v.lat, lng: v.lng } : null,
      label: 'Move the map so the cross is on your stay',
      done: (p) => openStayEditor(id, p ? { ...v, ...p } : v), // back to the form, with what was typed
    });
  };
  $('[data-save]').onclick = async () => {
    const out = { ...v, name: $('[data-name]').value.trim(), address: $('[data-addr]').value.trim(), startDay: $('[data-start]').value || null, endDay: $('[data-end]').value || $('[data-start]').value || null, notes: $('[data-notes]').value.trim() };
    if (!out.name) return err('Give it a name, like the hotel’s.');
    if (out.lat == null) return err('Find the address, or set it on the map, so it can show there.');
    const r = await op('stay.save', { stay: out });
    if (r.ok === false) return err(r.error);
    s.close();
    toast(prev ? 'Stay updated' : 'Stay added. It’s on the map.');
    emit('go', 'map');
    setTimeout(() => openStay(out.id), 300);
  };
  $('[data-del]')?.addEventListener('click', async () => {
    if (!(await confirmSheet({ title: `Remove ${prev.name}?`, body: 'It disappears from everyone’s map.', confirm: 'Remove', danger: true }))) return;
    const r = await op('stay.delete', { id: prev.id });
    if (r.ok === false) return err(r.error);
    s.close(); card?.close(); toast('Stay removed');
  });
  if (!prev) setTimeout(() => $('[data-addr]').focus(), 60);
}
