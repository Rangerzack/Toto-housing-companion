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
