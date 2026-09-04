// ---------------------------------------------------------------------------
// Geography for the property explorer
// ---------------------------------------------------------------------------
// The property map needs a position for every listing. The Range Lab feed
// gives us `city` and `state` and nothing else — no county, no coordinates —
// so this module is where a place name becomes a point on a map.
//
// Two sources, in this order:
//
//   1. Coordinates on the listing itself. If the feed ever starts sending
//      lat/lon they win outright, and every pin becomes street-accurate with
//      no change here (housing.js already maps the usual field names).
//   2. The CITY_POINTS table below — the centre of the town, hand-checked
//      against the county each town sits in (see scripts/check_geo.mjs, which
//      fails the build if a town is plotted outside its county's cluster).
//
// A city-centre pin is an APPROXIMATION and the map says so out loud. It is
// never presented as the address, and the detail panel shows the real street
// address when the feed carries one. A town missing from this table is still
// LISTED — it just has no pin. Missing information never hides a home, the
// same rule the county filter follows in config.js.
//
// Coordinates are [latitude, longitude] in decimal degrees. Longitudes are
// negative: everything here is west of the prime meridian.

export const CITY_POINTS = {
  OR: {
    // Jackson
    'medford': [42.327, -122.876], 'ashland': [42.195, -122.709],
    'central point': [42.376, -122.916], 'eagle point': [42.472, -122.803],
    'talent': [42.245, -122.788], 'phoenix': [42.274, -122.818],
    'jacksonville': [42.314, -122.968], 'white city': [42.433, -122.858],
    'shady cove': [42.611, -122.812], 'gold hill': [42.431, -123.053],
    'rogue river': [42.437, -123.173], 'butte falls': [42.544, -122.567],
    'prospect': [42.752, -122.492],
    // Josephine
    'grants pass': [42.439, -123.331], 'cave junction': [42.163, -123.648],
    'merlin': [42.517, -123.422], 'selma': [42.277, -123.596],
    'williams': [42.221, -123.288], 'wolf creek': [42.681, -123.393],
    'kerby': [42.198, -123.655], "o'brien": [42.058, -123.708],
    'murphy': [42.340, -123.339],
    // Douglas
    'roseburg': [43.217, -123.342], 'sutherlin': [43.388, -123.313],
    'winston': [43.122, -123.418], 'myrtle creek': [43.021, -123.293],
    'canyonville': [42.927, -123.281], 'riddle': [42.951, -123.363],
    'oakland': [43.423, -123.297], 'drain': [43.659, -123.317],
    'yoncalla': [43.599, -123.283], 'reedsport': [43.702, -124.096],
    'glide': [43.298, -123.100], 'elkton': [43.633, -123.566],
    // Klamath
    'klamath falls': [42.225, -121.782], 'altamont': [42.205, -121.737],
    'chiloquin': [42.578, -121.866], 'merrill': [42.024, -121.599],
    'malin': [42.012, -121.407], 'bonanza': [42.196, -121.412],
    'gilchrist': [43.489, -121.687], 'crescent': [43.462, -121.693],
    // Curry
    'brookings': [42.053, -124.284], 'gold beach': [42.407, -124.421],
    'port orford': [42.745, -124.498], 'harbor': [42.046, -124.271],
    // Coos
    'coos bay': [43.367, -124.217], 'north bend': [43.407, -124.224],
    'coquille': [43.178, -124.188], 'bandon': [43.119, -124.408],
    'myrtle point': [43.065, -124.140], 'lakeside': [43.578, -124.177],
    'powers': [42.887, -124.071],
    // Lane
    'eugene': [44.052, -123.087], 'springfield': [44.046, -123.022],
    'cottage grove': [43.798, -123.060], 'florence': [43.983, -124.100],
    'junction city': [44.219, -123.206], 'creswell': [43.918, -123.025],
    'veneta': [44.048, -123.351], 'oakridge': [43.746, -122.461],
    'lowell': [43.920, -122.782], 'coburg': [44.137, -123.057],
    'dunes city': [43.888, -124.113], 'westfir': [43.757, -122.494],
    // Linn
    'albany': [44.637, -123.106], 'lebanon': [44.536, -122.907],
    'sweet home': [44.397, -122.736], 'harrisburg': [44.273, -123.174],
    'brownsville': [44.393, -123.008], 'scio': [44.703, -122.848],
    'halsey': [44.382, -123.108], 'tangent': [44.543, -123.108],
    'lyons': [44.777, -122.612], 'mill city': [44.750, -122.478],
    'gates': [44.753, -122.418],
    // Lincoln
    'newport': [44.637, -124.053], 'lincoln city': [44.958, -124.017],
    'toledo': [44.622, -123.938], 'waldport': [44.426, -124.070],
    'depoe bay': [44.809, -124.061], 'yachats': [44.311, -124.104],
    'siletz': [44.721, -123.919],
    // Marion
    'salem': [44.943, -123.035], 'keizer': [44.993, -123.026],
    'woodburn': [45.144, -122.856], 'silverton': [45.005, -122.783],
    'stayton': [44.801, -122.795], 'aumsville': [44.840, -122.871],
    'turner': [44.843, -122.955], 'mount angel': [45.069, -122.801],
    'hubbard': [45.182, -122.809], 'gervais': [45.109, -122.897],
    'jefferson': [44.720, -123.013], 'sublimity': [44.829, -122.792],
    'aurora': [45.230, -122.754], 'scotts mills': [45.049, -122.662],
    'detroit': [44.734, -122.150], 'idanha': [44.699, -122.070],
    // Clackamas
    'oregon city': [45.357, -122.607], 'milwaukie': [45.446, -122.639],
    'west linn': [45.366, -122.612], 'happy valley': [45.447, -122.507],
    'canby': [45.263, -122.693], 'gladstone': [45.379, -122.594],
    'molalla': [45.147, -122.578], 'sandy': [45.397, -122.262],
    'estacada': [45.289, -122.334], 'damascus': [45.416, -122.452],
    'lake oswego': [45.421, -122.670], 'wilsonville': [45.301, -122.771],
    // Union
    'la grande': [45.325, -118.088], 'union': [45.209, -117.865],
    'elgin': [45.565, -117.918], 'cove': [45.297, -117.809],
    'imbler': [45.457, -117.963], 'north powder': [45.032, -117.921],
    'summerville': [45.530, -118.000], 'island city': [45.343, -118.049],
  },
  MN: {
    // Stearns
    'st. cloud': [45.558, -94.163], 'saint cloud': [45.558, -94.163],
    'sartell': [45.622, -94.207], 'waite park': [45.557, -94.228],
    'sauk centre': [45.737, -94.952], 'cold spring': [45.456, -94.429],
    'albany': [45.630, -94.570], 'melrose': [45.674, -94.808],
    'paynesville': [45.381, -94.712], 'st. joseph': [45.565, -94.318],
    'saint joseph': [45.565, -94.318], 'kimball': [45.313, -94.301],
    'richmond': [45.453, -94.519], 'rockville': [45.462, -94.341],
    'holdingford': [45.731, -94.470],
    // Benton
    'sauk rapids': [45.593, -94.166], 'foley': [45.665, -93.910],
    'rice': [45.752, -94.221], 'gilman': [45.769, -93.949],
    // Sherburne
    'elk river': [45.304, -93.567], 'big lake': [45.332, -93.746],
    'becker': [45.393, -93.877], 'zimmerman': [45.443, -93.590],
    'clear lake': [45.443, -93.993],
    // Morrison
    'little falls': [45.976, -94.363], 'pierz': [45.982, -94.104],
    'royalton': [45.830, -94.294], 'randall': [46.089, -94.504],
    'swanville': [45.912, -94.641], 'upsala': [45.810, -94.572],
    'motley': [46.336, -94.647],
    // Wright
    'buffalo': [45.172, -93.875], 'monticello': [45.306, -93.794],
    'otsego': [45.274, -93.596], 'st. michael': [45.210, -93.665],
    'saint michael': [45.210, -93.665], 'albertville': [45.238, -93.654],
    'delano': [45.041, -93.789], 'annandale': [45.263, -94.124],
    'maple lake': [45.230, -94.000], 'cokato': [45.076, -94.190],
    'howard lake': [45.060, -94.073], 'montrose': [45.064, -93.911],
    'waverly': [45.067, -93.966], 'clearwater': [45.419, -94.049],
    // Todd
    'long prairie': [45.974, -94.865], 'browerville': [46.089, -94.868],
    'clarissa': [46.129, -94.949], 'bertha': [46.267, -95.063],
    'eagle bend': [46.165, -95.038], 'grey eagle': [45.824, -94.746],
    'staples': [46.355, -94.792],
    // Mille Lacs
    'milaca': [45.755, -93.654], 'isle': [46.137, -93.472],
    'onamia': [46.071, -93.668], 'foreston': [45.732, -93.711],
    'pease': [45.699, -93.649], 'wahkon': [46.119, -93.522],
    'princeton': [45.570, -93.581],
    // Isanti
    'cambridge': [45.573, -93.224], 'isanti': [45.490, -93.248],
    'braham': [45.723, -93.172],
    // Kanabec
    'mora': [45.877, -93.294], 'ogilvie': [45.831, -93.427],
    // Crow Wing
    'brainerd': [46.358, -94.201], 'baxter': [46.343, -94.287],
    'crosby': [46.482, -93.957], 'pequot lakes': [46.603, -94.309],
    'crosslake': [46.664, -94.113], 'nisswa': [46.521, -94.288],
    'ironton': [46.477, -93.977], 'deerwood': [46.473, -93.898],
    'emily': [46.731, -93.958], 'breezy point': [46.596, -94.219],
    // Chisago
    'north branch': [45.511, -92.980], 'wyoming': [45.336, -92.997],
    'chisago city': [45.373, -92.890], 'lindstrom': [45.389, -92.847],
    'center city': [45.393, -92.816], 'taylors falls': [45.402, -92.652],
    'rush city': [45.686, -92.965], 'stacy': [45.398, -92.987],
    'shafer': [45.386, -92.748], 'harris': [45.586, -92.972],
    // Kandiyohi
    'willmar': [45.122, -95.043], 'new london': [45.301, -94.944],
    'spicer': [45.232, -94.940], 'atwater': [45.139, -94.779],
    'kandiyohi': [45.132, -94.930], 'pennock': [45.148, -95.174],
    'prinsburg': [44.936, -95.187], 'lake lillian': [44.944, -94.879],
    // Douglas
    'alexandria': [45.885, -95.378], 'brandon': [45.965, -95.598],
    'evansville': [46.003, -95.683], 'carlos': [45.972, -95.289],
    'garfield': [45.941, -95.492], 'miltona': [46.045, -95.291],
    'kensington': [45.779, -95.696], 'forada': [45.797, -95.351],
    'osakis': [45.868, -95.152],
    // Pope
    'glenwood': [45.650, -95.389], 'starbuck': [45.614, -95.532],
    'villard': [45.712, -95.270], 'lowry': [45.705, -95.517],
    'cyrus': [45.615, -95.737], 'long beach': [45.647, -95.362],
    // Cass
    'walker': [47.101, -94.587], 'pine river': [46.719, -94.402],
    'cass lake': [47.379, -94.603], 'backus': [46.820, -94.516],
    'hackensack': [46.930, -94.521], 'pillager': [46.330, -94.473],
    'east gull lake': [46.400, -94.353], 'lake shore': [46.477, -94.360],
    'longville': [46.987, -94.212], 'remer': [47.056, -93.918],
    // Ramsey
    'st. paul': [44.954, -93.090], 'saint paul': [44.954, -93.090],
    'roseville': [45.006, -93.156], 'maplewood': [44.953, -92.995],
    'shoreview': [45.079, -93.147], 'new brighton': [45.065, -93.202],
    'mounds view': [45.105, -93.208], 'north st. paul': [45.012, -92.993],
    'north saint paul': [45.012, -92.993], 'little canada': [45.027, -93.088],
    'vadnais heights': [45.058, -93.073], 'arden hills': [45.070, -93.157],
    'falcon heights': [44.992, -93.166], 'lauderdale': [44.994, -93.203],
    'gem lake': [45.059, -93.036], 'north oaks': [45.104, -93.089],
    'white bear lake': [45.085, -93.010],
  },
};

