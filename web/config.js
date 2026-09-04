// ---------------------------------------------------------------------------
// Connection settings
// ---------------------------------------------------------------------------
// The anon key is designed to be public — it is safe in frontend code because
// the tables are protected by the row-level security policies in
// supabase/migrations/0002_rls_public_read.sql (public SELECT only, no writes).
//
// Get it from: Supabase dashboard -> Project Settings -> API -> "anon public".
export const SUPABASE_URL = 'https://vhhcicawkhokncnhzboe.supabase.co';
export const SUPABASE_ANON_KEY = 'sb_publishable_uWoahvwMH3VYZ7n2egHi8Q_AJBUSZjQ';

export const FORMS_BUCKET = 'intake-forms';

// ---------------------------------------------------------------------------
// Housing search API
// ---------------------------------------------------------------------------
// The rental-search path ("Help finding a place") reads listings via the
// housing-search edge function (supabase/functions/housing-search), never
// from the housing data API directly: this file ships to every browser, so
// the API's private key cannot live here. The function holds the key and the
// real endpoint as Supabase secrets and proxies the request — see the
// "rental search" section of web/README.md for the one-time setup.
//
// `{state}` and `{county}` are replaced with the person's answers before the
// request is made; the function forwards them to the real API the same way.
export const HOUSING_API_URL =
  `${SUPABASE_URL}/functions/v1/housing-search?state={state}&county={county}`;

// The public anon key, same as every other Supabase call this app makes.
export const HOUSING_API_HEADERS = {
  apikey: SUPABASE_ANON_KEY,
  Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
};

// ---------------------------------------------------------------------------
// Basemap for the property map
// ---------------------------------------------------------------------------
// The property explorer draws its own tile layer (web/tile-layer.js) — no
// Leaflet, no MapLibre, no API of its own. All it needs is a raster tile URL
// with {z}/{x}/{y} in it.
//
// LEAVE THIS null AND NOTHING BREAKS. The map falls back to the dependency-
// free SVG locator it has always used: real positions, real distances, no
// third-party request. Setting it adds street context under the same pins.
//
// It ships null on purpose. Every tile provider that was keyless and reliable
// has since changed:
//
//   OpenFreeMap        Free, no key, no limits — but VECTOR tiles only, which
//                      need MapLibre GL to render. Not usable from here
//                      without taking on that library.
//   CARTO basemaps     Raster, but now requires a key and is being retired;
//                      unkeyed requests come back stamped "API KEY REQUIRED".
//   tile.openstreetmap.org
//                      Raster and keyless, but the OSMF Tile Usage Policy
//                      asks projects not to point an app or a public site at
//                      it. Not ours to take.
//   OSM US Tileservice Raster, keyless "Starter Tier", non-commercial — which
//                      fits this project. Confirm the current tile URL at
//                      https://tiles.openstreetmap.us and paste it below.
//   Geoapify / MapTiler / Stadia
//                      Reliable raster free tiers, each needing a free key.
//                      A tile key is domain-restricted rather than secret, so
//                      it belongs here beside the publishable Supabase key —
//                      but it is one more thing to keep alive.
//
// To turn a basemap on, set `url` (and `attribution`, which every one of them
// requires). Examples, once you have a key:
//
//   Geoapify  https://maps.geoapify.com/v1/tile/osm-bright-grey/{z}/{x}/{y}.png?apiKey=KEY
//   MapTiler  https://api.maptiler.com/maps/dataviz/{z}/{x}/{y}.png?key=KEY
//   Stadia    https://tiles.stadiamaps.com/tiles/alidade_smooth/{z}/{x}/{y}.png?api_key=KEY
//
// If the tiles fail to load — wrong URL, dead key, a network that blocks the
// provider — the map reverts to the SVG locator on its own. A basemap is
// decoration; the pins and the list are the content.
export const BASEMAP = {
  url: null,
  // Some servers still shard across a.,b.,c. subdomains; put the letters here
  // and use {s} in the URL. Most modern providers do not need this.
  subdomains: '',
  // Shown in the corner of the map. Every provider above requires credit, and
  // it is not optional in their terms.
  attribution: '© OpenStreetMap contributors',
  // Beyond this the pins are further apart than the precision behind them —
  // see the note in geo.js about town centres.
  maxZoom: 13,
};

