// ---------------------------------------------------------------------------
// The saved profile
// ---------------------------------------------------------------------------
// One module describes the profile: its sections and fields, how complete it
// is, how it is read and written, and how it converts into the shape the
// matcher already speaks. Everything else (the form, the completion meter, the
// dashboard) is generated from SECTIONS below, so adding a question means
// editing one array rather than three files that can drift apart.
//
// The screener stays the reference implementation. A profile is not a second
// data model — profileToAnswers() turns a row into exactly the `answers`
// object web/app.js builds from the wizard, so both paths run through the same
// matcher.js and produce the same verdicts. If they ever disagree, that is a
// bug in the adapter, not a second opinion.

import { authedFetch, currentUser } from './auth.js?v=__BUILD__';
import { STATES } from './config.js?v=__BUILD__';

// ---------------------------------------------------------------------------
// What we ask, and what we deliberately don't
// ---------------------------------------------------------------------------
// `counts: true` means the field is part of the completion percentage. Those
// are the fields that materially change which programs match.
//
// The eligibility circumstances (veteran, disability, crisis...) are all
// `counts: false` on purpose. They only ever ADD programs — the matcher treats
// an unticked box as unknown, never as "no" — so making them part of a
// completion score would pressure someone into disclosing a disability or a
// crisis to reach 100%, for no matching benefit they don't already get by
// answering honestly. Same reasoning as the wizard's own promise that leaving
// a box unchecked never counts against you.

const CONTACT_METHODS = [
  { value: 'email', label: 'Email' },
  { value: 'phone', label: 'Phone call' },
  { value: 'text', label: 'Text message' },
];

const AGE_RANGES = [
  { value: 'under-25', label: 'Under 25' },
  { value: '25-54', label: '25 to 54' },
  { value: '55-59', label: '55 to 59' },
  { value: '60-61', label: '60 or 61' },
  { value: '62-64', label: '62 to 64' },
  { value: '65-plus', label: '65 or older' },
];

const HOUSEHOLD_COMPOSITIONS = [
  { value: 'single', label: 'Just me' },
  { value: 'couple', label: 'Me and a partner' },
  { value: 'single-parent', label: 'One parent with children' },
  { value: 'two-parent', label: 'Two parents with children' },
  { value: 'multigenerational', label: 'Several generations' },
  { value: 'roommates', label: 'Roommates or shared housing' },
  { value: 'other', label: 'Something else' },
];

const HOUSING_STATUSES = [
  { value: 'renting', label: 'Renting' },
  { value: 'homeowner', label: 'I own my home' },
  { value: 'buying', label: 'Looking to buy' },
  { value: 'staying-with-others', label: 'Staying with family or friends' },
  { value: 'transitional', label: 'In transitional or temporary housing' },
  { value: 'unhoused', label: 'Not stably housed right now' },
  { value: 'other', label: 'Something else' },
];

const HOUSING_TYPES = [
  { value: 'any', label: 'Anything that works' },
  { value: 'apartment', label: 'Apartment' },
  { value: 'house', label: 'House' },
  { value: 'duplex', label: 'Duplex' },
  { value: 'townhouse', label: 'Townhouse' },
  { value: 'manufactured', label: 'Manufactured or mobile home' },
];

const MOVE_IN_TIMEFRAMES = [
  { value: 'immediately', label: 'As soon as possible' },
  { value: 'within-30-days', label: 'Within 30 days' },
  { value: 'one-to-three-months', label: 'One to three months' },
  { value: 'three-to-six-months', label: 'Three to six months' },
  { value: 'just-looking', label: 'Just looking for now' },
];

const EMPLOYMENT_STATUSES = [
  { value: 'employed-full-time', label: 'Working full time' },
  { value: 'employed-part-time', label: 'Working part time' },
  { value: 'self-employed', label: 'Self-employed' },
  { value: 'unemployed', label: 'Not working right now' },
  { value: 'retired', label: 'Retired' },
  { value: 'disabled', label: 'Unable to work' },
  { value: 'student', label: 'Student' },
  { value: 'other', label: 'Something else' },
];