/** Normalizes a place name the way CITY_COUNTIES keys are written. */
function cityKey(city) {
  return String(city ?? '').trim().toLowerCase();
}

/**
 * The centre of a town, or null if we have not mapped it.
 *
 * Null is a normal answer, not a failure: the caller lists the property
 * anyway and simply gives it no pin.
 */
export function cityPoint(city, state) {
  const table = CITY_POINTS[String(state ?? '').toUpperCase()];
  if (!table) return null;
  const point = table[cityKey(city)];
  return point ? { lat: point[0], lon: point[1], precision: 'city' } : null;
}

/**
 * Where to draw one listing.
 *
 * Coordinates carried by the feed itself are exact and win; otherwise we fall
 * back to the middle of the town. `precision` travels with the point so the
 * UI can be honest about which of the two it is showing.
 */
export function listingPoint(listing) {
  if (!listing) return null;
  const lat = Number(listing.lat);
  const lon = Number(listing.lon);
  if (Number.isFinite(lat) && Number.isFinite(lon) && (lat !== 0 || lon !== 0)) {
    return { lat, lon, precision: 'exact' };
  }
  return cityPoint(listing.city, listing.state);
}

/** The smallest lat/lon box containing every point, plus a margin. */
export function boundsFor(points, margin = 0.08) {
  const usable = points.filter((p) => p && Number.isFinite(p.lat) && Number.isFinite(p.lon));
  if (!usable.length) return null;

  let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
  for (const p of usable) {
    if (p.lat < minLat) minLat = p.lat;
    if (p.lat > maxLat) maxLat = p.lat;
    if (p.lon < minLon) minLon = p.lon;
    if (p.lon > maxLon) maxLon = p.lon;
  }

  // A single town, or several in one place, would collapse the box to a point
  // and divide by zero below. Give it a degree of breathing room instead.
  const latPad = Math.max((maxLat - minLat) * margin, 0.12);
  const lonPad = Math.max((maxLon - minLon) * margin, 0.12);
  return {
    minLat: minLat - latPad, maxLat: maxLat + latPad,
    minLon: minLon - lonPad, maxLon: maxLon + lonPad,
  };
}