// ---------------------------------------------------------------------------
// City -> county map for rental listings
// ---------------------------------------------------------------------------
// The Range Lab properties API filters by city and its records carry no
// county, but this screener asks people for their county. This map bridges
// the two: each entry names the count(y/ies) a city sits in, so listings can
// be narrowed to the chosen county. Cities that span counties (St. Cloud,
// Osakis) list every county they touch.
//
// The map is deliberately incomplete-safe: a city that isn't listed here is
// SHOWN in every county of its state rather than hidden — missing
// information never excludes. Add towns as they appear in real listings.
// Keys are lowercase.
export const CITY_COUNTIES = {
  OR: {
    // Jackson
    'medford': ['Jackson'], 'ashland': ['Jackson'], 'central point': ['Jackson'],
    'eagle point': ['Jackson'], 'talent': ['Jackson'], 'phoenix': ['Jackson'],
    'jacksonville': ['Jackson'], 'white city': ['Jackson'], 'shady cove': ['Jackson'],
    'gold hill': ['Jackson'], 'rogue river': ['Jackson'], 'butte falls': ['Jackson'],
    'prospect': ['Jackson'],
    // Josephine
    'grants pass': ['Josephine'], 'cave junction': ['Josephine'], 'merlin': ['Josephine'],
    'selma': ['Josephine'], 'williams': ['Josephine'], 'wolf creek': ['Josephine'],
    'kerby': ['Josephine'], "o'brien": ['Josephine'], 'murphy': ['Josephine'],
    // Douglas
    'roseburg': ['Douglas'], 'sutherlin': ['Douglas'], 'winston': ['Douglas'],
    'myrtle creek': ['Douglas'], 'canyonville': ['Douglas'], 'riddle': ['Douglas'],
    'oakland': ['Douglas'], 'drain': ['Douglas'], 'yoncalla': ['Douglas'],
    'reedsport': ['Douglas'], 'glide': ['Douglas'], 'elkton': ['Douglas'],
    // Klamath
    'klamath falls': ['Klamath'], 'altamont': ['Klamath'], 'chiloquin': ['Klamath'],
    'merrill': ['Klamath'], 'malin': ['Klamath'], 'bonanza': ['Klamath'],
    'gilchrist': ['Klamath'], 'crescent': ['Klamath'],
    // Curry
    'brookings': ['Curry'], 'gold beach': ['Curry'], 'port orford': ['Curry'],
    'harbor': ['Curry'],
    // Coos
    'coos bay': ['Coos'], 'north bend': ['Coos'], 'coquille': ['Coos'],
    'bandon': ['Coos'], 'myrtle point': ['Coos'], 'lakeside': ['Coos'],
    'powers': ['Coos'],
    // Lane
    'eugene': ['Lane'], 'springfield': ['Lane'], 'cottage grove': ['Lane'],
    'florence': ['Lane'], 'junction city': ['Lane'], 'creswell': ['Lane'],
    'veneta': ['Lane'], 'oakridge': ['Lane'], 'lowell': ['Lane'],
    'coburg': ['Lane'], 'dunes city': ['Lane'], 'westfir': ['Lane'],
    // Linn
    'albany': ['Linn'], 'lebanon': ['Linn'], 'sweet home': ['Linn'],
    'harrisburg': ['Linn'], 'brownsville': ['Linn'], 'scio': ['Linn'],
    'halsey': ['Linn'], 'tangent': ['Linn'], 'lyons': ['Linn'],
    'mill city': ['Linn', 'Marion'], 'gates': ['Linn', 'Marion'],
    // Lincoln
    'newport': ['Lincoln'], 'lincoln city': ['Lincoln'], 'toledo': ['Lincoln'],
    'waldport': ['Lincoln'], 'depoe bay': ['Lincoln'], 'yachats': ['Lincoln'],
    'siletz': ['Lincoln'],
    // Marion
    'salem': ['Marion'], 'keizer': ['Marion'], 'woodburn': ['Marion'],
    'silverton': ['Marion'], 'stayton': ['Marion'], 'aumsville': ['Marion'],
    'turner': ['Marion'], 'mount angel': ['Marion'], 'hubbard': ['Marion'],
    'gervais': ['Marion'], 'jefferson': ['Marion'], 'sublimity': ['Marion'],
    'aurora': ['Marion'], 'scotts mills': ['Marion'], 'detroit': ['Marion'],
    'idanha': ['Marion', 'Linn'],
    // Clackamas
    'oregon city': ['Clackamas'], 'milwaukie': ['Clackamas'], 'west linn': ['Clackamas'],
    'happy valley': ['Clackamas'], 'canby': ['Clackamas'], 'gladstone': ['Clackamas'],
    'molalla': ['Clackamas'], 'sandy': ['Clackamas'], 'estacada': ['Clackamas'],
    'damascus': ['Clackamas'], 'lake oswego': ['Clackamas'], 'wilsonville': ['Clackamas'],
    // Union
    'la grande': ['Union'], 'union': ['Union'], 'elgin': ['Union'],
    'cove': ['Union'], 'imbler': ['Union'], 'north powder': ['Union'],
    'summerville': ['Union'], 'island city': ['Union'],
  },
  MN: {
    // Stearns (St. Cloud and Sartell spill into neighbors)
    'st. cloud': ['Stearns', 'Benton', 'Sherburne'],
    'saint cloud': ['Stearns', 'Benton', 'Sherburne'],
    'sartell': ['Stearns', 'Benton'],
    'waite park': ['Stearns'], 'sauk centre': ['Stearns'], 'cold spring': ['Stearns'],
    'albany': ['Stearns'], 'melrose': ['Stearns'], 'paynesville': ['Stearns'],
    'st. joseph': ['Stearns'], 'saint joseph': ['Stearns'], 'kimball': ['Stearns'],
    'richmond': ['Stearns'], 'rockville': ['Stearns'], 'holdingford': ['Stearns'],
    // Benton
    'sauk rapids': ['Benton'], 'foley': ['Benton'], 'rice': ['Benton'],
    'gilman': ['Benton'],
    // Sherburne
    'elk river': ['Sherburne'], 'big lake': ['Sherburne'], 'becker': ['Sherburne'],
    'zimmerman': ['Sherburne'], 'clear lake': ['Sherburne'],
    // Morrison
    'little falls': ['Morrison'], 'pierz': ['Morrison'], 'royalton': ['Morrison'],
    'randall': ['Morrison'], 'swanville': ['Morrison'], 'upsala': ['Morrison'],
    'motley': ['Morrison', 'Cass'],
    // Wright
    'buffalo': ['Wright'], 'monticello': ['Wright'], 'otsego': ['Wright'],
    'st. michael': ['Wright'], 'saint michael': ['Wright'], 'albertville': ['Wright'],
    'delano': ['Wright'], 'annandale': ['Wright'], 'maple lake': ['Wright'],
    'cokato': ['Wright'], 'howard lake': ['Wright'], 'montrose': ['Wright'],
    'waverly': ['Wright'], 'clearwater': ['Wright'],
    // Todd
    'long prairie': ['Todd'], 'browerville': ['Todd'], 'clarissa': ['Todd'],
    'bertha': ['Todd'], 'eagle bend': ['Todd'], 'grey eagle': ['Todd'],
    'staples': ['Todd', 'Wadena'],
    // Mille Lacs
    'milaca': ['Mille Lacs'], 'isle': ['Mille Lacs'], 'onamia': ['Mille Lacs'],
    'foreston': ['Mille Lacs'], 'pease': ['Mille Lacs'], 'wahkon': ['Mille Lacs'],
    'princeton': ['Mille Lacs', 'Sherburne'],
    // Isanti
    'cambridge': ['Isanti'], 'isanti': ['Isanti'],
    'braham': ['Isanti', 'Kanabec'],
    // Kanabec
    'mora': ['Kanabec'], 'ogilvie': ['Kanabec'],
    // Crow Wing
    'brainerd': ['Crow Wing'], 'baxter': ['Crow Wing'], 'crosby': ['Crow Wing'],
    'pequot lakes': ['Crow Wing'], 'crosslake': ['Crow Wing'], 'nisswa': ['Crow Wing'],
    'ironton': ['Crow Wing'], 'deerwood': ['Crow Wing'], 'emily': ['Crow Wing'],
    'breezy point': ['Crow Wing'],
    // Chisago
    'north branch': ['Chisago'], 'wyoming': ['Chisago'], 'chisago city': ['Chisago'],
    'lindstrom': ['Chisago'], 'center city': ['Chisago'], 'taylors falls': ['Chisago'],
    'rush city': ['Chisago'], 'stacy': ['Chisago'], 'shafer': ['Chisago'],
    'harris': ['Chisago'],
    // Kandiyohi
    'willmar': ['Kandiyohi'], 'new london': ['Kandiyohi'], 'spicer': ['Kandiyohi'],
    'atwater': ['Kandiyohi'], 'kandiyohi': ['Kandiyohi'], 'pennock': ['Kandiyohi'],
    'prinsburg': ['Kandiyohi'], 'lake lillian': ['Kandiyohi'],
    // Douglas
    'alexandria': ['Douglas'], 'brandon': ['Douglas'], 'evansville': ['Douglas'],
    'carlos': ['Douglas'], 'garfield': ['Douglas'], 'miltona': ['Douglas'],
    'kensington': ['Douglas'], 'forada': ['Douglas'],
    'osakis': ['Douglas', 'Todd'],
    // Pope
    'glenwood': ['Pope'], 'starbuck': ['Pope'], 'villard': ['Pope'],
    'lowry': ['Pope'], 'cyrus': ['Pope'], 'long beach': ['Pope'],
    // Cass
    'walker': ['Cass'], 'pine river': ['Cass'], 'cass lake': ['Cass'],
    'backus': ['Cass'], 'hackensack': ['Cass'], 'pillager': ['Cass'],
    'east gull lake': ['Cass'], 'lake shore': ['Cass'], 'longville': ['Cass'],
    'remer': ['Cass'],
    // Ramsey
    'st. paul': ['Ramsey'], 'saint paul': ['Ramsey'], 'roseville': ['Ramsey'],
    'maplewood': ['Ramsey'], 'shoreview': ['Ramsey'], 'new brighton': ['Ramsey'],
    'mounds view': ['Ramsey'], 'north st. paul': ['Ramsey'],
    'north saint paul': ['Ramsey'], 'little canada': ['Ramsey'],
    'vadnais heights': ['Ramsey'], 'arden hills': ['Ramsey'],
    'falcon heights': ['Ramsey'], 'lauderdale': ['Ramsey'], 'gem lake': ['Ramsey'],
    'north oaks': ['Ramsey'],
    'white bear lake': ['Ramsey', 'Washington'],
  },
};

