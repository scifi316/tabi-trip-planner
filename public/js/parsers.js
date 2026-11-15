// Parsers for imported place lists. Every parser returns
// [{ name, lat, lng, notes, layer, url, address, day, time, needsResolve }]

const htmlToText = (html) => {
  if (!html) return '';
  const doc = new DOMParser().parseFromString(`<body>${String(html).replace(/<br\s*\/?>/gi, '\n')}</body>`, 'text/html');
  return doc.body.textContent.replace(/\n{3,}/g, '\n\n').trim();
};
const textOf = (el, tag) => el.getElementsByTagName(tag)[0]?.textContent?.trim() || '';

function centroid(coordsText) {
  const pts = coordsText.trim().split(/\s+/).map((c) => c.split(',').map(Number)).filter((c) => c.length >= 2 && c.every(Number.isFinite));
  if (!pts.length) return null;
  const lng = pts.reduce((s, c) => s + c[0], 0) / pts.length;
  const lat = pts.reduce((s, c) => s + c[1], 0) / pts.length;
  return { lat, lng };
}

export function parseKml(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new Error('That file is not valid KML.');
  const docName = textOf(doc.getElementsByTagName('Document')[0] || doc, 'name');
  const out = [];
  for (const pm of doc.getElementsByTagName('Placemark')) {
    const point = pm.getElementsByTagName('Point')[0];
    let pos = null;
    if (point) {
      const [lng, lat] = textOf(point, 'coordinates').split(',').map(Number);
      if (Number.isFinite(lat) && Number.isFinite(lng)) pos = { lat, lng };
    } else {
      const coords = pm.getElementsByTagName('coordinates')[0];
      if (coords) pos = centroid(coords.textContent);
    }
    if (!pos) continue;
    // Layer = nearest enclosing Folder name (My Maps exports one Folder per layer)
    let layer = '';
    for (let n = pm.parentElement; n; n = n.parentElement) {
      if (n.tagName === 'Folder') { layer = [...n.children].find((c) => c.tagName === 'name')?.textContent.trim() || ''; break; }
    }
    // My Maps custom columns arrive as ExtendedData
    const extra = [];
    for (const d of pm.getElementsByTagName('Data')) {
      const k = d.getAttribute('name');
      const v = textOf(d, 'value');
      if (!v || /^gx_media_links$/i.test(k) || /^(name|description)$/i.test(k)) continue;
      extra.push(`${k}: ${v}`);
    }
    const desc = htmlToText(textOf(pm, 'description'));
    const notes = [desc, ...extra].filter(Boolean).join('\n');
    const urlMatch = notes.match(/https?:\/\/\S+/);
    out.push({
      name: [...pm.children].find((c) => c.tagName === 'name')?.textContent.trim() || 'Untitled place',
      ...pos,
      notes: notes.slice(0, 4000),
      layer: layer || docName || '',
      url: urlMatch ? urlMatch[0] : '',
      address: textOf(pm, 'address'),
    });
  }
  return out;
}

export async function parseKmz(buffer) {
  const { unzipSync, strFromU8 } = await import('/vendor/fflate/browser.js');
  const files = unzipSync(new Uint8Array(buffer));
  const name = Object.keys(files).find((n) => n.toLowerCase().endsWith('.kml'));
  if (!name) throw new Error('No KML file found inside that KMZ.');
  return parseKml(strFromU8(files[name]));
}

export function parseGpx(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new Error('That file is not valid GPX.');
  const out = [];
  for (const tag of ['wpt', 'rtept']) {
    for (const w of doc.getElementsByTagName(tag)) {
      const lat = +w.getAttribute('lat'), lng = +w.getAttribute('lon');
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
      out.push({ name: textOf(w, 'name') || 'Waypoint', lat, lng, notes: textOf(w, 'desc') || textOf(w, 'cmt'), layer: tag === 'rtept' ? 'Route' : '' });
    }
  }
  return out;
}

export function parseGeoJson(obj) {
  const feats = obj.type === 'FeatureCollection' ? obj.features : obj.type === 'Feature' ? [obj] : Array.isArray(obj) ? obj : [];
  const out = [];
  for (const f of feats) {
    const pr = f.properties || {};
    const g = f.geometry || {};
    let pos = null;
    if (g.type === 'Point' && Array.isArray(g.coordinates)) pos = { lat: +g.coordinates[1], lng: +g.coordinates[0] };
    else if (g.coordinates) pos = centroid(JSON.stringify(g.coordinates).replace(/\]\s*,\s*\[/g, ' ').replace(/[[\]]/g, ''));
    // Google Takeout "Saved Places.json"
    const loc = pr.location || pr.Location || {};
    const name = pr.name || pr.Name || pr.title || pr.Title || loc.name || loc['Business Name'] || 'Untitled place';
    const url = pr.google_maps_url || pr['Google Maps URL'] || pr.url || '';
    const address = loc.address || loc.Address || pr.address || '';
    const valid = pos && Number.isFinite(pos.lat) && Number.isFinite(pos.lng) && !(pos.lat === 0 && pos.lng === 0);
    out.push({
      name, url, address,
      notes: htmlToText(pr.description || pr.notes || pr.Comment || ''),
      layer: pr.layer || pr.folder || pr.list || '',
      ...(valid ? pos : { needsResolve: !!url }),
    });
  }
  return out.filter((p) => p.lat != null || p.needsResolve);
}

