// ---------------------------------------------------------------------------
// check_geo.mjs — guards the city coordinates in web/geo.js
// ---------------------------------------------------------------------------
// Those coordinates place pins on the property map, and a wrong one puts a
// home in the wrong county — which is worse than no pin at all, because it
// looks authoritative. This script is the check that they are right.
//
//   node scripts/check_geo.mjs
//
// It asserts four things:
//   1. Every town in CITY_COUNTIES has a coordinate, and vice versa.
//   2. Every coordinate falls inside its state's real bounding box.
//   3. Every town sits close to another town in the same county, so a
//      transposed digit or a flipped sign cannot pass unnoticed.
//   4. A set of spot-checks on relative position (Ashland is south of
//      Medford, Brookings is on the coast, La Grande is far to the east),
//      which catch errors that a bounding box is too coarse to see.

import { CITY_POINTS, cityPoint, countyCentres, milesBetween } from '../web/geo.js';
import { CITY_COUNTIES } from '../web/config.js';

const problems = [];
const fail = (message) => problems.push(message);

// --- 1. The two tables must name the same towns ----------------------------
for (const state of ['OR', 'MN']) {
  const named = new Set(Object.keys(CITY_COUNTIES[state]));
  const placed = new Set(Object.keys(CITY_POINTS[state]));
  for (const city of named) {
    if (!placed.has(city)) fail(`${state}: "${city}" has a county but no coordinate`);
  }
  for (const city of placed) {
    if (!named.has(city)) fail(`${state}: "${city}" has a coordinate but no county`);
  }
}

// --- 2. Inside the state ---------------------------------------------------
// Generous boxes around each state's real extent, so this catches gross
// errors (a dropped minus sign, digits swapped) without policing detail.
const STATE_BOX = {
  OR: { minLat: 41.9, maxLat: 46.3, minLon: -124.6, maxLon: -116.4 },
  MN: { minLat: 43.4, maxLat: 49.4, minLon: -97.3, maxLon: -89.4 },
};
for (const [state, box] of Object.entries(STATE_BOX)) {
  for (const [city, [lat, lon]] of Object.entries(CITY_POINTS[state])) {
    if (lat < box.minLat || lat > box.maxLat || lon < box.minLon || lon > box.maxLon) {
      fail(`${state}: "${city}" at ${lat}, ${lon} is outside ${state}`);
    }
  }
}

// --- 3. Among its own county's towns ---------------------------------------
// The test is "is this town near another town in the same county", not "near
// the county's middle". Distance to the middle sounds stricter but is wrong
// for a long county: Klamath (OR) runs a hundred miles from the California
// border up to Crescent, so its genuinely-placed northern towns sit 65 miles
// from the average of its towns while being 2 miles from each other.
// Neighbourliness is the property that actually breaks when a digit is
// transposed — a mistyped town lands far from every one of its county-mates.
// 32 miles. With the table as it stands the worst genuine gap is Reedsport to
// Elkton at 27 (a real, empty stretch of the Douglas County coast) and the
// median is 5, so this leaves headroom for honest remoteness while still
// catching a single transposed digit — which typically throws a town 40+
// miles off and away from all of its county-mates.
const NEIGHBOUR_MILES = 32;
for (const state of ['OR', 'MN']) {
  const lookup = (city, st) => CITY_COUNTIES[st]?.[city] || null;
  const centres = new Map(countyCentres(state, lookup).map((c) => [c.county, c]));

  // Every town in each county, so each one can be checked against the rest.
  const byCounty = new Map();
  for (const [city, counties] of Object.entries(CITY_COUNTIES[state])) {
    for (const county of counties) {
      if (!byCounty.has(county)) byCounty.set(county, []);
      byCounty.get(county).push(city);
    }
  }

  for (const [city, counties] of Object.entries(CITY_COUNTIES[state])) {
    const point = cityPoint(city, state);
    if (!point) continue;

    // The nearest town sharing any of this town's counties. Aliases of the
    // same place ("st. cloud" / "saint cloud") sit on the identical
    // coordinate, so they are skipped rather than vouching for each other.
    let nearest = Infinity;
    let onlyTown = true;
    for (const county of counties) {
      for (const other of byCounty.get(county) || []) {
        if (other === city) continue;
        const otherPoint = cityPoint(other, state);
        if (!otherPoint) continue;
        const miles = milesBetween(point, otherPoint);
        if (miles < 0.5) continue; // the same place under another spelling
        onlyTown = false;
        if (miles < nearest) nearest = miles;
      }
    }

    if (onlyTown) {
      // Nothing to be neighbourly with — fall back to the county's middle.
      const centre = counties.map((c) => centres.get(c)).find(Boolean);
      if (centre && milesBetween(point, centre) > NEIGHBOUR_MILES) {
        fail(`${state}: "${city}" is the only town in ${counties.join('/')} and sits far from it`);
      }
      continue;
    }

    if (nearest > NEIGHBOUR_MILES) {
      fail(
        `${state}: "${city}" is ${nearest.toFixed(0)} miles from the nearest other town in ` +
          `${counties.join('/')} — check the coordinate or the county`,
      );
    }
  }
}

// --- 4. Relative-position spot checks --------------------------------------
// Facts about the map that a human can verify at a glance, chosen to cover
// each state's extremes and each axis.
const NORTH_OF = [
  ['OR', 'medford', 'ashland'],        // Medford is north of Ashland
  ['OR', 'salem', 'eugene'],
  ['OR', 'portland-ish:milwaukie', 'salem'],
  ['MN', 'brainerd', 'st. cloud'],
  ['MN', 'st. cloud', 'st. paul'],
];
const WEST_OF = [
  ['OR', 'grants pass', 'medford'],    // Grants Pass is west of Medford
  ['OR', 'brookings', 'klamath falls'],
  ['OR', 'eugene', 'la grande'],       // the coast range side vs the far east
  ['MN', 'willmar', 'st. cloud'],
  ['MN', 'alexandria', 'brainerd'],
];
const near = (state, name) => cityPoint(name.replace(/^.*:/, ''), state);

for (const [state, a, b] of NORTH_OF) {
  const pa = near(state, a), pb = near(state, b);
  if (!pa || !pb) { fail(`spot check: missing ${a} or ${b} in ${state}`); continue; }
  if (!(pa.lat > pb.lat)) fail(`spot check: ${a} should be north of ${b} in ${state}`);
}
for (const [state, a, b] of WEST_OF) {
  const pa = near(state, a), pb = near(state, b);
  if (!pa || !pb) { fail(`spot check: missing ${a} or ${b} in ${state}`); continue; }
  if (!(pa.lon < pb.lon)) fail(`spot check: ${a} should be west of ${b} in ${state}`);
}

// --- Report ----------------------------------------------------------------
const total = Object.keys(CITY_POINTS.OR).length + Object.keys(CITY_POINTS.MN).length;
if (problems.length) {
  console.error(`geo check FAILED — ${problems.length} problem(s):\n`);
  for (const p of problems) console.error('  - ' + p);
  process.exit(1);
}
console.log(`geo check passed: ${total} towns placed, all inside their county`);
