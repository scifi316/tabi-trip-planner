// Base map dressing, applied after every style load: 3D buildings in the dark style, and the
// "Satellite" view (aerial photos with the map's roads and labels on top).
//
// Satellite photos are the Geospatial Information Authority of Japan's seamless photo tiles
// (地理院タイル, seamlessphoto): free, no key, sharp across Japan at zoom 14–18 and a coarser
// mosaic below that. GSI asks only for a credit line when apps load them live. Its terms say
// nothing about keeping copies, so they stay out of offline map packs and the service worker
// never stores them (see sw.js).

const BASEMAP_KEY = 'tabi.basemap';
const PHOTO_SRC = 'gsi-photo';
export const PHOTO_HOST = 'cyberjapandata.gsi.go.jp';
const PHOTO_TILES = `https://${PHOTO_HOST}/xyz/seamlessphoto/{z}/{x}/{y}.jpg`;
const PHOTO_CREDIT = '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank" rel="noopener">地理院タイル (GSI)</a>';

// This session's choice wins; storage only carries it over to the next visit. Where storage is
// blocked (some private modes), the choice still holds until the page is closed.
let chosen = null;
export function satelliteOn() {
  if (chosen) return chosen === 'satellite';
  try { return localStorage.getItem(BASEMAP_KEY) === 'satellite'; } catch { return false; }
}
export function setSatellite(on) {
  chosen = on ? 'satellite' : 'map';
  try { localStorage.setItem(BASEMAP_KEY, chosen); } catch { /* kept in memory above */ }
}

// Called on every 'style.load'.
export function dressStyle(map, { dark }) {
  const layers = map.getStyle()?.layers || [];
  if (satelliteOn()) makeHybrid(map, layers);
  else if (dark) addBuildings3d(map, layers);
}

// OpenFreeMap's Dark style only has flat building footprints. The tiles carry the same building
// heights the light (Liberty) style extrudes, so add the same extrusion in dark colours.
function addBuildings3d(map, layers) {
  if (layers.some((l) => l.type === 'fill-extrusion')) return; // a custom style that already has 3D
  const flat = layers.find((l) => l.type === 'fill' && l['source-layer'] === 'building');
  if (!flat || map.getLayer('building-3d')) return;
  // Above the roads and below the labels that follow the buildings (the Dark style draws its
  // water names before the buildings, so the first label overall is too low).
  const beforeId = layers.slice(layers.indexOf(flat) + 1).find((l) => l.type === 'symbol')?.id;
  map.addLayer({
    id: 'building-3d',
    type: 'fill-extrusion',
    source: flat.source,
    'source-layer': 'building',
    minzoom: 14,
    filter: ['!', ['has', 'hide_3d']],
    paint: {
      'fill-extrusion-color': 'hsl(220, 6%, 17%)',
      'fill-extrusion-height': ['get', 'render_height'],
      'fill-extrusion-base': ['get', 'render_min_height'],
      'fill-extrusion-opacity': 0.85,
    },
  }, beforeId);
  // Flat footprints below zoom 14, 3D from there, as in the light style.
  map.setLayerZoomRange(flat.id, flat.minzoom ?? 0, 14);
}

// Aerial photos underneath, then only the roads, railways, borders and labels of the style on top.
function makeHybrid(map, layers) {
  if (map.getSource(PHOTO_SRC)) return;
  map.addSource(PHOTO_SRC, {
    type: 'raster', tiles: [PHOTO_TILES], tileSize: 256, minzoom: 2, maxzoom: 18, attribution: PHOTO_CREDIT,
  });
  for (const l of layers) {
    if (l.type === 'background') {
      map.setPaintProperty(l.id, 'background-color', '#2B302A'); // shows while photos load or offline
    } else if (['fill', 'fill-extrusion', 'hillshade', 'raster'].includes(l.type)) {
      map.setLayoutProperty(l.id, 'visibility', 'none');
    } else if (l.type === 'line') {
      if (['waterway', 'landcover', 'landuse', 'park', 'building', 'water'].includes(l['source-layer'])) map.setLayoutProperty(l.id, 'visibility', 'none');
      else if (l['source-layer'] === 'transportation') map.setPaintProperty(l.id, 'line-opacity', 0.6);
    } else if (l.type === 'symbol' && l.layout?.['text-field']) {
      map.setPaintProperty(l.id, 'text-color', '#FFFFFF');
      map.setPaintProperty(l.id, 'text-halo-color', 'rgba(0, 0, 0, 0.75)');
      map.setPaintProperty(l.id, 'text-halo-width', 1.4);
    }
  }
  const firstAbove = layers.find((l) => l.type !== 'background')?.id;
  map.addLayer({ id: PHOTO_SRC, type: 'raster', source: PHOTO_SRC, paint: { 'raster-fade-duration': 150 } }, firstAbove);
}
