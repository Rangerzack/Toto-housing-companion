// ---------------------------------------------------------------------------
// Property explorer — the map on the landing page
// ---------------------------------------------------------------------------
// Shows the rentals we can see across the service area, as a map you can
// point at and a list you can read. Both are driven by the same filtered
// array, so they can never disagree about what is available.
//
// WHY THE MAP IS DRAWN HERE RATHER THAN BY A MAP LIBRARY
//
// Leaflet, Mapbox and Google all want either an API key, a tile server, or
// both, and all three put a third-party request on the first page somebody in
// a housing crisis loads. The listings feed also carries no coordinates
// (see geo.js), so a street-level basemap would be promising a precision the
// data does not have: a pin would look like an address while actually being
// the middle of a town.
//
// So the map here is a locator: real positions, real relative distances, a
// scale bar in miles, and no basemap imagery. It costs no dependency, no key
// and no third-party request, it renders instantly, and every pin is a real
// <button> that a keyboard and a screen reader can reach — which marker
// layers famously are not.
//
// TO PUT A REAL BASEMAP UNDER IT LATER: everything about tiles is confined to
// drawBasemap() below. Give it a tile layer (or swap the <svg> for a Leaflet
// container) and the pins, filters, list and dialog keep working unchanged,
// because they only ever ask the projection where a point belongs.

import { el } from './account-ui.js?v=__BUILD__';
import { bedroomsLabel } from './housing.js?v=__BUILD__';
import { listingPoint, boundsFor, makeProjection, countyCentres, milesBetween } from './geo.js?v=__BUILD__';
import { BASEMAP } from './config.js?v=__BUILD__';
import { planFittedView, projectorFor, drawTiles } from './tile-layer.js?v=__BUILD__';

// ---------------------------------------------------------------------------
// Pure logic — no DOM below this line until renderExplorer()
// ---------------------------------------------------------------------------

/** The widest rent band the current listings need, rounded to tidy steps. */
export function rentExtent(listings) {
  const rents = listings.map((l) => l.rent).filter((r) => typeof r === 'number' && r > 0);
  if (!rents.length) return { min: 0, max: 3000 };
  const min = Math.floor(Math.min(...rents) / 50) * 50;
  const max = Math.ceil(Math.max(...rents) / 50) * 50;
  // A single listing, or several at one price, would give a zero-width
  // slider that cannot be moved.
  return { min, max: max > min ? max : min + 500 };
}

/** Every property type present, so the filter never offers an empty option. */
export function typeOptions(listings) {
  return Array.from(new Set(listings.map((l) => l.type).filter(Boolean))).sort();
}

/**
 * Is this listing available now, later, or do we not know?
 *
 * humanizeAvailability() has already turned the feed's mixed status words and
 * dates into a sentence, so this reads that sentence rather than the raw
 * value. "Unknown" is its own answer and is never treated as "no": a listing
 * with no availability note is still a listing somebody can call about.
 */
export function availabilityBucket(listing) {
  const text = listing.availability;
  if (!text) return 'unknown';
  if (/^available now$/i.test(text)) return 'now';
  if (/^available\s/i.test(text)) return 'later';
  return 'unknown';
}

/**
 * Narrows listings to the explorer's filters.
 *
 * The house rule from CLAUDE.md applies here exactly as it does to programs:
 * MISSING INFORMATION NEVER EXCLUDES. A listing with no rent survives a rent
 * filter, one with no bedroom count survives a bedroom filter, and one with
 * no availability note survives "available now". Filters remove what we know
 * does not fit, never what we merely failed to learn.
 */
