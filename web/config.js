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
// The rental-search path ("Help finding a place") reads available listings
// from this endpoint via housing.js. Until a real URL is pasted in, that path
// shows a "not connected yet" notice instead of results — the program
// screener is unaffected.
//
// `{state}` and `{county}` in the URL are replaced with the person's answers
// (e.g. 'https://api.example.org/listings?state={state}&county={county}').
// An endpoint without placeholders is fetched as-is; results are narrowed to
// the chosen county client-side either way, so both styles of API work.
//
// The response can be a bare JSON array or wrapped ({listings: [...]},
// {data: {...}}, etc.) — housing.js unwraps the common envelopes and maps
// common field names automatically. If your API's field names don't map,
// extend FIELD_ALIASES in housing.js.
export const HOUSING_API_URL = 'PASTE_YOUR_HOUSING_API_URL_HERE';

// Sent with every listings request. Add whatever your API needs, e.g.
// { 'X-Api-Key': '...' } or { Authorization: 'Bearer ...' }. Remember this
// file ships to the browser — only put keys here that are safe to be public.
export const HOUSING_API_HEADERS = {};

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
