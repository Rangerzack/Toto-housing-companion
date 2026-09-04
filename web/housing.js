// ---------------------------------------------------------------------------
// Housing search
// ---------------------------------------------------------------------------
// The second half of the "I'm looking to rent" fork: instead of screening
// assistance programs, this fetches actual rental listings from the housing
// data API configured in config.js and narrows them to the person's county
// and household.
//
// Like matcher.js, nothing here touches the DOM — app.js renders what this
// returns, so the fetch/normalize/screen pipeline is testable on its own.
//
// The module doesn't assume one particular API. Whatever the endpoint
// returns is passed through normalizeListing(), which maps the field names
// APIs commonly use onto one internal shape:
//
//   { id, name, address, city, county, state, zip, rent, bedrooms,
//     bathrooms, url, phone, email, type, availability, subsidized,
//     lat, lon }
//
// If your API uses names not covered below, add them to FIELD_ALIASES —
// that one table is the only thing to edit when wiring a new source.

// Order matters: the first key present on the raw record wins.
const FIELD_ALIASES = {
  id: ['id', 'listing_id', 'listingId', 'property_id', 'propertyId', 'uuid', 'slug'],
  name: [
    'name', 'title', 'property_name', 'propertyName', 'listing_name',
    'building_name', 'community_name', 'development_name',
  ],
  address: [
    'address', 'street_address', 'streetAddress', 'address1', 'address_line1',
    'full_address', 'location',
  ],
  city: ['city', 'town', 'locality'],
  county: ['county', 'county_name', 'countyName'],
  state: ['state', 'state_code', 'stateCode', 'state_abbr', 'region'],
  zip: ['zip', 'zipcode', 'zip_code', 'postal_code', 'postalCode'],
  rent: [
    'rent', 'price', 'monthly_rent', 'monthlyRent', 'rent_amount',
    'min_rent', 'rent_min', 'asking_rent',
  ],
  bedrooms: ['bedrooms', 'beds', 'br', 'num_bedrooms', 'bedroom_count'],
  bathrooms: ['bathrooms', 'baths', 'ba', 'num_bathrooms'],
  url: ['url', 'link', 'listing_url', 'listingUrl', 'detail_url', 'details_url', 'website', 'web_url'],
  phone: ['phone', 'phone_number', 'phoneNumber', 'contact_phone', 'telephone'],
  email: ['email', 'contact_email', 'contactEmail'],
  type: ['type', 'property_type', 'propertyType', 'housing_type', 'category'],
  photo: [
    'photo', 'image', 'photo_url', 'photoUrl', 'image_url', 'imageUrl',
    'thumbnail', 'thumbnail_url', 'picture', 'photos', 'images',
  ],
  availability: ['availability', 'available', 'available_date', 'availableDate', 'status'],
  // The feed carries no coordinates today, so the property map falls back to
  // the centre of the town (web/geo.js). These aliases mean that the day it
  // starts sending them, every pin becomes street-accurate on its own.
  lat: ['lat', 'latitude', 'y'],
  lon: ['lon', 'lng', 'long', 'longitude', 'x'],
  subsidized: [
    'subsidized', 'is_subsidized', 'affordable', 'income_restricted',
    'incomeRestricted', 'lihtc', 'section8',
  ],
};

// "$1,250/mo", "1250-1400", 1250 → 1250. The first number in a range is the
// advertised floor, which is the honest figure to sort and flag on.
function parseMoney(value) {
  if (value == null) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const match = String(value).match(/\d[\d,]*(\.\d+)?/);
  return match ? Number(match[0].replace(/,/g, '')) : null;
}

// APIs carry photos as a URL string or an array of them (sometimes objects
// with a url/href field); the cards show one, so take the first usable URL.
function parsePhoto(value) {
  const first = Array.isArray(value) ? value[0] : value;
  const url =
    typeof first === 'string' ? first : first && (first.url || first.href) ? first.url || first.href : null;
  return typeof url === 'string' && /^https?:\/\//i.test(url) ? url : null;
}

// A coordinate is only worth keeping if it is a real number in range; 0/0 is
// the null island every geocoder emits when it has failed.
function toCoord(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && Math.abs(n) <= 180 ? n : null;
}

// "Studio" and "efficiency" are zero-bedroom units, not missing data.
function parseBedrooms(value) {
  if (value == null) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const text = String(value);
  if (/studio|efficiency/i.test(text)) return 0;
  const match = text.match(/\d+/);
  return match ? Number(match[0]) : null;
}

