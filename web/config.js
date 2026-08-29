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