const INCOME_SOURCES = [
  { value: 'job', label: 'A job' },
  { value: 'self-employment', label: 'Self-employment' },
  { value: 'social-security', label: 'Social Security' },
  { value: 'ssi-ssdi', label: 'SSI or SSDI' },
  { value: 'pension', label: 'Pension or retirement' },
  { value: 'unemployment', label: 'Unemployment' },
  { value: 'child-support', label: 'Child support' },
  { value: 'va-benefits', label: 'VA benefits' },
  { value: 'family', label: 'Help from family' },
  { value: 'none', label: 'No income right now' },
  { value: 'other', label: 'Something else' },
];

const BENEFITS = [
  { value: 'snap', label: 'SNAP / food support' },
  { value: 'tanf', label: 'TANF / cash assistance' },
  { value: 'medicaid', label: 'Medicaid / Medical Assistance' },
  { value: 'medicare', label: 'Medicare' },
  { value: 'ssi', label: 'SSI' },
  { value: 'ssdi', label: 'SSDI' },
  { value: 'wic', label: 'WIC' },
  { value: 'section-8', label: 'Section 8 / Housing Choice Voucher' },
  { value: 'public-housing', label: 'Public housing' },
  { value: 'energy-assistance', label: 'Energy assistance (LIHEAP / EAP)' },
  { value: 'veterans-benefits', label: 'Veterans benefits' },
  { value: 'none', label: 'None of these' },
];

// The help someone is looking for. `help` maps each need onto the screener's
// own categories, which matchesHelpType() uses as a hard filter.
//
// The mapping is deliberately generous, and needs with no housing/utility
// equivalent (food, transport, childcare...) map to nothing at all. An empty
// map means no filter is applied, so choosing only "food assistance" shows
// every program rather than none — over-inclusion costs a phone call, while
// under-inclusion costs someone the help they came for.
export const SUPPORT_NEEDS = [
  { value: 'finding-rental', label: 'Finding a place to rent', help: ['rental'] },
  { value: 'rental-assistance', label: 'Help paying rent', help: ['rental', 'staying'] },
  { value: 'emergency-housing', label: 'Emergency or crisis housing', help: ['rental', 'staying'] },
  { value: 'eviction-help', label: 'Staying in my home / eviction help', help: ['staying'] },
  { value: 'home-repair', label: 'Home repairs', help: ['staying'] },
  { value: 'buying-home', label: 'Buying a home', help: ['buying'] },
  { value: 'utility-assistance', label: 'Utility bills', help: ['utility'] },
  { value: 'food-assistance', label: 'Food assistance', help: [] },
  { value: 'transportation', label: 'Transportation', help: [] },
  { value: 'employment', label: 'Employment help', help: [] },
  { value: 'healthcare', label: 'Healthcare', help: [] },
  { value: 'childcare', label: 'Childcare', help: [] },
  { value: 'legal', label: 'Legal help', help: [] },
  { value: 'mental-health', label: 'Mental health or social services', help: [] },
  { value: 'disability-services', label: 'Disability services', help: [] },
  { value: 'other-support', label: 'Something else', help: [] },
];

