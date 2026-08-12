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
// Counties
// ---------------------------------------------------------------------------
// Ordered so the two counties with the most program coverage come first.
// area_id ties each county to its row in the income_areas table — HUD publishes
// several of these by metro area rather than by county (Jackson is the Medford
// MSA, Josephine is Grants Pass, Lane is Eugene-Springfield, and so on), but
// that mapping lives in the database, not here.
export const COUNTIES = [
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
];

// Statewide area, used by the SMI-based utility programs.
export const STATEWIDE_AREA_ID = 'OR';
