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
//     bathrooms, url, phone, email, type, availability, subsidized }
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
export function normalizeListing(raw) {
  if (!raw || typeof raw !== 'object') return null;

  const listing = {};
  for (const [field, aliases] of Object.entries(FIELD_ALIASES)) {
    const key = aliases.find((k) => raw[k] != null && raw[k] !== '');
    listing[field] = key ? raw[key] : null;
  }

  listing.rent = parseMoney(listing.rent);
  listing.bedrooms = parseBedrooms(listing.bedrooms);
  listing.photo = parsePhoto(listing.photo);
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
 * The same principle as the program matcher applies: missing information
 * never excludes. A listing without a county stays in (the API may already
 * be scoped), one without a bedroom count stays in whatever size was asked
 * for, and one without a rent figure sorts last rather than disappearing.
 *
 * `countiesForCity` covers APIs (like Range Lab's) whose records carry a
 * city but no county: given (city, state) it returns the county name(s)
 * that city sits in, or null when unknown — and unknown, as always, keeps
 * the listing in.
 *
 * @returns {{listing: object, affordable: boolean|null}[]}
 */
export function screenListings(listings, answers, countiesForCity) {
  const budget = monthlyBudget(answers.income);
  const wanted =
    answers.bedrooms == null || answers.bedrooms === 'any'
      ? null
      : Number(answers.bedrooms);

  const results = [];
  for (const listing of listings) {
    if (listing.state && answers.state && !sameState(listing.state, answers.state)) continue;
    if (listing.county && answers.county && !sameCounty(listing.county, answers.county)) continue;

    // No county on the record: resolve it from the city where we can. A city
    // the map doesn't know stays in the results rather than vanishing.
    if (!listing.county && listing.city && answers.county && countiesForCity) {
      const counties = countiesForCity(listing.city, listing.state || answers.state);
      if (counties && !counties.some((c) => sameCounty(c, answers.county))) continue;
    }

    if (wanted != null && listing.bedrooms != null) {
      // "4+" means at least four; the smaller sizes are exact — someone who
      // asked for a studio isn't served by being shown three-bedroom houses.
      const fits = wanted >= 4 ? listing.bedrooms >= 4 : listing.bedrooms === wanted;
      if (!fits) continue;
    }

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