export function filterListings(listings, filters = {}) {
  const { minRent = null, maxRent = null, beds = null, baths = null,
          type = null, availability = null, county = null, city = null,
          region = null } = filters;

  return listings.filter((listing) => {
    // The region IS known for every listing (the feed is queried per state),
    // so unlike the others this one is a real narrowing, not a guess.
    if (region && String(listing.state || '').toUpperCase() !== region) return false;
    if (listing.rent != null) {
      if (minRent != null && listing.rent < minRent) return false;
      if (maxRent != null && listing.rent > maxRent) return false;
    }
    // Beds and baths are floors, matching how the questionnaire asks them.
    if (beds != null && listing.bedrooms != null && listing.bedrooms < beds) return false;
    if (baths != null && listing.bathrooms != null && listing.bathrooms < baths) return false;
    // A listing with no type stated survives the type filter (it is simply
    // not known to be the wrong kind) — but it still has to pass the rest,
    // so this must not short-circuit out of the function.
    if (type && listing.type && listing.type !== type) return false;
    if (availability && availability !== 'any') {
      const bucket = availabilityBucket(listing);
      if (bucket !== 'unknown' && bucket !== availability) return false;
    }
    if (county && listing.__counties && !listing.__counties.includes(county)) return false;
    if (city && String(listing.city || '').toLowerCase() !== city) return false;
    return true;
  });
}

/**
 * Turns listings into the things the map draws.
 *
 * A listing whose feed record carries real coordinates becomes its own pin.
 * Everything else is grouped by town and shares one pin at the town's centre,
 * because that is the only precision we actually have — a pin per listing
 * would be a row of markers on top of each other pretending to be addresses.
 *
 * Listings in a town we have no coordinate for get no pin at all and are
 * returned in `unplaced`, so the caller can still list them. Missing
 * information never hides a home.
 */
export function buildPins(listings) {
  const pins = [];
  const towns = new Map();
  const unplaced = [];

  for (const listing of listings) {
    const point = listingPoint(listing);
    if (!point) {
      unplaced.push(listing);
      continue;
    }
    if (point.precision === 'exact') {
      pins.push({
        key: `exact:${listing.id ?? listing.name}`,
        lat: point.lat, lon: point.lon, precision: 'exact',
        label: listing.name, city: listing.city, listings: [listing],
      });
      continue;
    }
    const key = `${String(listing.state || '').toUpperCase()}:${String(listing.city || '').toLowerCase()}`;
    if (!towns.has(key)) {
      towns.set(key, {
        key, lat: point.lat, lon: point.lon, precision: 'city',
        label: listing.city, city: listing.city, listings: [],
      });
    }
    towns.get(key).listings.push(listing);
  }

  pins.push(...towns.values());
  // Biggest first, so a busy town is drawn under the small ones rather than
  // hiding them.
  pins.sort((a, b) => b.listings.length - a.listings.length);
  return { pins, unplaced };
}

/**
 * The viewBox for a set of points, shaped to the ground they cover.
 *
 * Picking the height from the data's own aspect ratio means the map is not
 * letterboxed with dead space — Southern Oregon is wide, the Twin Cities
 * suburbs are almost square, and each gets a box that fits it.
 */
export function viewBoxFor(bounds, width = 1000) {
  const midLat = ((bounds.minLat + bounds.maxLat) / 2) * (Math.PI / 180);
  const spanX = (bounds.maxLon - bounds.minLon) * Math.cos(midLat);
  const spanY = bounds.maxLat - bounds.minLat;
  // Clamped to a landscape-ish range. A tight cluster of towns is nearly
  // square on the ground, and an almost-square map beside a short list is
  // mostly empty screen on a laptop and a very long scroll on a phone.
  // The projection letterboxes inside whatever box it is given, so clamping
  // adds margin — it never squashes the geography.
  const height = Math.round(Math.min(720, Math.max(420, (width * spanY) / spanX)));
  return { width, height };
}

// The service areas, and what to call them. Two markets a thousand miles
// apart cannot share one frame: fitting both puts Oregon in one corner,
// Minnesota in the other, and nothing legible in between. So the map shows
// one region at a time and offers a switch.
const REGION_NAMES = { OR: 'Southern Oregon', MN: 'Central Minnesota' };

/** The regions these listings actually cover, busiest first. */
export function regionsIn(listings) {
  const counts = new Map();
  for (const listing of listings) {
    const code = String(listing.state || '').toUpperCase();
    if (!code) continue;
    counts.set(code, (counts.get(code) || 0) + 1);
  }
  return Array.from(counts, ([code, count]) => ({
    code, count, label: REGION_NAMES[code] || code,
  })).sort((a, b) => b.count - a.count);
}

