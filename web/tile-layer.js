// ---------------------------------------------------------------------------
// Tile layer — a real basemap under the property map, without a map library
// ---------------------------------------------------------------------------
// Leaflet and MapLibre both want to own the container, and neither is small.
// What this map actually needs is much less than either provides: a fixed
// view of one region, a picture of the roads and water under the pins, and
// nothing that pans or zooms. That is a tile grid and a projection, which is
// what this file is — about a hundred lines and no dependency, in keeping
// with the rest of the site.
//
// WHAT IT DOES NOT DO, deliberately: pan, zoom, inertia, tile caching across
// views, retina swapping. The map is a locator, not an exploration tool; the
// list beside it is the thing people read. If real pan/zoom is ever wanted,
// that is the point to reach for MapLibre and OpenFreeMap's vector tiles
// instead of growing this.
//
// PROJECTION. Tiles are Web Mercator (EPSG:3857) — that is what every tile
// server on earth serves. geo.js's own projection is equirectangular, which
// is fine for a blank locator but is NOT the same shape. So when tiles are
// showing, the pins must be placed by the Mercator maths here, or they land
// in the wrong towns. That is the whole reason this module exports a
// projector rather than only drawing images.

const TILE_SIZE = 256;
const RAD = Math.PI / 180;

/** Longitude -> absolute world pixel x at this zoom. */
export function lonToWorldX(lon, zoom) {
  return ((lon + 180) / 360) * TILE_SIZE * 2 ** zoom;
}

/** Latitude -> absolute world pixel y at this zoom (Web Mercator). */
export function latToWorldY(lat, zoom) {
  // Clamped to the latitudes Mercator can actually represent; beyond about
  // 85 degrees the projection runs off to infinity.
  const clamped = Math.max(-85.05112878, Math.min(85.05112878, lat));
  const sin = Math.sin(clamped * RAD);
  const y = 0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI);
  return y * TILE_SIZE * 2 ** zoom;
}

/**
 * The closest zoom at which `bounds` still fits inside a box of this size.
 *
 * Integer zooms only: a tile server has no tiles between them, and scaling
 * images to fake a fractional zoom is how a map ends up blurry.
 */
export function fitZoom(bounds, width, height, { minZoom = 1, maxZoom = 16 } = {}) {
  for (let zoom = maxZoom; zoom > minZoom; zoom--) {
    const spanX = lonToWorldX(bounds.maxLon, zoom) - lonToWorldX(bounds.minLon, zoom);
    const spanY = latToWorldY(bounds.minLat, zoom) - latToWorldY(bounds.maxLat, zoom);
    if (spanX <= width && spanY <= height) return zoom;
  }
  return minZoom;
}

/**
 * Works out the view for a set of bounds: which zoom, which tiles, and where
 * the top-left of the picture sits in world pixels.
 *
 * The region is CENTRED in the box rather than pinned to a corner, so the
 * padding falls evenly on both sides the way the SVG locator's does.
 */
export function planView(bounds, width, height, options = {}) {
  const zoom = fitZoom(bounds, width, height, options);

  const west = lonToWorldX(bounds.minLon, zoom);
  const east = lonToWorldX(bounds.maxLon, zoom);
  const north = latToWorldY(bounds.maxLat, zoom);
  const south = latToWorldY(bounds.minLat, zoom);

  const originX = (west + east) / 2 - width / 2;
  const originY = (north + south) / 2 - height / 2;

  const first = { x: Math.floor(originX / TILE_SIZE), y: Math.floor(originY / TILE_SIZE) };
  const last = {
    x: Math.floor((originX + width) / TILE_SIZE),
    y: Math.floor((originY + height) / TILE_SIZE),
  };

  const span = 2 ** zoom;
  const tiles = [];
  for (let y = first.y; y <= last.y; y++) {
    // Off the top or bottom of the world there is nothing to ask for.
    if (y < 0 || y >= span) continue;
    for (let x = first.x; x <= last.x; x++) {
      tiles.push({
        // Longitude wraps, so an x either side of the date line is a real
        // tile at the other end of the world.
        x: ((x % span) + span) % span,
        y,
        zoom,
        left: x * TILE_SIZE - originX,
        top: y * TILE_SIZE - originY,
      });
    }
  }

  return { zoom, originX, originY, width, height, tiles };
}

/**
 * Plans a view for a fixed WIDTH, letting the height follow the ground.
 *
 * Tile zooms are integers, so fitting a region into a box someone else chose
 * usually leaves a wide band of empty map on two sides. Choosing the zoom
 * from the width alone and then making the box as tall as the region needs
 * fills the picture instead — the same reason viewBoxFor() shapes the SVG
 * locator to its data rather than to a fixed rectangle.
 */
