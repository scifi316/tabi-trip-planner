// The place details sheet, shared by the map and the itinerary.
import { state, on, op, userById, tripDays, effectiveStatus, voteCounts, dayStops, emit, byPlan } from './store.js';
import { openSheet, esc, icon, avatar, STATUS, fmtDay, ago, googleDirections, googlePlace, toast } from './ui.js';

let current = null; // { id, sheet }

export function openPlace(id, { peek = true } = {}) {
  const p = state.places.get(id);
  if (!p) return;
  if (current?.sheet && !current.sheet.closed) current.sheet.close();
  const sheet = openSheet({ peek, body: '', onClose: () => { if (current?.sheet === sheet) { current = null; emit('select', null); } } });
  current = { id, sheet };
  render();
  emit('select', id);
}
export const selectedPlaceId = () => current?.id || null;

on('places', () => {
  if (!current) return;
  if (!state.places.has(current.id)) { current.sheet.close(); return; }
  // Don't clobber a note mid-edit
  if (current.sheet.el.contains(document.activeElement) && document.activeElement.matches('textarea, input[type=text]')) return;
  render();
});
on('users', () => current && render());

function stationLabel(p) {
  if (!p.day) return '';
  const stops = dayStops(p.day);
  const i = stops.findIndex((s) => s.place.id === p.id);
  return i >= 0 ? String(i + 1) : '';
}

// Setting a time moves the stop to the right spot among the day's other timed stops.
function timePatch(p, time) {
  const patch = { time };
  if (!time || !p.day) return patch;
  const others = [...state.places.values()]
    .filter((o) => o.id !== p.id && o.day === p.day && ['confirmed', 'visited', 'skipped'].includes(o.status))
    .sort(byPlan);
  const iAfter = others.findIndex((o) => o.time && o.time > time);
  if (iAfter >= 0) {
    const prev = others[iAfter - 1];
    patch.sort = prev ? (prev.sort + others[iAfter].sort) / 2 : others[iAfter].sort - 1;
  } else {
    const timed = others.filter((o) => o.time && o.time <= time);
    const last = timed[timed.length - 1];
    if (last) {
      const next = others[others.indexOf(last) + 1];
      patch.sort = next ? (last.sort + next.sort) / 2 : last.sort + 1;
    }
  }
  return patch;
}