/** A tidy round number of miles that fits inside the map's width. */
export function scaleBarMiles(bounds) {
  const west = { lat: (bounds.minLat + bounds.maxLat) / 2, lon: bounds.minLon };
  const east = { lat: (bounds.minLat + bounds.maxLat) / 2, lon: bounds.maxLon };
  const across = milesBetween(west, east);
  const target = across / 4;
  const steps = [5, 10, 25, 50, 100, 200];
  return steps.find((s) => s >= target) || 200;
}

export function money(value) {
  return value == null ? null : `$${Math.round(value).toLocaleString('en-US')}`;
}

/** "2 bed · 1 bath", skipping whichever the feed did not give us. */
export function sizeLine(listing) {
  const bits = [];
  const beds = bedroomsLabel(listing.bedrooms);
  if (beds) bits.push(beds === 'Studio' ? 'Studio' : `${listing.bedrooms} bed`);
  if (listing.bathrooms != null) {
    bits.push(`${listing.bathrooms} bath${listing.bathrooms === 1 ? '' : 's'}`);
  }
  return bits.join(' · ') || null;
}

/** "Medford, OR" — whatever parts of the place we actually know. */
export function placeLine(listing) {
  return [listing.city, listing.state].filter(Boolean).join(', ') || null;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const SVG_NS = 'http://www.w3.org/2000/svg';

function svg(tag, props = {}, children = []) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (key === 'text') node.textContent = value;
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of [].concat(children)) if (child) node.append(child);
  return node;
}

/**
 * Draws everything under the pins: the ground, a faint graticule, the county
 * names, and a scale bar.
 *
 * THIS IS THE SEAM FOR A REAL BASEMAP. Replace the contents of this function
 * with a tile layer — or return an empty <g> and mount Leaflet on the parent
 * — and nothing else in this module needs to change: the pins are positioned
 * as percentages by the projection, not by anything drawn here.
 */
function drawBasemap({ bounds, box, project, counties }) {
  const layer = svg('svg', {
    class: 'pmap__canvas',
    viewBox: `0 0 ${box.width} ${box.height}`,
    preserveAspectRatio: 'none',
    'aria-hidden': 'true',
    focusable: 'false',
  });

  layer.append(svg('rect', { x: 0, y: 0, width: box.width, height: box.height, class: 'pmap__ground' }));

  // A degree grid, so distance on the picture reads as distance on the
  // ground. Spacing widens for a large area so the lines stay sparse.
  const spanLat = bounds.maxLat - bounds.minLat;
  const stepDeg = spanLat > 3 ? 1 : spanLat > 1.5 ? 0.5 : 0.25;
  const grid = svg('g', { class: 'pmap__grid' });
  for (let lat = Math.ceil(bounds.minLat / stepDeg) * stepDeg; lat < bounds.maxLat; lat += stepDeg) {
    const { y } = project(lat, bounds.minLon);
    grid.append(svg('line', { x1: 0, y1: y, x2: box.width, y2: y }));
  }
  for (let lon = Math.ceil(bounds.minLon / stepDeg) * stepDeg; lon < bounds.maxLon; lon += stepDeg) {
    const { x } = project(bounds.minLat, lon);
    grid.append(svg('line', { x1: x, y1: 0, x2: x, y2: box.height }));
  }
  layer.append(grid);

  // County names, placed at the middle of the towns they contain.
  const labels = svg('g', { class: 'pmap__counties' });
  for (const centre of counties) {
    const { x, y } = project(centre.lat, centre.lon);
    if (x < 0 || x > box.width || y < 0 || y > box.height) continue;
    labels.append(svg('text', { x, y, 'text-anchor': 'middle', text: centre.county.toUpperCase() }));
  }
  layer.append(labels);

  // Scale bar, bottom left.
  const miles = scaleBarMiles(bounds);
  const midLat = (bounds.minLat + bounds.maxLat) / 2;
  const a = project(midLat, bounds.minLon);
  const b = project(midLat, bounds.minLon + 1);
  const pxPerDegLon = b.x - a.x;
  const milesPerDegLon = milesBetween({ lat: midLat, lon: 0 }, { lat: midLat, lon: 1 });
  const barPx = (miles / milesPerDegLon) * pxPerDegLon;
  const barY = box.height - 26;
  const bar = svg('g', { class: 'pmap__scale' });
  bar.append(svg('line', { x1: 20, y1: barY, x2: 20 + barPx, y2: barY }));
  bar.append(svg('line', { x1: 20, y1: barY - 5, x2: 20, y2: barY + 5 }));
  bar.append(svg('line', { x1: 20 + barPx, y1: barY - 5, x2: 20 + barPx, y2: barY + 5 }));
  bar.append(svg('text', { x: 20, y: barY - 10, text: `${miles} miles` }));
  layer.append(bar);

  return layer;
}

