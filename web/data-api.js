// ---------------------------------------------------------------------------
// Reading the program catalogue
// ---------------------------------------------------------------------------
// Shared by the anonymous screener (app.js) and the signed-in dashboard
// (dashboard/dashboard.js). It lives in its own module because the two must
// never disagree about which programs exist or what limits apply — if the
// dashboard fetched its own way and this file later grew a filter, someone
// would see a program in one place and not the other, with no way to tell
// which was right.
//
// Everything here is public reference data read with the publishable key, and
// the functions are pure: they fetch and return, holding no state of their own.
// Callers keep whatever cache they need.

import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js?v=__BUILD__';

const PUBLIC_HEADERS = {
  apikey: SUPABASE_ANON_KEY,
  Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
};

// PostgREST returns embedded one-to-one rows as an object on some versions and
// a single-element array on others; normalize both to a plain object.
const one = (value) => (Array.isArray(value) ? value[0] || {} : value || {});

/**
 * Every active program with its eligibility, contacts, forms and verification.
 *
 * @returns {{programs: object[], proportionalStandards: Set<string>}}
 */
export async function fetchProgramCatalogue() {
  if (SUPABASE_ANON_KEY.startsWith('PASTE_')) {
    throw new Error('MISSING_KEY');
  }

  const select =
    'select=*,program_counties(county,state_code),eligibility(*),contacts(*),forms(*),verification(*)';

  // program_income_rules is fetched separately rather than embedded: it has no
  // foreign key to programs (see 0004_income_limits.sql), and PostgREST can
  // only embed across a declared relationship.
  const [response, rulesResponse, standardsResponse] = await Promise.all([
    // is_active filters out records that document something real but are not
    // assistance anyone can apply for — discontinued funds, referral desks,
    // "shutoff protection (NOT a payment program)".
    fetch(`${SUPABASE_URL}/rest/v1/programs?${select}&is_active=eq.true`, { headers: PUBLIC_HEADERS }),
    fetch(`${SUPABASE_URL}/rest/v1/program_income_rules?select=*`, { headers: PUBLIC_HEADERS }),
    fetch(`${SUPABASE_URL}/rest/v1/income_standards?select=standard_id,proportional`, {
      headers: PUBLIC_HEADERS,
    }),
  ]);

  let proportionalStandards = new Set();
  if (standardsResponse.ok) {
    proportionalStandards = new Set(
      (await standardsResponse.json()).filter((s) => s.proportional).map((s) => s.standard_id),
    );
  }

  if (!response.ok) {
    throw new Error(`Supabase returned ${response.status} ${response.statusText}`);
  }

  const rulesByProgram = new Map();
  if (rulesResponse.ok) {
    for (const rule of await rulesResponse.json()) {
      rulesByProgram.set(rule.program_id, rule);
    }
  }

  const rows = await response.json();
  const programs = rows.map((row) => ({
    ...row,
    eligibility: one(row.eligibility),
    contacts: one(row.contacts),
    verification: one(row.verification),
    forms: row.forms || [],
    program_counties: row.program_counties || [],
    income_rule: rulesByProgram.get(row.program_id) || null,
  }));

  return { programs, proportionalStandards };
}

/**
 * Published limits for the local-area counties plus the statewide SMI table.
 *
 * v_current_income_limits already drops expired rows and expands published
 * brackets (USDA's "1-4 person") into one row per size. Several effective
 * dates can still be current at once, so the newest wins per area.
 *
 * When the local area spans counties whose limits differ, the MOST GENEROUS
 * figure wins for each (standard, tier, size): the matcher can't tell which
 * county a given program will test against, and under the house rule a
 * too-generous limit only ever turns an exclusion into a worth-checking phone
 * call, never the reverse.
 *
 * @returns {Map<string, number>} keyed "standardId|tierPct|householdSize"
 */
export async function fetchLimitRows(areaIds, statewideAreaId) {
  const ids = (Array.isArray(areaIds) ? areaIds : [areaIds]).filter(Boolean);
  if (!ids.length) return new Map();

  const areas = [...ids, statewideAreaId, 'US-48'].map(encodeURIComponent).join(',');
  const query =
    'v_current_income_limits?select=area_id,standard_id,tier_pct,household_size,amount,effective_date' +
    `&area_id=in.(${areas})`;
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${query}`, { headers: PUBLIC_HEADERS });
  if (!response.ok) throw new Error(`Income limits: ${response.status}`);

  // Newest row per (area, standard, tier, size)…
  const newest = new Map();
  const perArea = new Map();
  for (const row of await response.json()) {
    const rowKey = `${row.area_id}|${row.standard_id}|${Number(row.tier_pct)}|${row.household_size}`;
    if (!newest.has(rowKey) || row.effective_date > newest.get(rowKey)) {
      newest.set(rowKey, row.effective_date);
      perArea.set(rowKey, {
        key: `${row.standard_id}|${Number(row.tier_pct)}|${row.household_size}`,
        amount: Number(row.amount),
      });
    }
  }
  // …then the highest across areas per (standard, tier, size).
  const chosen = new Map();
  for (const { key: limitKey, amount } of perArea.values()) {
    if (!chosen.has(limitKey) || amount > chosen.get(limitKey)) {
      chosen.set(limitKey, amount);
    }
  }
  return chosen;
}

/**
 * Reads a limit out of a map from fetchLimitRows; null means nothing is
 * published for that combination.
 *
 * HUD publishes sizes 1-8 but this screener accepts households up to 12, so
 * larger ones fall back to HUD's own convention: add 8% of the 4-person limit
 * per additional person. This mirrors the income_limit_for() function in
 * 0004_income_limits.sql. Oregon's SMI table carries explicit rows through
 * size 12 (it grows by a different rule), so those hit the exact path first.
 */
export function lookupLimit(limits, standardId, tierPct, householdSize) {
  const key = (size) => `${standardId}|${Number(tierPct)}|${size}`;

  const exact = limits.get(key(householdSize));
  if (exact != null) return exact;

  if (householdSize > 8) {
    const largest = limits.get(key(8));
    const fourPerson = limits.get(key(4));
    if (largest != null && fourPerson != null) {
      return Math.round(largest + fourPerson * 0.08 * (householdSize - 8));
    }
  }
  return null;
}