export const SECTIONS = [
  {
    id: 'basic',
    title: 'About you',
    blurb: 'How a program would reach you if something matches.',
    fields: [
      { name: 'first_name', label: 'First name', type: 'text', counts: true, autocomplete: 'given-name' },
      { name: 'last_name', label: 'Last name', type: 'text', autocomplete: 'family-name' },
      { name: 'phone', label: 'Phone number', type: 'tel', autocomplete: 'tel', hint: 'Optional — only used if you ask a program to call you.' },
      { name: 'contact_preference', label: 'Best way to reach you', type: 'select', options: CONTACT_METHODS, counts: true },
      {
        name: 'age_range',
        label: 'Your age',
        type: 'select',
        options: AGE_RANGES,
        counts: true,
        hint: 'A range is all we need — some programs are only for people over 60, 62, or 65.',
      },
    ],
  },
  {
    id: 'household',
    title: 'Your household',
    blurb: 'Income limits are set per household size, so this changes almost every match.',
    fields: [
      {
        name: 'household_size',
        label: 'How many people live with you, including you?',
        type: 'counter',
        min: 1,
        max: 20,
        counts: true,
      },
      { name: 'adults_count', label: 'How many are adults?', type: 'counter', min: 0, max: 20 },
      { name: 'children_count', label: 'How many are children?', type: 'counter', min: 0, max: 20, counts: true },
      { name: 'dependents_count', label: 'How many are dependents?', type: 'counter', min: 0, max: 20 },
      { name: 'household_composition', label: 'Who lives there', type: 'select', options: HOUSEHOLD_COMPOSITIONS },
      {
        name: 'is_pregnant',
        label: 'Someone in the household is pregnant',
        type: 'checkbox',
        hint: 'Some programs count an expected child the same as a child in the home.',
      },
    ],
  },
  {
    id: 'housing',
    title: 'Your housing',
    blurb: 'Where you are now, and where you would like to be.',
    fields: [
      { name: 'housing_status', label: 'Your housing right now', type: 'select', options: HOUSING_STATUSES, counts: true },
      {
        name: 'at_risk_of_homelessness',
        label: 'I’m at risk of losing my housing',
        type: 'checkbox',
        hint: 'Behind on rent, facing eviction, or a shutoff notice.',
      },
      { name: 'state', label: 'State', type: 'select', options: STATES.map((s) => ({ value: s.code, label: s.label })), counts: true },
      {
        name: 'preferred_counties',
        label: 'Counties that work for you',
        type: 'counties',
        counts: true,
        hint: 'Pick every one — programs and rentals often cross county lines.',
      },
      { name: 'preferred_cities', label: 'Cities or towns', type: 'tags', hint: 'Optional. Separate with commas.' },
      { name: 'preferred_zips', label: 'ZIP codes', type: 'tags', hint: 'Optional. Separate with commas.' },
      { name: 'current_rent', label: 'What you pay now', type: 'money', suffix: 'per month' },
      { name: 'desired_rent', label: 'The most you could pay', type: 'money', suffix: 'per month' },
      { name: 'housing_type', label: 'Kind of place', type: 'select', options: HOUSING_TYPES },
      { name: 'bedrooms_needed', label: 'Bedrooms needed (at least)', type: 'counter', min: 0, max: 8 },
      { name: 'bathrooms_needed', label: 'Bathrooms needed (at least)', type: 'counter', min: 0, max: 8 },
      { name: 'move_in_timeframe', label: 'When you need to move', type: 'select', options: MOVE_IN_TIMEFRAMES },
    ],
  },
  {
    id: 'financial',
    title: 'Income',
    blurb: 'Nearly every program sets a limit on gross household income. A close guess is fine.',
    fields: [
      {
        name: 'annual_income',
        label: 'Household income before taxes',
        type: 'income',
        counts: true,
        hint: 'Everyone’s gross income added together — the amount before taxes or anything else comes out.',
      },
      { name: 'employment_status', label: 'Your work situation', type: 'select', options: EMPLOYMENT_STATUSES, counts: true },
      { name: 'income_sources', label: 'Where your income comes from', type: 'multi', options: INCOME_SOURCES },
      { name: 'benefits', label: 'Benefits you already get', type: 'multi', options: BENEFITS, hint: 'Some programs require one of these; others rule you out if you have it. Either way it helps to know.' },
    ],
  },
  {
    id: 'needs',
    title: 'What you need help with',
    blurb: 'This decides which kinds of program lead your results.',
    fields: [
      { name: 'support_needs', label: 'Choose everything that applies', type: 'multi', options: SUPPORT_NEEDS, counts: true },
    ],
  },
  {
    id: 'circumstances',
    title: 'Anything that applies',
    blurb:
      'Every one of these is optional, and ticking one can only ever add programs built for that situation — never take any away.',
    fields: [
      { name: 'is_veteran', label: 'Someone in the household is a veteran', type: 'checkbox' },
      { name: 'has_disability', label: 'Someone in the household has a disability', type: 'checkbox' },
      { name: 'is_first_time_buyer', label: 'We would be first-time homebuyers', type: 'checkbox' },
      { name: 'has_utility_account', label: 'A utility account is in my name', type: 'checkbox' },
      { name: 'in_crisis', label: 'We’re facing an eviction, shutoff, or displacement', type: 'checkbox' },
    ],
  },
];