function selectField(id, label, options, onChange) {
  const select = el('select', { id, class: 'pfilter__input', onchange: onChange });
  for (const [value, text] of options) select.append(el('option', { value, text }));
  return el('div', { class: 'pfilter' }, [
    el('label', { class: 'pfilter__label', for: id, text: label }),
    select,
  ]);
}

/**
 * Builds the whole explorer into `host`.
 *
 * @param {object}   opts
 * @param {Element}  opts.host            where to render
 * @param {object[]} opts.listings        normalized listings (housing.js)
 * @param {Function} opts.countiesForCity (city, state) -> county names | null
 * @param {Function} opts.onCheckFit      called with a listing when someone
 *                                        presses "Check my fit"
 * @param {Function} [opts.programsFor]   async (listing) -> match rows, used
 *                                        to fill the detail panel's estimate
 */
export function renderExplorer({ host, listings, countiesForCity, onCheckFit, programsFor }) {
  host.replaceChildren();
  if (!listings.length) return null;

  // Counties are resolved once and cached on the record, so the county
  // filter does not re-derive them on every keystroke.
  for (const listing of listings) {
    listing.__counties = listing.county
      ? [listing.county]
      : countiesForCity?.(listing.city, listing.state) || [];
  }

  const extent = rentExtent(listings);
  const regions = regionsIn(listings);
  const filters = {
    minRent: extent.min, maxRent: extent.max,
    beds: null, baths: null, type: null, availability: 'any', city: null,
    // Opens on wherever there is most to show.
    region: regions[0]?.code ?? null,
  };

  // --- Filters -------------------------------------------------------------
  const rentReadout = el('output', { class: 'pfilter__readout', for: 'rent-min rent-max' });
  const rentMin = el('input', {
    type: 'range', id: 'rent-min', class: 'pfilter__range',
    min: extent.min, max: extent.max, step: 25, value: extent.min,
    'aria-label': 'Lowest rent',
  });
  const rentMax = el('input', {
    type: 'range', id: 'rent-max', class: 'pfilter__range',
    min: extent.min, max: extent.max, step: 25, value: extent.max,
    'aria-label': 'Highest rent',
  });
  const onRent = () => {
    // Two sliders on one track: whichever was moved past the other pushes it,
    // so the pair can never cross and read as an empty range.
    let lo = Number(rentMin.value);
    let hi = Number(rentMax.value);
    if (lo > hi) {
      if (document.activeElement === rentMin) hi = lo;
      else lo = hi;
      rentMin.value = String(lo);
      rentMax.value = String(hi);
    }
    filters.minRent = lo;
    filters.maxRent = hi;
    rentReadout.textContent = `${money(lo)} – ${money(hi)}${hi >= extent.max ? '+' : ''} a month`;
    apply();
  };
  rentMin.addEventListener('input', onRent);
  rentMax.addEventListener('input', onRent);

  const bedOptions = [['', 'Any'], ['0', 'Studio +'], ['1', '1 +'], ['2', '2 +'], ['3', '3 +'], ['4', '4 +']];
  const bathOptions = [['', 'Any'], ['1', '1 +'], ['2', '2 +'], ['3', '3 +']];
  const typeList = typeOptions(listings);

  const filterBar = el('form', { class: 'pfilters', onsubmit: (e) => e.preventDefault() }, [
    el('div', { class: 'pfilter pfilter--rent' }, [
      el('span', { class: 'pfilter__label', id: 'rent-label', text: 'Rent a month' }),
      rentReadout,
      el('div', { class: 'pfilter__rangepair' }, [rentMin, rentMax]),
    ]),
    selectField('f-beds', 'Bedrooms', bedOptions, (e) => {
      filters.beds = e.target.value === '' ? null : Number(e.target.value);
      apply();
    }),
    selectField('f-baths', 'Bathrooms', bathOptions, (e) => {
      filters.baths = e.target.value === '' ? null : Number(e.target.value);
      apply();
    }),
    selectField('f-type', 'Property type', [['', 'Any'], ...typeList.map((t) => [t, t])], (e) => {
      filters.type = e.target.value || null;
      apply();
    }),
    selectField('f-avail', 'Available', [['any', 'Any time'], ['now', 'Now'], ['later', 'Later']], (e) => {
      filters.availability = e.target.value;
      apply();
    }),
  ]);

  // --- Region switch -------------------------------------------------------
  // Only worth showing when there is more than one place to switch between.
  const regionBar = el('div', { class: 'pregions', role: 'group', 'aria-label': 'Which area to show' });
  if (regions.length > 1) {
    for (const region of regions) {
      regionBar.append(el('button', {
        type: 'button',
        class: 'pregion',
        'data-region': region.code,
        onclick: () => {
          if (filters.region === region.code) return;
          filters.region = region.code;
          // A town chosen in the old region means nothing in the new one.
          filters.city = null;
          drawMap();
          apply();
        },
      }, [
        el('span', { class: 'pregion__name', text: region.label }),
        el('span', { class: 'pregion__count', text: `${region.count}` }),
      ]));
    }
  } else {
    regionBar.hidden = true;
  }

  // --- Shell ---------------------------------------------------------------
  const count = el('p', { class: 'explorer__count', role: 'status' });
  const townNote = el('p', { class: 'explorer__town', hidden: true });
  const mapHost = el('div', { class: 'pmap', role: 'group', 'aria-label': 'Map of towns with rentals' });
  // Shown only once real tiles are on screen. Every provider requires credit,
  // and crediting a basemap that failed to load would be a lie.
  const attribution = el('p', { class: 'pmap__credit', hidden: true, text: BASEMAP?.attribution || '' });
  const listHost = el('ul', { class: 'plist' });
  const dialog = el('dialog', { class: 'pdialog', id: 'property-dialog', 'aria-labelledby': 'property-dialog-title' });

  host.append(
    regionBar,
    filterBar,
    count,
    townNote,
    el('div', { class: 'explorer__body' }, [
      el('div', { class: 'explorer__mapcol' }, [
        mapHost,
        attribution,
        el('p', {
          class: 'pmap__note',
          text: 'Pins mark the town a rental is in, not its street address. Open a pin to see the addresses.',
        }),
      ]),
      el('div', { class: 'explorer__listcol' }, [listHost]),
    ]),
    dialog,
  );

  // --- The map -------------------------------------------------------------
  // The frame is drawn from every listing in the CURRENT REGION, not from the
  // filtered set: a frame that rescaled on every keystroke would have towns
  // sliding around under the cursor. It is redrawn only when the region
  // changes, which is the one time the ground itself is different.
  const pinLayer = el('div', { class: 'pmap__pins' });
  let box = null;
  let project = null;
  // Bumped on every redraw, so a slow tile load for the region somebody has
  // already switched away from cannot repaint the map underneath them.
  let mapSeq = 0;

  /**
   * Draws the frame for the current region.
   *
   * Two ways to draw it. When a tile provider is configured (BASEMAP in
   * config.js) the pins go over real map imagery, positioned by the Web
   * Mercator maths the tiles themselves use. When one is not — or when the
   * tiles fail to arrive — it falls back to the SVG locator, which needs no
   * network at all. The pins are redrawn either way, because THE TWO
   * PROJECTIONS ARE NOT THE SAME and a pin placed by the wrong one is in the
   * wrong town.
   */
  function drawMap() {
    // A redraw in flight for the previous region must not paint over this one.
    const seq = ++mapSeq;

    const inRegion = filters.region
      ? listings.filter((l) => String(l.state || '').toUpperCase() === filters.region)
      : listings;
    const bounds = boundsFor(inRegion.map(listingPoint).filter(Boolean));

    mapHost.replaceChildren();
    attribution.hidden = true;
    if (!bounds) {
      project = null;
      mapHost.hidden = true;
      return;
    }
    mapHost.hidden = false;

    // Label only the counties this region's listings are actually in. Naming
    // every county we know about would print a wall of words over a map with
    // three pins on it.
    const present = new Set();
    for (const listing of inRegion) {
      for (const county of listing.__counties || []) present.add(county);
    }
    const inBounds = (c) => c.lat >= bounds.minLat && c.lat <= bounds.maxLat
                         && c.lon >= bounds.minLon && c.lon <= bounds.maxLon;
    const centres = countyCentres(filters.region, countiesForCity || (() => null))
      .filter((c) => present.has(c.county))
      .filter(inBounds);

    const drawLocator = () => {
      box = viewBoxFor(bounds);
      project = makeProjection(bounds, { width: box.width, height: box.height, padding: 34 });
      mapHost.style.aspectRatio = `${box.width} / ${box.height}`;
      mapHost.replaceChildren(drawBasemap({ bounds, box, project, counties: centres }), pinLayer);
      mapHost.classList.remove('pmap--tiled');
      renderPins(filterListings(listings, filters));
    };

    if (BASEMAP?.url) {
      const view = planFittedView(bounds, { maxZoom: BASEMAP.maxZoom ?? 13 });
      box = { width: view.width, height: view.height };
      project = projectorFor(view);
      mapHost.style.aspectRatio = `${view.width} / ${view.height}`;
      mapHost.classList.add('pmap--tiled');
      mapHost.append(pinLayer);

      const tiles = drawTiles({ host: mapHost, view, basemap: BASEMAP });
      // Behind the pins, whatever order the DOM ended up in.
      mapHost.prepend(tiles.layer);
      renderPins(filterListings(listings, filters));

      tiles.settled.then((result) => {
        if (seq !== mapSeq) return;
        if (result.ok) {
          attribution.hidden = false;
          return;
        }
        // Not enough tiles arrived to be a map. Fall back rather than leave
        // somebody looking at a grid of broken images.
        tiles.remove();
        drawLocator();
      });
    } else {
      drawLocator();
    }

    for (const button of regionBar.querySelectorAll('.pregion')) {
      const on = button.dataset.region === filters.region;
      button.classList.toggle('is-on', on);
      button.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
  }

  // --- Rendering the filtered set -----------------------------------------
  function renderPins(visible) {
    pinLayer.replaceChildren();
    if (!project) return;
    const { pins } = buildPins(visible);
    const biggest = Math.max(1, ...pins.map((p) => p.listings.length));

    // Towns close together would print their names on top of each other —
    // Medford and Central Point are seven miles apart. Pins are already
    // sorted busiest-first, so the busier town keeps its label and a
    // near neighbour goes without; its name is still on every card in the
    // list, and on the pin's own accessible label.
    const labelled = [];
    const LABEL_GAP = 9; // percent of the map's width

    for (const pin of pins) {
      const { x, y } = project(pin.lat, pin.lon);
      const px = (x / box.width) * 100;
      const py = (y / box.height) * 100;
      const crowded = labelled.some(
        (other) => Math.abs(other.px - px) < LABEL_GAP && Math.abs(other.py - py) < LABEL_GAP,
      );
      if (!crowded) labelled.push({ px, py });

      // Area, not radius, tracks the count — doubling the listings should
      // look like twice as much, and a radius would look like four times.
      const size = 22 + 20 * Math.sqrt(pin.listings.length / biggest);
      const selected = filters.city === String(pin.city || '').toLowerCase();
      const button = el('button', {
        type: 'button',
        // Town pins carry a halo: over a street map, a hard dot reads as a
        // building, and for all but the rare listing that ships its own
        // coordinates we only know the town. The halo is the honest shape for
        // "somewhere in here" — see geo.js.
        class: `pmap__pin pmap__pin--${pin.precision}${selected ? ' is-selected' : ''}`,
        style: `left:${px}%;top:${py}%;--pin-size:${size.toFixed(1)}px`,
        'aria-pressed': selected ? 'true' : 'false',
        'aria-label': `${pin.label}: ${pin.listings.length} rental${pin.listings.length === 1 ? '' : 's'}`,
        // A pin whose name label was suppressed for crowding still has to be
        // identifiable with a mouse, not only with a screen reader.
        title: `${pin.label} — ${pin.listings.length} rental${pin.listings.length === 1 ? '' : 's'}`,
        onclick: () => {
          const key = String(pin.city || '').toLowerCase();
          filters.city = filters.city === key ? null : key;
          apply();
          if (filters.city) listHost.parentElement.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        },
      }, [
        el('span', { class: 'pmap__pincount', text: String(pin.listings.length) }),
        crowded ? null : el('span', { class: 'pmap__pinname', text: pin.label || '' }),
      ]);
      pinLayer.append(button);
    }
  }

  function renderList(visible) {
    listHost.replaceChildren();
    for (const listing of visible.slice(0, 60)) {
      const rent = listing.rent != null ? money(listing.rent) : 'Rent not listed';
      listHost.append(el('li', { class: 'plist__item' }, [
        el('button', {
          type: 'button', class: 'pcard', onclick: () => openDetail(listing),
        }, [
          el('span', { class: 'pcard__rent' }, [
            el('strong', { text: rent }),
            listing.rent != null ? el('span', { class: 'pcard__per', text: '/mo' }) : null,
          ]),
          el('span', { class: 'pcard__name', text: listing.name }),
          el('span', { class: 'pcard__meta', text: [sizeLine(listing), listing.type].filter(Boolean).join(' · ') || 'Size not listed' }),
          el('span', { class: 'pcard__place', text: placeLine(listing) || '' }),
          listing.availability
            ? el('span', { class: `pcard__avail pcard__avail--${availabilityBucket(listing)}`, text: listing.availability })
            : null,
        ]),
      ]));
    }
    if (visible.length > 60) {
      listHost.append(el('li', { class: 'plist__more', text: `+ ${visible.length - 60} more — narrow the filters to see them.` }));
    }
    if (!visible.length) {
      listHost.append(el('li', { class: 'plist__empty' }, [
        el('p', { text: 'No rentals match those filters right now.' }),
        el('button', {
          type: 'button', class: 'btn btn--ghost btn--sm', text: 'Clear the filters',
          onclick: reset,
        }),
      ]));
    }
  }

  function apply() {
    const visible = filterListings(listings, filters);
    // "of N" counts the region being looked at, not the whole feed: saying
    // "6 of 40" while showing Minnesota would be counting Oregon's rentals
    // as ones the filters removed.
    const inRegion = filters.region
      ? listings.filter((l) => String(l.state || '').toUpperCase() === filters.region)
      : listings;
    const total = inRegion.length;
    const where = REGION_NAMES[filters.region] || 'the service area';
    count.textContent =
      visible.length === total
        ? `${total} rental${total === 1 ? '' : 's'} in ${where}`
        : `Showing ${visible.length} of ${total} rentals in ${where}`;

    if (filters.city) {
      const name = listings.find((l) => String(l.city || '').toLowerCase() === filters.city)?.city;
      townNote.replaceChildren(
        el('span', { text: `Showing ${name} only. ` }),
        el('button', { type: 'button', class: 'linkish', text: 'Show every town', onclick: () => { filters.city = null; apply(); } }),
      );
      townNote.hidden = false;
    } else {
      townNote.hidden = true;
    }

    renderPins(visible);
    renderList(visible);
  }

  function reset() {
    filters.minRent = extent.min;
    filters.maxRent = extent.max;
    filters.beds = filters.baths = filters.type = null;
    filters.availability = 'any';
    filters.city = null;
    rentMin.value = String(extent.min);
    rentMax.value = String(extent.max);
    for (const id of ['f-beds', 'f-baths', 'f-type']) filterBar.querySelector('#' + id).value = '';
    filterBar.querySelector('#f-avail').value = 'any';
    onRent();
  }

  // --- Detail --------------------------------------------------------------
  function openDetail(listing) {
    const programs = el('div', { class: 'pdetail__programs' }, [
      el('p', { class: 'pdetail__loading', text: 'Working out which programs could help with this rent…' }),
    ]);

    // Same shell as the program dialog (app.js): one dialog language on the
    // site, so the close button is where somebody already learned it is.
    dialog.replaceChildren(
      el('div', { class: 'pdialog__top' }, [
        el('span', {
          class: 'pdetail__rent',
          text: listing.rent != null ? `${money(listing.rent)} a month` : 'Rent not listed',
        }),
        el('button', {
          type: 'button', class: 'pdialog__close', 'aria-label': 'Close', text: '✕',
          onclick: () => dialog.close(),
        }),
      ]),
      el('div', { class: 'pdetail' }, [
        el('h3', { class: 'pdetail__name', id: 'property-dialog-title', text: listing.name }),
        el('p', { class: 'pdetail__place', text: [listing.address, listing.city, listing.state, listing.zip].filter(Boolean).join(', ') }),
        el('dl', { class: 'pdetail__facts' }, [
          ...factRow('Type', listing.type),
          ...factRow('Size', sizeLine(listing)),
          ...factRow('Availability', listing.availability),
          ...factRow('County', listing.__counties?.join(' or ') || null),
          ...factRow('Income restricted', listing.subsidized ? 'Yes — rent is set from your income' : null),
        ]),
        programs,
        el('div', { class: 'pdetail__actions' }, [
          el('button', {
            type: 'button', class: 'btn btn--primary', text: 'Check my fit for this rent',
            onclick: () => { dialog.close(); onCheckFit?.(listing); },
          }),
          listing.phone ? el('a', { class: 'btn btn--ghost', href: `tel:${String(listing.phone).replace(/[^\d+]/g, '')}`, text: `Call ${listing.phone}` }) : null,
          listing.url ? el('a', { class: 'btn btn--ghost', href: listing.url, target: '_blank', rel: 'noopener noreferrer', text: 'View the listing' }) : null,
        ]),
      ]),
    );
    dialog.showModal();
    dialog.querySelector('.pdialog__close')?.focus();

    // The estimate is filled in after the dialog is already open, so a slow
    // limits fetch never delays somebody seeing the home itself.
    programsFor?.(listing)
      .then((rows) => {
        if (!dialog.open) return;
        programs.replaceChildren(...renderEstimate(rows, listing));
      })
      .catch(() => {
        if (!dialog.open) return;
        programs.replaceChildren(
          el('p', { class: 'pdetail__loading', text: 'We could not work out program matches just now — the full questionnaire still can.' }),
        );
      });
  }

  function factRow(label, value) {
    if (!value) return [];
    return [el('dt', { text: label }), el('dd', { text: value })];
  }

  function renderEstimate(rows, listing) {
    if (!rows || !rows.length) {
      return [el('p', { class: 'pdetail__loading', text: 'Answer a few questions to see which programs could help with this rent.' })];
    }
    return [
      el('h4', { class: 'pdetail__subhead', text: `Programs that may help with rent in ${listing.city || 'this area'}` }),
      el('ul', { class: 'pdetail__proglist' }, rows.slice(0, 4).map((row) =>
        el('li', {}, [
          el('span', { class: 'pdetail__progname', text: row.program.program_name }),
          el('span', { class: 'pdetail__progwhy', text: row.label }),
        ]),
      )),
      el('p', { class: 'pdetail__caveat', text: 'Based on where this home is, not on your household yet — answer a few questions to narrow it.' }),
    ];
  }

  drawMap();
  onRent();
  return { apply, reset, drawMap, filters };
}