/** Maps one raw API record onto the internal listing shape. */
// Property types arrive as API enums — "SINGLE__FAMILY", "MULTI_FAMILY",
// "OTHER". Those are database values, not words anyone says, and they were
// reaching people on the results page ("Studio · OTHER · Active"). Known
// values get the word a person would use; anything unrecognised is
// title-cased; and placeholders that carry no information at all are dropped
// rather than shown, because "OTHER" tells somebody nothing about a home.
const TYPE_WORDS = {
  single_family: 'House',
  multi_family: 'Apartment',
  apartment: 'Apartment',
  condo: 'Condo',
  condominium: 'Condo',
  townhouse: 'Townhouse',
  townhome: 'Townhouse',
  duplex: 'Duplex',
  triplex: 'Triplex',
  fourplex: 'Fourplex',
  manufactured: 'Manufactured home',
  mobile_home: 'Manufactured home',
  manufactured_home: 'Manufactured home',
  cabin: 'Cabin',
  cottage: 'Cottage',
  studio: 'Studio',
  room: 'Room',
};
const EMPTY_TYPES = new Set(['other', 'unknown', 'n_a', 'na', 'none', 'null', 'undefined']);

export function humanizeType(value) {
  if (value == null || value === '') return null;
  // Collapses the doubled underscores the feed emits ("SINGLE__FAMILY").
  const key = String(value).trim().toLowerCase().replace(/[\s-]+/g, '_').replace(/_+/g, '_');
  if (!key || EMPTY_TYPES.has(key)) return null;
  if (TYPE_WORDS[key]) return TYPE_WORDS[key];
  return key
    .split('_')
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * Turns an availability value into a sentence.
 *
 * The feed mixes status words ("available", "Active") with dates ("2026-08-19",
 * "aug 19"), and both were being printed verbatim — including the lowercase
 * month. Anything it cannot read is returned trimmed rather than dropped: an
 * unrecognised note may still mean something to the person reading it.
 */
export function humanizeAvailability(value) {
  if (value == null || value === '') return null;
  const raw = String(value).trim();
  if (!raw) return null;

  const key = raw.toLowerCase();
  if (/^(available|active|available now|vacant|ready)$/.test(key)) return 'Available now';
  if (/^(unavailable|inactive|rented|leased|occupied|pending)$/.test(key)) return null;

  // ISO or slash dates.
  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) {
    const month = MONTHS[Number(iso[2]) - 1];
    return month ? `Available ${month} ${Number(iso[3])}` : `Available ${raw}`;
  }
  // "aug 19", "August 19", "Aug 19 2026" — fix the casing and prefix it.
  const named = raw.match(/^([A-Za-z]{3,9})\.?\s+(\d{1,2})/);
  if (named) {
    const month = MONTHS.find((m) => named[1].toLowerCase().startsWith(m.toLowerCase()));
    if (month) return `Available ${month} ${Number(named[2])}`;
  }
  if (/^available\b/i.test(raw)) {
    return raw.charAt(0).toUpperCase() + raw.slice(1);
  }
  return raw;
}

export function normalizeListing(raw) {
  if (!raw || typeof raw !== 'object') return null;

  const listing = {};
  for (const [field, aliases] of Object.entries(FIELD_ALIASES)) {
    const key = aliases.find((k) => raw[k] != null && raw[k] !== '');
    listing[field] = key ? raw[key] : null;
  }

  listing.rent = parseMoney(listing.rent);
  listing.bedrooms = parseBedrooms(listing.bedrooms);
  // Baths arrive as 1, "1.5", or "2 baths" — first number wins.
  if (listing.bathrooms != null && typeof listing.bathrooms !== 'number') {
    const match = String(listing.bathrooms).match(/\d+(\.\d+)?/);
    listing.bathrooms = match ? Number(match[0]) : null;
  }
  listing.photo = parsePhoto(listing.photo);
  // Kept as numbers or null; geo.js decides whether they are usable.
  listing.lat = toCoord(listing.lat);
  listing.lon = toCoord(listing.lon);
  // Both of these ship straight to the results page, so they are made
  // readable here rather than at every render site.
  listing.type = humanizeType(listing.type);
  listing.availability = humanizeAvailability(listing.availability);
  listing.subsidized =
    listing.subsidized === true ||
    /^(yes|true|y|1)$/i.test(String(listing.subsidized ?? ''));

  // A record with neither a name nor an address can't be shown or acted on.
  if (!listing.name && !listing.address) return null;
  if (!listing.name) listing.name = listing.address;

  return listing;
}

/**
 * Finds the array of records in whatever envelope the API wraps it in:
 * a bare array, {listings: [...]}, {data: {results: [...]}}, and so on.
 */
export function extractListings(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];

  const keys = ['listings', 'results', 'items', 'properties', 'records', 'rows', 'units', 'data'];
  for (const key of keys) {
    if (Array.isArray(payload[key])) return payload[key];
  }
  // One level of nesting covers the common {data: {listings: [...]}} shape.
  if (payload.data && typeof payload.data === 'object') {
    return extractListings(payload.data);
  }
  return [];
}

/**
 * Fetches and normalizes listings from the configured endpoint.
 *
 * If the URL contains `{state}` or `{county}` placeholders they are filled
 * in, so an API that filters server-side can be pointed at directly
 * (e.g. `https://api.example.org/listings?state={state}&county={county}`).
 * Without placeholders the endpoint is fetched as-is and screenListings()
 * narrows the results client-side either way.
 */