// Minimal RFC 4180 CSV reader
function csvRows(text) {
  const rows = [];
  let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') q = false;
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((v) => v.trim()));
}

export function parseCsv(text) {
  const rows = csvRows(text.replace(/^﻿/, ''));
  if (rows.length < 2) return [];
  const head = rows[0].map((h) => h.trim().toLowerCase());
  const col = (...names) => head.findIndex((h) => names.includes(h));
  const iName = col('name', 'title', 'place', 'location name');
  const iLat = col('lat', 'latitude', 'y');
  const iLng = col('lng', 'lon', 'long', 'longitude', 'x');
  const iNote = col('note', 'notes', 'description', 'comment');
  const iUrl = col('url', 'link', 'google maps url', 'maps url');
  const iDay = col('day', 'date');
  const iTime = col('time', 'start');
  const iLayer = col('layer', 'list', 'category', 'folder', 'tags');
  const iAddr = col('address');
  return rows.slice(1).map((r) => {
    const lat = parseFloat(r[iLat]), lng = parseFloat(r[iLng]);
    const has = Number.isFinite(lat) && Number.isFinite(lng);
    const day = iDay >= 0 && /^\d{4}-\d{2}-\d{2}$/.test(r[iDay]?.trim()) ? r[iDay].trim() : null;
    const time = iTime >= 0 && /^\d{1,2}:\d{2}$/.test(r[iTime]?.trim()) ? r[iTime].trim().padStart(5, '0') : null;
    const url = iUrl >= 0 ? r[iUrl]?.trim() : '';
    return {
      name: (iName >= 0 && r[iName]?.trim()) || 'Untitled place',
      notes: iNote >= 0 ? r[iNote]?.trim() : '',
      url, day, time,
      layer: iLayer >= 0 ? r[iLayer]?.trim() : '',
      address: iAddr >= 0 ? r[iAddr]?.trim() : '',
      ...(has ? { lat, lng } : { needsResolve: !!url || (iAddr >= 0 && !!r[iAddr]?.trim()) }),
    };
  }).filter((p) => p.lat != null || p.needsResolve);
}

export async function parseFile(file) {
  const name = file.name.toLowerCase();
  if (name.endsWith('.kmz')) return parseKmz(await file.arrayBuffer());
  const text = await file.text();
  if (name.endsWith('.kml') || text.trimStart().startsWith('<?xml') && text.includes('<kml')) return parseKml(text);
  if (name.endsWith('.gpx') || text.includes('<gpx')) return parseGpx(text);
  if (name.endsWith('.csv') || name.endsWith('.tsv')) return parseCsv(name.endsWith('.tsv') ? text.replace(/\t/g, ',') : text);
  if (name.endsWith('.json') || name.endsWith('.geojson')) {
    const j = JSON.parse(text);
    if (j.places && Array.isArray(j.places)) return j.places; // Tabi export
    return parseGeoJson(j);
  }
  throw new Error('Use a KML, KMZ, GeoJSON, GPX or CSV file.');
}

// Guess a trip day from a layer name like "Day 3", "3/14" or "2026-03-14".
export function guessDay(layer, days, tripStart) {
  if (!layer) return '';
  const iso = layer.match(/(\d{4}-\d{2}-\d{2})/);
  if (iso && days.includes(iso[1])) return iso[1];
  const dayN = layer.match(/\bday\s*(\d{1,2})\b/i) || layer.match(/(\d{1,2})日目/);
  if (dayN && days.length) {
    const base = tripStart || days[0];
    const idx = days.indexOf(base);
    const d = days[idx + (+dayN[1]) - 1];
    if (d) return d;
  }
  const md = layer.match(/\b(\d{1,2})[/.月](\d{1,2})日?\b/);
  if (md) {
    const hit = days.find((d) => +d.slice(5, 7) === +md[1] && +d.slice(8, 10) === +md[2]);
    if (hit) return hit;
  }
  return '';
}