/** Every field, flattened, in section order. */
export const FIELDS = SECTIONS.flatMap((section) =>
  section.fields.map((field) => ({ ...field, section: section.id })),
);

const FIELD_NAMES = FIELDS.map((f) => f.name);

// ---------------------------------------------------------------------------
// Completion
// ---------------------------------------------------------------------------

function hasValue(value) {
  if (value == null) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'string') return value.trim() !== '';
  // 0 is a real answer: "no children", "no income", "a studio".
  return true;
}

/**
 * How complete the profile is, and which sections still want something.
 *
 * The percentage is computed here rather than stored, so it can never disagree
 * with the form the person is looking at.
 *
 * @returns {{pct: number, complete: boolean, sections: Array, incomplete: Array}}
 */
export function completion(profile) {
  const row = profile || {};
  const sections = SECTIONS.map((section) => {
    const counted = section.fields.filter((f) => f.counts);
    const done = counted.filter((f) => hasValue(row[f.name])).length;
    // A section with nothing counted (circumstances) is never "incomplete":
    // there is nothing there anyone is obliged to answer.
    const optional = counted.length === 0;
    return {
      id: section.id,
      title: section.title,
      done,
      total: counted.length,
      optional,
      complete: optional || done === counted.length,
      missing: counted.filter((f) => !hasValue(row[f.name])).map((f) => f.label),
    };
  });

  const totalCounted = sections.reduce((sum, s) => sum + s.total, 0);
  const totalDone = sections.reduce((sum, s) => sum + s.done, 0);
  const pct = totalCounted ? Math.round((totalDone / totalCounted) * 100) : 100;

  return {
    pct,
    complete: totalDone === totalCounted,
    sections,
    incomplete: sections.filter((s) => !s.complete),
  };
}

// ---------------------------------------------------------------------------
// Reading and writing
// ---------------------------------------------------------------------------

/**
 * The signed-in person's profile row.
 *
 * No user_id filter is sent, and none is needed: RLS scopes the query to the
 * JWT's own row (0016_user_accounts.sql), so this returns exactly one row or
 * none. Sending an id from the client would suggest the id is what grants
 * access, which it is not.
 */
export async function loadProfile() {
  const response = await authedFetch('profiles?select=*&limit=1');
  if (!response.ok) {
    throw new Error(`Couldn’t load your profile (${response.status}).`);
  }
  const rows = await response.json();
  return rows[0] || null;
}

/**
 * Writes changed fields.
 *
 * An UPSERT rather than an UPDATE so a profile still saves if the signup
 * trigger never ran — an account created before this feature shipped, for
 * instance. user_id is taken from the session, and RLS's `with check` rejects
 * any other value, so this cannot write into someone else's row.
 */
export async function saveProfile(patch) {
  const user = currentUser();
  if (!user?.id) throw new Error('Please sign in again.');

  const clean = {};
  for (const [key, value] of Object.entries(patch)) {
    if (!FIELD_NAMES.includes(key) && key !== 'profile_completed') continue;
    clean[key] = value === '' ? null : value;
  }
  if (!Object.keys(clean).length) return null;

  const response = await authedFetch('profiles?on_conflict=user_id', {
    method: 'POST',
    headers: {
      Prefer: 'resolution=merge-duplicates,return=representation',
    },
    body: JSON.stringify({ user_id: user.id, ...clean }),
  });

  if (!response.ok) {
    let detail = '';
    try {
      const body = await response.json();
      detail = body.message || body.details || body.hint || '';
    } catch {
      /* no body */
    }
    // A check-constraint violation means the client sent a value the schema
    // does not allow, which is a bug here rather than something the person did
    // wrong — but they still need to be told the save did not happen.
    throw new Error(detail ? `Couldn’t save: ${detail}` : 'Couldn’t save your profile. Please try again.');
  }
  const rows = await response.json();
  return rows[0] || null;
}

