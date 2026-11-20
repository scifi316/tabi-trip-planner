// Base map dressing: 3D buildings in the dark style, and the satellite (hybrid) view.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
};
const { dressStyle, satelliteOn, setSatellite } = await import('../public/js/basemap.js');
const onAtStart = satelliteOn();

// A stand-in for a MapLibre map: just enough of the style API, recording what changes.
function fakeMap(layers) {
  const style = { sources: { openmaptiles: { type: 'vector' } }, layers: structuredClone(layers) };
  const byId = (id) => style.layers.find((l) => l.id === id);
  return {
    style,
    getStyle: () => style,
    getLayer: byId,
    getSource: (id) => style.sources[id],
    addSource: (id, src) => { style.sources[id] = src; },
    addLayer: (layer, beforeId) => {
      const i = beforeId ? style.layers.findIndex((l) => l.id === beforeId) : -1;
      style.layers.splice(i < 0 ? style.layers.length : i, 0, layer);
    },
    setLayerZoomRange: (id, min, max) => Object.assign(byId(id), { minzoom: min, maxzoom: max }),
    setPaintProperty: (id, k, v) => { const l = byId(id); l.paint = { ...l.paint, [k]: v }; },
    setLayoutProperty: (id, k, v) => { const l = byId(id); l.layout = { ...l.layout, [k]: v }; },
  };
}

const DARK = [
  { id: 'background', type: 'background', paint: { 'background-color': 'rgb(12,12,12)' } },
  { id: 'water', type: 'fill', source: 'openmaptiles', 'source-layer': 'water' },
  { id: 'water_name', type: 'symbol', source: 'openmaptiles', 'source-layer': 'water_name', layout: { 'text-field': '{name}' } },
  { id: 'building', type: 'fill', source: 'openmaptiles', 'source-layer': 'building', minzoom: 12 },
  { id: 'highway', type: 'line', source: 'openmaptiles', 'source-layer': 'transportation' },
  { id: 'place_city', type: 'symbol', source: 'openmaptiles', 'source-layer': 'place', layout: { 'text-field': '{name}' } },
];
const LIBERTY = [
  { id: 'background', type: 'background', paint: { 'background-color': '#f8f4f0' } },
  { id: 'natural_earth', type: 'raster', source: 'ne2_shaded' },
  { id: 'park', type: 'fill', source: 'openmaptiles', 'source-layer': 'park' },
  { id: 'waterway_river', type: 'line', source: 'openmaptiles', 'source-layer': 'waterway' },
  { id: 'building', type: 'fill', source: 'openmaptiles', 'source-layer': 'building', minzoom: 13, maxzoom: 14 },
  { id: 'building-3d', type: 'fill-extrusion', source: 'openmaptiles', 'source-layer': 'building', minzoom: 14 },
  { id: 'road_primary', type: 'line', source: 'openmaptiles', 'source-layer': 'transportation' },
  { id: 'boundary_2', type: 'line', source: 'openmaptiles', 'source-layer': 'boundary' },
  { id: 'poi_r1', type: 'symbol', source: 'openmaptiles', 'source-layer': 'poi', layout: { 'icon-image': 'x', 'text-field': '{name}' } },
];

beforeEach(() => { setSatellite(false); store.clear(); });

test('dark style gets extruded buildings from zoom 14, above the roads and below the labels after them', () => {
  const map = fakeMap(DARK);
  dressStyle(map, { dark: true });
  const ids = map.style.layers.map((l) => l.id);
  const b3 = map.style.layers.find((l) => l.id === 'building-3d');
  assert.equal(b3.type, 'fill-extrusion');
  assert.equal(b3.source, 'openmaptiles');
  assert.equal(b3.minzoom, 14);
  assert.deepEqual(b3.paint['fill-extrusion-height'], ['get', 'render_height']);
  assert.ok(ids.indexOf('building-3d') > ids.indexOf('highway'));
  assert.ok(ids.indexOf('building-3d') < ids.indexOf('place_city'));
  assert.equal(map.style.layers.find((l) => l.id === 'building').maxzoom, 14);
});

test('light style and styles that already have 3D are left alone', () => {
  const light = fakeMap(DARK);
  dressStyle(light, { dark: false });
  assert.ok(!light.style.layers.some((l) => l.id === 'building-3d'));
  const has3d = fakeMap(LIBERTY);
  dressStyle(has3d, { dark: true });
  assert.equal(has3d.style.layers.filter((l) => l.type === 'fill-extrusion').length, 1);
});

test('satellite puts GSI photos at the bottom and keeps only roads, borders and labels', () => {
  setSatellite(true);
  assert.equal(satelliteOn(), true);
  const map = fakeMap(LIBERTY);
  dressStyle(map, { dark: true });
  const src = map.style.sources['gsi-photo'];
  assert.equal(src.type, 'raster');
  assert.match(src.tiles[0], /^https:\/\/cyberjapandata\.gsi\.go\.jp\/xyz\/seamlessphoto\/\{z\}\/\{x\}\/\{y\}\.jpg$/);
  assert.equal(src.maxzoom, 18);
  assert.match(src.attribution, /地理院タイル/);
  assert.match(src.attribution, /maps\.gsi\.go\.jp\/development\/ichiran\.html/);
  const ids = map.style.layers.map((l) => l.id);
  assert.equal(ids.indexOf('gsi-photo'), 1); // just above the background
  const vis = (id) => map.style.layers.find((l) => l.id === id).layout?.visibility;
  for (const hidden of ['natural_earth', 'park', 'waterway_river', 'building', 'building-3d']) assert.equal(vis(hidden), 'none', hidden);
  for (const shown of ['road_primary', 'boundary_2', 'poi_r1', 'gsi-photo']) assert.notEqual(vis(shown), 'none', shown);
  assert.equal(map.style.layers.find((l) => l.id === 'road_primary').paint['line-opacity'], 0.6);
  assert.equal(map.style.layers.find((l) => l.id === 'poi_r1').paint['text-color'], '#FFFFFF');
});

test('satellite is off by default', () => {
  assert.equal(onAtStart, false);
});

test('satellite can be switched on and off when storage is blocked', () => {
  const saved = globalThis.localStorage;
  globalThis.localStorage = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
  try {
    assert.doesNotThrow(() => setSatellite(true));
    assert.equal(satelliteOn(), true);
    const map = fakeMap(LIBERTY);
    dressStyle(map, { dark: false });
    assert.ok(map.style.sources['gsi-photo']);
    setSatellite(false);
    assert.equal(satelliteOn(), false);
  } finally { globalThis.localStorage = saved; }
});

test('the saved choice is used on the next visit', () => {
  store.set('tabi.basemap', 'satellite');
  // A fresh page load has made no choice yet, so storage decides: simulate it with a new import.
  return import('../public/js/basemap.js?fresh').then((fresh) => assert.equal(fresh.satelliteOn(), true));
});