export async function fetchListings({ url, headers = {}, state, county }) {
  if (!url || url.startsWith('PASTE_')) {
    throw new Error('MISSING_HOUSING_API');
  }

  const target = url
    .replace('{state}', encodeURIComponent(state || ''))
    .replace('{county}', encodeURIComponent(county || ''));

  const response = await fetch(target, { headers });
  if (!response.ok) {
    // The housing-search edge function explains its failures in an {error}
    // body ("not configured yet — set the ... secrets"); showing that beats
    // a bare status code.
    let detail = `Housing API returned ${response.status} ${response.statusText}`;
    try {
      const body = await response.json();
      if (body && (body.error || body.message)) detail = String(body.error || body.message);
    } catch {
      /* not JSON — keep the status line */
    }
    throw new Error(detail);
  }

  return extractListings(await response.json())
    .map(normalizeListing)
    .filter(Boolean);
}

/** Rent at the common 30%-of-gross-income affordability guideline. */
export function monthlyBudget(annualIncome) {
  if (annualIncome == null) return null;
  return (annualIncome / 12) * 0.3;
}

const STATE_NAMES = { oregon: 'OR', minnesota: 'MN' };

// Exclude only on a state we can definitely read as different. A value in a
// format we can't parse ("Ore.", "Oregon (OR)") is unknown, and unknown
// keeps the listing in — same principle as everywhere else in this module.
function sameState(listingState, code) {
  const raw = String(listingState).trim();
  if (/^[A-Za-z]{2}$/.test(raw)) return raw.toUpperCase() === code;
  const mapped = STATE_NAMES[raw.toLowerCase()];
  return mapped ? mapped === code : true;
}

function sameCounty(listingCounty, county) {
  const strip = (v) => String(v).toLowerCase().replace(/\s+county$/, '').trim();
  return strip(listingCounty) === strip(county);
}

/** "Studio", "2 bedrooms" — shared by the wizard chips and result cards. */
export function bedroomsLabel(bedrooms) {
  if (bedrooms == null) return null;
  if (bedrooms === 0) return 'Studio';
  return `${bedrooms} bedroom${bedrooms === 1 ? '' : 's'}`;
}

/**
 * Narrows listings to the person's answers and sorts them cheapest first.
 *
 * The same principle as the program matcher applies to MISSING information:
 * a listing without a county stays in (the API may already be scoped), one
 * without a bedroom count passes any size test, and one without a rent
 * figure sorts last rather than disappearing.
 *
 * The search preferences themselves work the way people search:
 *   - bedrooms and bathrooms are FLOORS, not exact sizes — someone who can
 *     live in a studio can live in a 1-bedroom, and max rent is what caps
 *     the search from above;
 *   - maxRent is a hard ceiling, because the person set it as one.
 *
 * `countiesForCity` covers APIs (like Range Lab's) whose records carry a
 * city but no county: given (city, state) it returns the county name(s)
 * that city sits in, or null when unknown — and unknown keeps the listing.
 * `answers.counties` may name several local-area counties; a listing in any
 * of them stays.
 *
 * @returns {{listing: object, affordable: boolean|null}[]}
 */
export function screenListings(listings, answers, countiesForCity) {
  const budget = monthlyBudget(answers.income);
  const floor = (v) => (v == null || v === 'any' ? null : Number(v));
  const minBeds = floor(answers.bedrooms);
  const minBaths = floor(answers.bathrooms);
  const maxRent = answers.maxRent != null ? Number(answers.maxRent) : null;
  const wantedCounties =
    Array.isArray(answers.counties) && answers.counties.length
      ? answers.counties
      : answers.county
        ? [answers.county]
        : [];

  const inWantedCounty = (county) => wantedCounties.some((c) => sameCounty(county, c));

  const results = [];
  for (const listing of listings) {
    if (listing.state && answers.state && !sameState(listing.state, answers.state)) continue;
    if (listing.county && wantedCounties.length && !inWantedCounty(listing.county)) continue;

    // No county on the record: resolve it from the city where we can. A city
    // the map doesn't know stays in the results rather than vanishing.
    if (!listing.county && listing.city && wantedCounties.length && countiesForCity) {
      const counties = countiesForCity(listing.city, listing.state || answers.state);
      if (counties && !counties.some(inWantedCounty)) continue;
    }

    if (minBeds != null && listing.bedrooms != null && listing.bedrooms < minBeds) continue;
    if (minBaths != null && listing.bathrooms != null && listing.bathrooms < minBaths) continue;
    if (maxRent != null && listing.rent != null && listing.rent > maxRent) continue;

    results.push({
      listing,
      affordable:
        listing.rent != null && budget != null ? listing.rent <= budget : null,
    });
  }

  results.sort((a, b) => {
    const aRent = a.listing.rent ?? Infinity;
    const bRent = b.listing.rent ?? Infinity;
    if (aRent !== bRent) return aRent - bRent;
    return String(a.listing.name).localeCompare(String(b.listing.name));
  });

  return results;
}