// ---------------------------------------------------------------------------
// Saved and recently viewed
// ---------------------------------------------------------------------------

export async function loadSaved() {
  const response = await authedFetch(
    'saved_opportunities?select=*&order=created_at.desc&limit=100',
  );
  if (!response.ok) return [];
  return response.json();
}

export async function loadViewed(limit = 8) {
  const response = await authedFetch(
    `viewed_opportunities?select=*&order=viewed_at.desc&limit=${Number(limit) || 8}`,
  );
  if (!response.ok) return [];
  return response.json();
}

function opportunityRef({ kind, id, snapshot }) {
  const user = currentUser();
  if (!user?.id) throw new Error('Please sign in again.');
  return {
    user_id: user.id,
    kind,
    program_id: kind === 'program' ? id : null,
    listing_id: kind === 'listing' ? String(id) : null,
    // Programs are read live from the database, so only listings carry a
    // snapshot — a rental can vanish from the feed the same week.
    snapshot: kind === 'listing' ? snapshot || null : null,
  };
}

export async function saveOpportunity({ kind, id, snapshot }) {
  const response = await authedFetch(
    'saved_opportunities?on_conflict=user_id,kind,program_id,listing_id',
    {
      method: 'POST',
      headers: { Prefer: 'resolution=ignore-duplicates,return=minimal' },
      body: JSON.stringify(opportunityRef({ kind, id, snapshot })),
    },
  );
  return response.ok;
}

export async function unsaveOpportunity({ kind, id }) {
  const column = kind === 'program' ? 'program_id' : 'listing_id';
  const response = await authedFetch(
    `saved_opportunities?kind=eq.${encodeURIComponent(kind)}&${column}=eq.${encodeURIComponent(id)}`,
    { method: 'DELETE', headers: { Prefer: 'return=minimal' } },
  );
  return response.ok;
}

/**
 * Records that something was opened. Best-effort by design: a failure here is
 * never allowed to interrupt someone reading a program's details, so it
 * resolves either way and never throws.
 */
export async function recordView({ kind, id, snapshot }) {
  try {
    await authedFetch('viewed_opportunities?on_conflict=user_id,kind,program_id,listing_id', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify({ ...opportunityRef({ kind, id, snapshot }), viewed_at: new Date().toISOString() }),
    });
  } catch {
    /* history is a convenience, never a blocker */
  }
}

// ---------------------------------------------------------------------------
// Profile -> the screener's answers
// ---------------------------------------------------------------------------

const SENIOR_RANGES = new Set(['60-61', '62-64', '65-plus']);

/** area_ids for the chosen counties, so income limits resolve. */
function areaIdsFor(stateCode, counties) {
  const state = STATES.find((s) => s.code === stateCode);
  if (!state) return { areaIds: [], statewideAreaId: null };
  const wanted = new Set(counties || []);
  return {
    areaIds: state.counties.filter((c) => wanted.has(c.name)).map((c) => c.areaId),
    statewideAreaId: state.statewideAreaId,
  };
}

/**
 * Converts a profile row into the exact `answers` object the wizard produces,
 * so one matcher serves both paths.
 *
 * Anything the person hasn't filled in stays null/empty rather than being
 * guessed at: the matcher reads null as "unknown" and keeps the program with a
 * note, which is the house rule — missing information never excludes anyone.
 */