const RAD = Math.PI / 180;

/**
 * Builds a lat/lon -> SVG coordinate function for one box.
 *
 * Equirectangular, with the standard cos(latitude) correction on x: a degree
 * of longitude is only ~0.7 of a degree of latitude at 45°N, and without the
 * correction Oregon comes out visibly stretched sideways. The result is
 * letterboxed inside the requested size so the aspect ratio of the real
 * ground is preserved rather than squashed to fill the box.
 */
export function makeProjection(bounds, { width, height, padding = 16 } = {}) {
  if (!bounds) return null;

  const midLat = (bounds.minLat + bounds.maxLat) / 2;
  const scaleLon = Math.cos(midLat * RAD);

  const spanX = (bounds.maxLon - bounds.minLon) * scaleLon;
  const spanY = bounds.maxLat - bounds.minLat;
  const boxW = width - padding * 2;
  const boxH = height - padding * 2;
  // One scale for both axes keeps the picture geographically honest.
  const scale = Math.min(boxW / spanX, boxH / spanY);
  const offsetX = padding + (boxW - spanX * scale) / 2;
  const offsetY = padding + (boxH - spanY * scale) / 2;

  return function project(lat, lon) {
    return {
      x: offsetX + (lon - bounds.minLon) * scaleLon * scale,
      // SVG y grows downward; latitude grows north, so it is flipped.
      y: offsetY + (bounds.maxLat - lat) * scale,
    };
  };
}

/**
 * Label positions for the counties on screen, averaged from the towns we have
 * mapped in each. Derived rather than tabulated so a county label can never
 * drift away from the towns it names.
 */
export function countyCentres(state, countiesForCity) {
  const table = CITY_POINTS[String(state ?? '').toUpperCase()];
  if (!table) return [];

  const groups = new Map();
  for (const [city, [lat, lon]] of Object.entries(table)) {
    for (const county of countiesForCity(city, state) || []) {
      if (!groups.has(county)) groups.set(county, []);
      groups.get(county).push({ lat, lon });
    }
  }

  return Array.from(groups, ([county, points]) => ({
    county,
    lat: points.reduce((sum, p) => sum + p.lat, 0) / points.length,
    lon: points.reduce((sum, p) => sum + p.lon, 0) / points.length,
    towns: points.length,
  }));
}

/** Great-circle-ish distance in miles. Good enough for sanity checks. */
export function milesBetween(a, b) {
  const midLat = ((a.lat + b.lat) / 2) * RAD;
  const dLat = (a.lat - b.lat) * 69.0;
  const dLon = (a.lon - b.lon) * 69.0 * Math.cos(midLat);
  return Math.sqrt(dLat * dLat + dLon * dLon);
}