function render() {
  const p = state.places.get(current.id);
  if (!p) return;
  const { sheet } = current;
  const eff = effectiveStatus(p);
  const st = STATUS[eff];
  const counts = voteCounts(p);
  const mine = p.votes?.[state.me?.id];
  const days = tripDays();
  const n = stationLabel(p);

  sheet.setHead(`
    ${n ? `<span class="station" data-state="${p.status === 'visited' ? 'visited' : eff === 'missed' ? 'missed' : 'todo'}" style="flex:none;margin-top:2px">${n}</span>` : ''}
    <div class="grow">
      <h2>${esc(p.name)}</h2>
      <div class="sub">${p.address ? esc(p.address) : `${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}`}</div>
      <div style="margin-top:8px"><span class="status-pill" style="--sw:${st.color}">${st.label}</span>
      ${p.day ? `<span class="muted" style="font-size:13px;margin-left:8px">${esc(fmtDay(p.day))}${p.time ? ` at ${esc(p.time)}` : ''}</span>` : ''}</div>
    </div>`);

  const voters = (val) => Object.entries(p.votes || {}).filter(([, v]) => v === val).map(([uid]) => userById(uid)).filter(Boolean);
  const voterLine = [['up', 'Want to go'], ['down', 'Not keen'], ['veto', 'Vetoed']]
    .map(([k, label]) => { const us = voters(k); return us.length ? `<span>${label}: ${us.map((u) => `${avatar(u)}${esc(u.name)}`).join(', ')}</span>` : ''; })
    .join('');

  const creator = userById(p.createdBy);
  sheet.body.innerHTML = `
    <div class="inline-fields" style="margin-top:2px">
      <label class="field"><span>Day</span>
        <select class="input" data-f="day">
          <option value="">Unscheduled</option>
          ${days.map((d) => `<option value="${d}" ${d === p.day ? 'selected' : ''}>${esc(fmtDay(d))}</option>`).join('')}
          ${p.day && !days.includes(p.day) ? `<option value="${p.day}" selected>${esc(fmtDay(p.day))}</option>` : ''}
        </select></label>
      <label class="field" style="flex:0 0 140px"><span>Time</span>
        <input class="input num" type="time" data-f="time" value="${esc(p.time || '')}"></label>
    </div>

    <div class="status-seg" role="group" aria-label="Plan status">
      ${['suggested', 'maybe', 'confirmed'].map((s) => `<button data-status="${s}" style="--sw:${STATUS[s].color}" aria-pressed="${p.status === s}">${STATUS[s].label}</button>`).join('')}
    </div>
    <div class="status-more">
      <button class="btn small" data-status="visited" aria-pressed="${p.status === 'visited'}">${icon('check')}${p.status === 'visited' ? 'Visited' : 'Mark visited'}</button>
      <button class="btn small" data-status="skipped">${p.status === 'skipped' ? 'Skipped' : 'Skip'}</button>
      ${p.status === 'vetoed' ? `<button class="btn small" data-restore>Bring back</button>` : ''}
    </div>

    <div class="votes" role="group" aria-label="Your vote">
      <button class="vote-btn up ${mine === 'up' ? 'on' : ''}" data-vote="up" aria-pressed="${mine === 'up'}">${icon('up')}<b>${counts.up}</b>Want to go</button>
      <button class="vote-btn down ${mine === 'down' ? 'on' : ''}" data-vote="down" aria-pressed="${mine === 'down'}">${icon('down')}<b>${counts.down}</b>Not keen</button>
      <button class="vote-btn veto ${mine === 'veto' ? 'on' : ''}" data-vote="veto" aria-pressed="${mine === 'veto'}">${icon('veto')}<b>${counts.veto}</b>Veto</button>
    </div>
    <div class="voters">${voterLine || '<span class="faint">No votes yet</span>'}</div>

    <div class="links">
      <a class="btn primary" href="${googleDirections(p, 'transit')}" target="_blank" rel="noopener">${icon('route')}Directions</a>
      <a class="btn" href="${googleDirections(p, 'walking')}" target="_blank" rel="noopener">${icon('walk')}Walk there</a>
      <a class="btn" href="${googlePlace(p)}" target="_blank" rel="noopener">${icon('external')}Google Maps</a>
      <button class="btn" data-show>${icon('pin')}Show on map</button>
    </div>

    <label class="field"><span>Notes</span>
      <textarea class="input" data-f="notes" rows="3" placeholder="Opening hours, tickets, what to order…">${esc(p.notes || '')}</textarea></label>
    <label class="field"><span>Name</span>
      <input class="input" type="text" data-f="name" value="${esc(p.name)}"></label>

    <div class="meta-foot">
      <span>Added by ${esc(creator?.name || 'someone')}${p.createdAt ? `, ${ago(p.createdAt)}` : ''}${p.layer ? ` from “${esc(p.layer)}”` : ''}</span>
      <button class="btn small danger" data-delete>${icon('trash')}Remove</button>
    </div>`;

  const b = sheet.body;
  const update = (patch) => op('place.update', { id: p.id, patch });

  // Moving to another day appends it to the end of that day's line
  b.querySelector('[data-f=day]').onchange = (e) => update({ day: e.target.value || null, sort: Date.now() });
  b.querySelector('[data-f=time]').onchange = (e) => update(timePatch(p, e.target.value || null));
  b.querySelector('[data-f=notes]').onchange = (e) => update({ notes: e.target.value });
  b.querySelector('[data-f=name]').onchange = (e) => e.target.value.trim() && update({ name: e.target.value.trim() });

  b.querySelectorAll('[data-status]').forEach((btn) => btn.onclick = () => {
    const s = btn.dataset.status;
    if (s === p.status && s !== 'suggested') return update({ status: s === 'visited' || s === 'skipped' ? 'confirmed' : 'suggested' });
    const patch = { status: s };
    if (s === 'confirmed' && !p.day && days.length) {
      toast('Confirmed. Pick a day so it shows on that day’s line.');
    }
    update(patch);
  });
  b.querySelector('[data-restore]')?.addEventListener('click', () => update({ status: 'suggested' }));
  b.querySelectorAll('[data-vote]').forEach((btn) => btn.onclick = async () => {
    const v = btn.dataset.vote;
    const r = await op('place.vote', { id: p.id, value: mine === v ? null : v });
    if (v === 'veto' && mine !== v && r?.ok !== false) {
      const rule = state.trip.vetoRule;
      toast(rule === 'single' ? `${p.name} is vetoed` : rule === 'majority' ? 'Veto counted. Over half the group must veto to remove it.' : 'Veto counted as a no vote.');
    }
  });
  b.querySelector('[data-show]').onclick = () => { emit('focus-place', p.id); emit('go', 'map'); };
  const del = b.querySelector('[data-delete]');
  del.onclick = () => {
    if (del.dataset.armed) { op('place.delete', { id: p.id }); toast(`Removed ${p.name}`); return; }
    del.dataset.armed = '1';
    del.innerHTML = `${icon('trash')}Tap again to remove`;
    setTimeout(() => { if (del.isConnected) { delete del.dataset.armed; del.innerHTML = `${icon('trash')}Remove`; } }, 3000);
  };
}
