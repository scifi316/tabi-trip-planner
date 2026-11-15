// Adding places: single-place confirm sheet, and the bulk import sheet
// (search, pasted links, Google My Maps, files).
import { state, api, op, tripDays, emit } from './store.js';
import { openSheet, esc, icon, fmtDay, uid, toast, distanceM, STATUS, debounce } from './ui.js';
import { parseFile, parseKml, guessDay } from './parsers.js';
import { openPlace } from './place.js';

const dayOptions = (selected = '') => {
  const days = tripDays();
  return `<option value="">Unscheduled</option>${days.map((d) => `<option value="${d}" ${d === selected ? 'selected' : ''}>${esc(fmtDay(d))}</option>`).join('')}`;
};
const statusOptions = (selected = 'suggested') =>
  ['suggested', 'maybe', 'confirmed'].map((s) => `<option value="${s}" ${s === selected ? 'selected' : ''}>${STATUS[s].label}</option>`).join('');

export function findDuplicate(item) {
  for (const p of state.places.values()) {
    const d = distanceM(p, item);
    if (d < 15 || (d < 150 && p.name.trim().toLowerCase() === String(item.name).trim().toLowerCase())) return p;
  }
  return null;
}

// Confirm a single place (search result, dropped pin, resolved link)
export function openAddOne(item, { defaultDay = '' } = {}) {
  const dup = findDuplicate(item);
  const sheet = openSheet({
    title: item.name || 'Dropped pin',
    sub: item.address || `${item.lat.toFixed(5)}, ${item.lng.toFixed(5)}`,
    body: `
      ${dup ? `<p class="hint">Already in the trip as <b>${esc(dup.name)}</b>. <button class="btn small" data-open-dup>Open it</button></p>` : ''}
      ${item.approximate ? `<p class="hint">Location found by searching the name, so double-check the pin.</p>` : ''}
      <label class="field"><span>Name</span><input class="input" data-name value="${esc(item.name || '')}" placeholder="What is this place?"></label>
      <div class="inline-fields">
        <label class="field"><span>Day</span><select class="input" data-day>${dayOptions(defaultDay)}</select></label>
        <label class="field"><span>Status</span><select class="input" data-status>${statusOptions()}</select></label>
      </div>
      <label class="field"><span>Notes</span><textarea class="input" data-notes rows="2" placeholder="Optional">${esc(item.notes || '')}</textarea></label>`,
    foot: `<button class="btn" data-close>Cancel</button><button class="btn primary" data-add>${icon('plus')}Add to trip</button>`,
  });
  sheet.el.querySelector('[data-open-dup]')?.addEventListener('click', () => { sheet.close(); openPlace(dup.id); emit('focus-place', dup.id); });
  sheet.el.querySelector('[data-add]').onclick = () => {
    const b = sheet.el;
    const id = uid();
    op('place.add', {
      place: {
        id, name: b.querySelector('[data-name]').value.trim() || item.name || 'Dropped pin',
        lat: item.lat, lng: item.lng, address: item.address || null, url: item.url || null,
        notes: b.querySelector('[data-notes]').value.trim() || null,
        day: b.querySelector('[data-day]').value || null, status: b.querySelector('[data-status]').value,
      },
    });
    sheet.close();
    toast('Added to the trip');
    emit('focus-place', id);
  };
  return sheet;
}

// ---------- bulk import sheet ----------
export function openImport(tab = 'search') {
  const sheet = openSheet({
    title: 'Add places',
    body: `
      <div class="tabs-mini" role="group">
        <button data-tab="search">${icon('search')}Search</button>
        <button data-tab="links">${icon('link')}Paste links</button>
        <button data-tab="mymaps">${icon('map')}My Maps</button>
        <button data-tab="file">${icon('file')}File</button>
      </div>
      <div data-pane></div>`,
  });
  const pane = sheet.el.querySelector('[data-pane]');
  const show = (t) => {
    sheet.el.querySelectorAll('[data-tab]').forEach((b) => b.setAttribute('aria-pressed', b.dataset.tab === t));
    ({ search: paneSearch, links: paneLinks, mymaps: paneMyMaps, file: paneFile })[t](pane, sheet);
  };
  sheet.el.querySelectorAll('[data-tab]').forEach((b) => b.onclick = () => show(b.dataset.tab));
  show(tab);
  return sheet;
}