export function profileToAnswers(profile) {
  const row = profile || {};
  const counties = row.preferred_counties || [];
  const { areaIds, statewideAreaId } = areaIdsFor(row.state, counties);

  // Needs -> the screener's four help categories.
  const help = [];
  for (const need of row.support_needs || []) {
    const known = SUPPORT_NEEDS.find((n) => n.value === need);
    for (const category of known?.help || []) {
      if (!help.includes(category)) help.push(category);
    }
  }

  // Tenure. 'staying' in the wizard is paired with a rent-or-own answer;
  // everything else the housing status implies directly.
  let situation = null;
  if (row.housing_status === 'renting') situation = 'renting';
  else if (row.housing_status === 'homeowner') situation = 'homeowner';
  else if (row.housing_status === 'buying') situation = 'buying';

  const unhoused =
    row.housing_status === 'unhoused' ||
    row.housing_status === 'transitional' ||
    row.housing_status === 'staying-with-others';

  return {
    state: row.state || null,
    counties,
    county: counties[0] || null,
    areaIds,
    areaId: areaIds[0] || null,
    statewideAreaId,
    help,
    situation,
    householdSize: row.household_size || 1,
    income: row.annual_income == null ? null : Number(row.annual_income),
    incomePeriod: row.income_period || 'year',
    bedrooms: row.bedrooms_needed == null ? null : String(row.bedrooms_needed),
    bathrooms: row.bathrooms_needed == null ? null : String(row.bathrooms_needed),
    maxRent: row.desired_rent == null ? null : Number(row.desired_rent),
    circumstances: {
      veteran: Boolean(row.is_veteran),
      senior: SENIOR_RANGES.has(row.age_range),
      disability: Boolean(row.has_disability),
      // Pregnancy counts: the programs' own children_rule reads "children in
      // the household or pregnancy".
      children: (row.children_count || 0) > 0 || Boolean(row.is_pregnant),
      crisis: Boolean(row.in_crisis) || Boolean(row.at_risk_of_homelessness),
      firstTimeBuyer: Boolean(row.is_first_time_buyer),
      utilityAccount: Boolean(row.has_utility_account),
      unhoused,
    },
  };
}

/**
 * The reverse trip: the wizard's answers as a profile patch, so someone who
 * has just finished screening anonymously can keep what they typed instead of
 * entering it a second time.
 */
export function answersToProfile(answers) {
  const a = answers || {};
  const needs = [];
  for (const category of a.help || []) {
    for (const need of SUPPORT_NEEDS) {
      if (need.help.includes(category) && !needs.includes(need.value)) needs.push(need.value);
    }
  }

  const circumstances = a.circumstances || {};
  let housingStatus = null;
  if (circumstances.unhoused) housingStatus = 'unhoused';
  else if (a.situation === 'renting') housingStatus = 'renting';
  else if (a.situation === 'homeowner') housingStatus = 'homeowner';
  else if ((a.help || []).includes('buying')) housingStatus = 'buying';
  else if ((a.help || []).includes('rental')) housingStatus = 'renting';

  const patch = {
    state: a.state || null,
    preferred_counties: (a.counties || []).length ? a.counties : null,
    household_size: a.householdSize || null,
    annual_income: a.income == null ? null : a.income,
    income_period: a.incomePeriod || null,
    support_needs: needs.length ? needs : null,
    housing_status: housingStatus,
    bedrooms_needed: a.bedrooms != null && a.bedrooms !== 'any' ? Number(a.bedrooms) : null,
    bathrooms_needed: a.bathrooms != null && a.bathrooms !== 'any' ? Number(a.bathrooms) : null,
    desired_rent: a.maxRent == null ? null : a.maxRent,
    is_veteran: circumstances.veteran || null,
    has_disability: circumstances.disability || null,
    is_first_time_buyer: circumstances.firstTimeBuyer || null,
    has_utility_account: circumstances.utilityAccount || null,
    in_crisis: circumstances.crisis || null,
  };

  // Only send what the person actually answered, so importing a half-finished
  // screening never blanks out a field they had already filled in by hand.
  for (const key of Object.keys(patch)) {
    if (patch[key] == null) delete patch[key];
  }
  return patch;
}