// ---------------------------------------------------------------------------
// Service areas
// ---------------------------------------------------------------------------
// County names are not unique across states: Oregon and Minnesota both have a
// Douglas County, and their income limits differ by 27% ($41,800 vs $52,950 at
// 50% AMI for a household of four). So a county is only meaningful together
// with its state, and every lookup is keyed on the pair.
//
// area_id ties each county to its income_areas row. HUD publishes several of
// these by metro area rather than county — Jackson is the Medford MSA,
// Josephine is Grants Pass, Stearns is the St. Cloud MSA — but that mapping
// lives in the database, not here.
export const STATES = [
  {
    code: 'OR',
    label: 'Oregon',
    name: 'Southern Oregon',
    statewideAreaId: 'OR',
    counties: [
      { name: 'Jackson', areaId: 'OR-JACKSON' },
      { name: 'Josephine', areaId: 'OR-JOSEPHINE' },
      { name: 'Douglas', areaId: 'OR-DOUGLAS' },
      { name: 'Klamath', areaId: 'OR-KLAMATH' },
      { name: 'Curry', areaId: 'OR-CURRY' },
      { name: 'Coos', areaId: 'OR-COOS' },
      { name: 'Lane', areaId: 'OR-LANE' },
      { name: 'Linn', areaId: 'OR-LINN' },
      { name: 'Lincoln', areaId: 'OR-LINCOLN' },
      { name: 'Marion', areaId: 'OR-MARION' },
      { name: 'Clackamas', areaId: 'OR-CLACKAMAS' },
      { name: 'Union', areaId: 'OR-UNION' },
    ],
  },
  {
    code: 'MN',
    label: 'Minnesota',
    name: 'Central Minnesota',
    statewideAreaId: 'MN',
    counties: [
      { name: 'Stearns', areaId: 'MN-STEARNS' },
      { name: 'Benton', areaId: 'MN-BENTON' },
      { name: 'Sherburne', areaId: 'MN-SHERBURNE' },
      { name: 'Morrison', areaId: 'MN-MORRISON' },
      { name: 'Wright', areaId: 'MN-WRIGHT' },
      { name: 'Todd', areaId: 'MN-TODD' },
      { name: 'Mille Lacs', areaId: 'MN-MILLE-LACS' },
      { name: 'Isanti', areaId: 'MN-ISANTI' },
      { name: 'Kanabec', areaId: 'MN-KANABEC' },
      { name: 'Crow Wing', areaId: 'MN-CROW-WING' },
      { name: 'Chisago', areaId: 'MN-CHISAGO' },
      { name: 'Kandiyohi', areaId: 'MN-KANDIYOHI' },
      { name: 'Douglas', areaId: 'MN-DOUGLAS' },
      { name: 'Pope', areaId: 'MN-POPE' },
      { name: 'Cass', areaId: 'MN-CASS' },
      { name: 'Ramsey', areaId: 'MN-RAMSEY' },
    ],
  },
];