function paneSearch(pane, sheet) {
  pane.innerHTML = `
    <input class="input" type="search" data-q placeholder="Temple, ramen shop, station, address…" enterkeyhint="search">
    <div data-res style="margin-top:8px"></div>`;
  const input = pane.querySelector('[data-q]');
  const res = pane.querySelector('[data-res]');
  const run = debounce(async () => {
    const q = input.value.trim();
    if (q.length < 2) { res.innerHTML = ''; return; }
    if (/https?:\/\//.test(q)) { sheet.close(); openImport('links'); return; }
    res.innerHTML = `<p class="hint">Searching…</p>`;
    try {
      const { results } = await api(`/api/search?q=${encodeURIComponent(q)}&lang=${localStorage.getItem('tabi.labels') === 'ja' ? 'ja' : 'en'}`);
      res.innerHTML = results.length ? `<div class="preview">${results.map((r, i) => `
        <button class="result" data-i="${i}">${icon('pin')}<span class="result-body"><div class="result-name">${esc(r.name)}</div><div class="result-sub">${esc(r.address || r.kind || '')}</div></span></button>`).join('')}</div>`
        : `<p class="hint">No matches in Japan. Try the Japanese name, or paste a Google Maps link.</p>`;
      res.querySelectorAll('[data-i]').forEach((b) => b.onclick = () => { sheet.close(); openAddOne(results[+b.dataset.i]); });
    } catch (e) {
      res.innerHTML = `<p class="err">${esc(e.message)}</p>`;
    }
  }, 350);
  input.oninput = run;
  setTimeout(() => input.focus(), 60);
}

function paneLinks(pane) {
  pane.innerHTML = `
    <p class="hint">Paste one or more links from Google Maps, Apple Maps or OpenStreetMap, or coordinates like <span class="num">34.9671, 135.7727</span>. One per line is fine.</p>
    <textarea class="input" data-text rows="5" placeholder="https://maps.app.goo.gl/…" autofocus></textarea>
    <button class="btn primary block" data-go style="margin-top:10px">Find places</button>
    <div data-out></div>`;
  const go = pane.querySelector('[data-go]');
  go.onclick = async () => {
    const text = pane.querySelector('[data-text]').value.trim();
    if (!text) return;
    go.disabled = true; go.textContent = 'Looking up links…';
    try {
      const { results } = await api('/api/resolve', { method: 'POST', body: { text } });
      const mm = results.find((r) => r.myMaps);
      if (mm) {
        pane.querySelector('[data-out]').innerHTML = `<p class="hint">That is a My Maps link. Importing the whole map…</p>`;
        return importMyMaps(mm.url, pane.querySelector('[data-out]'));
      }
      const items = results.map((r) => r.ok ? { name: r.name || 'Shared place', lat: r.lat, lng: r.lng, address: r.address, url: r.url, approximate: r.approximate }
        : { name: r.name || r.input, bad: r.error || 'No location found in this link' });
      renderPreview(pane.querySelector('[data-out]'), items, { source: 'pasted links' });
    } catch (e) {
      pane.querySelector('[data-out]').innerHTML = `<p class="err">${esc(e.message)}</p>`;
    } finally {
      go.disabled = false; go.textContent = 'Find places';
    }
  };
}

function paneMyMaps(pane) {
  pane.innerHTML = `
    <div class="hint">Import every pin from a Google My Maps map, keeping its layers.
      <ol>
        <li>In My Maps, click <b>Share</b> and set it to anyone with the link can view.</li>
        <li>Copy the link (it contains <span class="num">mid=</span>) and paste it here.</li>
      </ol>
      Private map? Use the menu in My Maps, choose <b>Export to KML/KMZ</b>, and import the file in the File tab.</div>
    <input class="input" data-url placeholder="https://www.google.com/maps/d/edit?mid=…" autofocus>
    <button class="btn primary block" data-go style="margin-top:10px">Import map</button>
    <div data-out></div>`;
  pane.querySelector('[data-go]').onclick = () => importMyMaps(pane.querySelector('[data-url]').value.trim(), pane.querySelector('[data-out]'), pane.querySelector('[data-go]'));
}

async function importMyMaps(url, out, btn) {
  if (!url) return;
  if (btn) { btn.disabled = true; btn.textContent = 'Downloading map…'; }
  try {
    const res = await api(`/api/mymaps?url=${encodeURIComponent(url)}`, { raw: true });
    const items = parseKml(await res.text());
    if (!items.length) throw new Error('That map has no pins.');
    renderPreview(out, items, { layers: true, source: 'Google My Maps' });
  } catch (e) {
    out.innerHTML = `<p class="err">${esc(e.message)}</p>`;
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Import map'; }
  }
}

function paneFile(pane) {
  pane.innerHTML = `
    <p class="hint">KML or KMZ (My Maps export, Google Earth), GeoJSON (Google Takeout “Saved Places.json”), GPX, or CSV with name and lat/lng or Google Maps URL columns.</p>
    <label class="drop">${icon('download')}<div><b>Choose a file</b></div><div style="font-size:13px">or drop it here</div>
      <input type="file" data-file accept=".kml,.kmz,.geojson,.json,.gpx,.csv,.tsv" hidden></label>
    <div data-out></div>`;
  const out = pane.querySelector('[data-out]');
  const handle = async (file) => {
    if (!file) return;
    out.innerHTML = `<p class="hint">Reading ${esc(file.name)}…</p>`;
    try {
      let items = await parseFile(file);
      const unresolved = items.filter((i) => i.needsResolve);
      if (unresolved.length) {
        out.innerHTML = `<p class="hint">Looking up ${unresolved.length} place${unresolved.length > 1 ? 's' : ''} without coordinates…</p>`;
        await resolveMissing(unresolved, (n) => { out.innerHTML = `<p class="hint">Looked up ${n} of ${unresolved.length}…</p>`; });
      }
      items = items.map((i) => (i.lat == null ? { ...i, bad: 'Could not find a location' } : i));
      if (!items.length) throw new Error('No places found in that file.');
      renderPreview(out, items, { layers: items.some((i) => i.layer), source: file.name });
    } catch (e) {
      out.innerHTML = `<p class="err">${esc(e.message)}</p>`;
    }
  };
  pane.querySelector('[data-file]').onchange = (e) => handle(e.target.files[0]);
  const drop = pane.querySelector('.drop');
  drop.ondragover = (e) => { e.preventDefault(); };
  drop.ondrop = (e) => { e.preventDefault(); handle(e.dataTransfer.files[0]); };
}

async function resolveMissing(items, progress) {
  let done = 0;
  for (let i = 0; i < items.length; i += 8) {
    const batch = items.slice(i, i + 8);
    const lines = batch.map((it) => it.url || it.address || it.name);
    try {
      const { results } = await api('/api/resolve', { method: 'POST', body: { text: lines.join('\n') } });
      const byInput = new Map(results.map((r) => [r.input, r]));
      batch.forEach((it, k) => {
        const r = byInput.get(lines[k]) || results[k];
        if (r?.ok) Object.assign(it, { lat: r.lat, lng: r.lng, address: it.address || r.address, approximate: r.approximate });
        if (r?.name && (!it.name || it.name === 'Untitled place')) it.name = r.name;
      });
    } catch { /* leave unresolved */ }
    done += batch.length;
    progress(done);
  }
}

function renderPreview(out, items, { layers = false, source = '' } = {}) {
  const days = tripDays();
  items.forEach((it, i) => {
    it._i = i;
    it._dup = it.bad ? null : findDuplicate(it);
    it._on = !it.bad && !it._dup;
  });
  const groups = {};
  for (const it of items) (groups[layers ? (it.layer || 'Other') : ''] ||= []).push(it);
  const layerDay = {};
  for (const g of Object.keys(groups)) layerDay[g] = guessDay(g, days, state.trip.start);

  const good = items.filter((i) => !i.bad).length;
  out.innerHTML = `
    <div style="margin-top:14px" class="inline-fields">
      <label class="field"><span>Add as</span><select class="input" data-status>${statusOptions()}</select></label>
      ${layers ? '' : `<label class="field"><span>Day</span><select class="input" data-day>${dayOptions()}</select></label>`}
    </div>
    ${layers ? `<p class="hint">Each layer can go to a day. Layers named like “Day 2” or “3/14” are matched automatically.</p>` : ''}
    ${Object.entries(groups).map(([g, list]) => `
      <div class="preview">
        ${layers ? `<div class="preview-head"><span>${esc(g)} <span class="faint num">${list.length}</span></span>
          <select class="input" data-layer="${esc(g)}">${dayOptions(layerDay[g])}</select></div>` : ''}
        ${list.map((it) => `
          <label class="preview-row ${it.bad ? 'bad' : ''}">
            <input type="checkbox" data-i="${it._i}" ${it._on ? 'checked' : ''} ${it.bad ? 'disabled' : ''}>
            <span class="grow"><div class="nm">${esc(it.name)}</div>
              <div class="sub">${it.bad ? esc(it.bad) : it._dup ? `Already in the trip as ${esc(it._dup.name)}` : esc(it.address || `${it.lat.toFixed(4)}, ${it.lng.toFixed(4)}`)}${it.approximate ? ' (found by name)' : ''}</div></span>
          </label>`).join('')}
      </div>`).join('')}
    <button class="btn primary block" data-commit style="margin-top:6px">${icon('plus')}<span></span></button>`;

  const btn = out.querySelector('[data-commit]');
  const count = () => {
    const n = out.querySelectorAll('input[data-i]:checked').length;
    btn.querySelector('span').textContent = n ? `Add ${n} place${n > 1 ? 's' : ''}` : 'Select places to add';
    btn.disabled = !n;
  };
  out.addEventListener('change', count);
  count();
  if (!good) btn.disabled = true;

  btn.onclick = async () => {
    const status = out.querySelector('[data-status]').value;
    const flatDay = out.querySelector('[data-day]')?.value || null;
    const dayForLayer = {};
    out.querySelectorAll('[data-layer]').forEach((s) => { dayForLayer[s.dataset.layer] = s.value || null; });
    const chosen = [...out.querySelectorAll('input[data-i]:checked')].map((c) => items[+c.dataset.i]);
    const base = Date.now();
    const places = chosen.map((it, k) => ({
      id: uid(), name: it.name, lat: it.lat, lng: it.lng, address: it.address || null, notes: it.notes || null,
      url: it.url || null, layer: it.layer || null, status,
      day: it.day || (layers ? dayForLayer[it.layer || 'Other'] : flatDay) || null, time: it.time || null, sort: base + k,
    }));
    for (let i = 0; i < places.length; i += 300) await op('place.bulk', { places: places.slice(i, i + 300), source });
    toast(`Added ${places.length} place${places.length > 1 ? 's' : ''}`);
    emit('fit-all');
    out.closest('.sheet')?.querySelector('[data-close]')?.click();
  };
}
