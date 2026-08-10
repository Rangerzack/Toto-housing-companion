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
// Area Median Income reference table
// ---------------------------------------------------------------------------
// Used to translate "household size + annual income" into an AMI percentage so
// it can be compared against each program's ami_min / ami_max.
//
// IMPORTANT — these are ESTIMATES. They are derived by doubling the Jackson
// County 50%-AMI (Very Low Income) limits effective 05/01/2026, which are the
// only published dollar figures in the source matrix (see the Housing Choice
// Voucher row's "Income Standard"). Real HUD limits are not perfectly linear:
// the 50% and 80% tiers are computed separately and subject to caps and
// adjustments, so a doubled 50% figure is close to but not exactly the true
// 100% figure. Josephine and other counties differ again.
//
// Before relying on this for anything consequential, replace the values below
// with the official HUD income limits for each county you serve:
// https://www.huduser.gov/portal/datasets/il.html
export const AMI_100_BY_HOUSEHOLD_SIZE = {
  1: 68700,
  2: 78500,
  3: 88300,
  4: 98100,
  5: 106000,
  6: 113800,
  7: 121700,
  8: 129500,
};

// HUD's convention for households larger than 8: add 8% of the 4-person limit
// for each additional person.
export function areaMedianIncomeFor(householdSize) {
  const table = AMI_100_BY_HOUSEHOLD_SIZE;
  if (householdSize <= 8) return table[householdSize];
  const base = table[8];
  const increment = table[4] * 0.08;
  return Math.round(base + increment * (householdSize - 8));
}

// Counties offered in the screener. Everything the matrix currently covers
// lives in Southern Oregon, with a handful of statewide programs; the list is
// ordered so the two counties with the most coverage come first.
export const COUNTIES = [
  'Jackson',
  'Josephine',
  'Douglas',
  'Klamath',
  'Curry',
  'Coos',
  'Lane',
  'Linn',
  'Lincoln',
  'Marion',
  'Clackamas',
  'Union',
];