export function planFittedView(bounds, {
  width = 1000, padding = 34, minHeight = 320, maxHeight = 720, maxZoom = 14,
} = {}) {
  const usable = width - padding * 2;
  let zoom = maxZoom;
  for (; zoom > 1; zoom--) {
    const spanX = lonToWorldX(bounds.maxLon, zoom) - lonToWorldX(bounds.minLon, zoom);
    const spanY = latToWorldY(bounds.minLat, zoom) - latToWorldY(bounds.maxLat, zoom);
    // The height is ours to choose, but not without limit: a tall thin region
    // must not produce a map three screens deep on a phone.
    if (spanX <= usable && spanY <= maxHeight - padding * 2) break;
  }

  const spanY = latToWorldY(bounds.minLat, zoom) - latToWorldY(bounds.maxLat, zoom);
  const height = Math.round(Math.min(maxHeight, Math.max(minHeight, spanY + padding * 2)));
  return planView(bounds, width, height, { maxZoom: zoom, minZoom: zoom });
}

/** Builds a lat/lon -> pixel projector matching a plan from planView(). */
export function projectorFor(view) {
  return function project(lat, lon) {
    return {
      x: lonToWorldX(lon, view.zoom) - view.originX,
      y: latToWorldY(lat, view.zoom) - view.originY,
    };
  };
}

/** Fills {z}/{x}/{y} (and {s}, for servers that still shard by subdomain). */
export function tileUrl(template, tile, subdomains = '') {
  const list = String(subdomains || '');
  const pick = list ? list[(tile.x + tile.y) % list.length] : '';
  return String(template)
    .replace('{s}', pick)
    .replace('{z}', String(tile.zoom))
    .replace('{x}', String(tile.x))
    .replace('{y}', String(tile.y));
}

/**
 * Draws the basemap into `host`.
 *
 * Resolves once the tiles have settled, with `{ok}` saying whether enough of
 * them arrived to be worth showing. A basemap is a nicety; if the tile server
 * is down, blocked by a network, or simply wrong in config, the caller falls
 * back to the SVG locator rather than showing somebody a grid of broken
 * images. That is why this reports failure instead of throwing.
 *
 * @param {object}  opts
 * @param {Element} opts.host       container; sized by the caller
 * @param {object}  opts.view       a plan from planView()
 * @param {object}  opts.basemap    {url, subdomains, attribution}
 * @param {number}  [opts.timeout]  how long to wait for tiles
 */
export function drawTiles({ host, view, basemap, timeout = 6000 }) {
  const layer = document.createElement('div');
  layer.className = 'pmap__tiles';
  layer.setAttribute('aria-hidden', 'true');

  let loaded = 0;
  let failed = 0;
  const total = view.tiles.length;
  // Declared before the promise below, whose executor runs synchronously and
  // pushes into it.
  const settledCleanup = [];

  const settled = new Promise((resolve) => {
    if (!total) { resolve({ ok: false, loaded: 0, failed: 0, total: 0 }); return; }

    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      // Half the tiles is the line. Some tiles over water or off the edge of
      // a server's coverage legitimately 404, so demanding all of them would
      // throw away a perfectly good map; but a handful out of thirty means
      // the server is not really answering.
      resolve({ ok: loaded > 0 && loaded >= total / 2, loaded, failed, total });
    };
    const tick = () => { if (loaded + failed >= total) finish(); };

    // A server that accepts the connection and then never answers would hang
    // the map forever without this.
    const timer = setTimeout(finish, timeout);
    settledCleanup.push(() => clearTimeout(timer));

    for (const tile of view.tiles) {
      const img = document.createElement('img');
      img.className = 'pmap__tile';
      img.alt = '';
      img.loading = 'eager';
      img.decoding = 'async';
      // Tiles are public map imagery; sending a referrer tells the provider
      // which of somebody's pages they were looking at, which is nobody's
      // business but theirs.
      img.referrerPolicy = 'no-referrer';
      img.width = TILE_SIZE;
      img.height = TILE_SIZE;
      img.style.left = `${tile.left}px`;
      img.style.top = `${tile.top}px`;
      img.addEventListener('load', () => { loaded++; tick(); }, { once: true });
      img.addEventListener('error', () => { failed++; tick(); }, { once: true });
      img.src = tileUrl(basemap.url, tile, basemap.subdomains);
      layer.append(img);
    }
  });

  host.append(layer);

  return {
    layer,
    settled: settled.finally(() => settledCleanup.forEach((fn) => fn())),
    remove: () => layer.remove(),
  };
}
