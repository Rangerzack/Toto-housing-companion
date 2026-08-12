// ---------------------------------------------------------------------------
// Matching engine
// ---------------------------------------------------------------------------
// The source matrix records eligibility rules as free-text prose written by
// researchers, not as structured flags. "None (priority only: age 60+)" means
// there is NO age requirement; "Not specified in program materials reviewed"
// means nobody could confirm one either way. Naive keyword matching would read
// both as age restrictions and wrongly turn people away.
//
// So this engine only hard-excludes on fields it can trust:
//
//   * county          — a real relational table (program_counties)
//   * ami_min/ami_max — real numbers
//   * eligible_tenure — semi-structured, small controlled vocabulary
//
// Everything else is a soft signal: a program is excluded on a prose rule only
// when the text affirmatively states a requirement the person doesn't meet.
// When a rule is ambiguous the program stays in the results with a plain
// "worth checking" note, because a false exclusion costs someone housing help
// while a false inclusion costs them a phone call.

// How far over a published limit someone's GROSS income can be before the
// program is ruled out. Programs test ADJUSTED income — gross minus deductions
// for dependents, childcare, and medical or disability expenses — so a gross
// figure modestly over the line often still qualifies. Anything inside the
// margin is surfaced as a prompt instead of an exclusion.
const OVER_LIMIT_MARGIN = 1.2;

const money = (amount) =>
  `$${Math.round(amount).toLocaleString('en-US')}`;

const NO_REQUIREMENT_PATTERNS = [
  /^\s*$/,
  /^\s*(no|none|n\/a)\b/i,
  /^\s*not\b/i, // "Not specified...", "Not explicitly, but..."
  /priority only/i,
  /voluntary demographic/i,
];

const REQUIREMENT_PATTERNS = [/^\s*yes\b/i, /\bmust\b/i, /\brequired?\b/i];

/**
 * Reads a prose rule field.
 * @returns {'required'|'not-required'|'unknown'}
 */
export function readRule(text) {
  const value = (text || '').trim();
  if (NO_REQUIREMENT_PATTERNS.some((re) => re.test(value))) return 'not-required';
  if (REQUIREMENT_PATTERNS.some((re) => re.test(value))) return 'required';
  return value ? 'unknown' : 'not-required';
}

/**
 * Which median a program measures income against.
 *
 * Mixing these up is a silent, consequential error: 60% of Oregon's STATE
 * median for a two-person household is $50,194, while Josephine County's 60%
 * AREA median is $40,140 — testing a utility applicant against the county
 * figure wrongly rejects them.
 *
 * The answer comes from program_income_rules, which load_data.py derives from
 * each program's own income-standard text. Category is only a fallback for
 * programs with no rule row, and it is not reliable on its own: the RVAR/OAR
 * homebuyer program is categorised Down Payment Assistance but tests against
 * "the State of Oregon Median Income Limit".
 */
export function standardForProgram(program) {
  const declared = program.income_rule?.standard_id;
  if (declared) return declared;
  return program.category === 'Utility Reduction' ? 'OR-SMI' : 'HUD-MFI';
}

/**
 * Resolves the dollar limit a program tests against.
 *
 * `lookup(standardId, tierPct, householdSize)` returns a published figure or
 * null. Only 30/50/60/80 are published; a program written against a tier we
 * don't hold (100%, 115%, 70%) is scaled from the nearest one and marked
 * approximate, so callers know not to exclude anyone on it.
 *
 * @returns {{amount: number, approximate: boolean}|null}
 */
export function resolveLimit(lookup, standardId, tierPct, householdSize) {
  const exact = lookup(standardId, tierPct, householdSize);
  if (exact != null) return { amount: exact, approximate: false };

  for (const anchor of [80, 60, 50, 30]) {
    const value = lookup(standardId, anchor, householdSize);
    if (value != null) {
      return { amount: (value / anchor) * tierPct, approximate: true };
    }
  }
  return null;
}

function matchesTenure(eligibleTenure, situation) {
  const raw = (eligibleTenure || '').toLowerCase();
  if (!raw.trim()) return 'unknown';

  // Strip "prospective homeowner" first so it can't satisfy a test for someone
  // who already owns their home.
  const withoutProspective = raw.replace(/prospective homeowner/g, '');

  const isRenter = /renter/.test(raw);
  const isOwner = /homeowner/.test(withoutProspective);
  const isBuyer = /prospective homeowner|first-time/.test(raw);
  const isUnhoused = /homeless|unstably housed|transitional|unhoused/.test(raw);

  switch (situation) {
    case 'renting':
      return isRenter ? 'match' : 'no-match';
    case 'homeowner':
      return isOwner ? 'match' : 'no-match';
    case 'buying':
      return isBuyer ? 'match' : 'no-match';
    case 'unhoused':
      // Rent-support programs routinely move people from unhoused into a
      // tenancy, so they stay in play rather than being filtered out.
      if (isUnhoused) return 'match';
      return isRenter ? 'unknown' : 'no-match';
    default:
      return 'unknown';
  }
}

// Circumstances the person can tell us about, paired with the prose column
// that would gate on them.
const CIRCUMSTANCE_RULES = [
  { key: 'veteran', field: 'veteran_rule', label: 'veteran status' },
  { key: 'senior', field: 'age_rule', label: 'the age of household members' },
  { key: 'disability', field: 'disability_rule', label: 'a household member with a disability' },
  { key: 'children', field: 'children_rule', label: 'children in the household or pregnancy' },
  { key: 'crisis', field: 'crisis_required', label: 'an eviction, shutoff, or displacement crisis' },
  { key: 'firstTimeBuyer', field: 'first_time_buyer', label: 'first-time homebuyer status' },
  { key: 'utilityAccount', field: 'utility_required', label: 'a utility account in your name' },
];

/**
 * Scores one program against the wizard answers.
 * @returns {{verdict: 'likely'|'possible'|'excluded', checks: string[], reason: string|null}}
 */
export function evaluateProgram(program, answers, lookup) {
  const checks = [];
  const eligibility = program.eligibility || {};
  const counties = (program.program_counties || []).map((c) => c.county);

  // --- County (hard) ---------------------------------------------------
  const servesCounty =
    counties.includes(answers.county) || counties.includes('Statewide');
  const countyUnspecified = counties.includes('Unspecified');
  if (!servesCounty && !countyUnspecified) {
    return { verdict: 'excluded', checks, reason: `Does not serve ${answers.county} County` };
  }
  if (!servesCounty && countyUnspecified) {
    checks.push(`Service area isn't clearly documented — confirm they cover ${answers.county} County.`);
  }

  // --- Housing situation (hard, where documented) -----------------------
  const tenure = matchesTenure(eligibility.eligible_tenure, answers.situation);
  if (tenure === 'no-match') {
    return { verdict: 'excluded', checks, reason: 'Serves a different housing situation' };
  }
  if (tenure === 'unknown') {
    checks.push('Confirm the program serves your housing situation.');
  }

  // --- Income (hard, against published dollar limits) --------------------
  const amiMax = eligibility.ami_max == null ? null : Number(eligibility.ami_max);
  const amiMin = eligibility.ami_min == null ? null : Number(eligibility.ami_min);
  const standardId = standardForProgram(program);

  const limit = amiMax
    ? resolveLimit(lookup, standardId, amiMax, answers.householdSize)
    : null;

  if (amiMax && answers.income != null) {
    if (!limit) {
      checks.push(`Has an income limit (${amiMax}% of median) that isn't published for your area yet — ask the program directly.`);
    } else if (limit.approximate) {
      // Never exclude on a scaled figure; it isn't a published limit.
      if (answers.income > limit.amount) {
        checks.push(`Your income may be above this program's ${amiMax}% limit — the exact figure isn't published for your area, so it's worth asking.`);
      }
    } else if (answers.income > limit.amount * OVER_LIMIT_MARGIN) {
      return { verdict: 'excluded', checks, reason: 'Household income is above the program limit' };
    } else if (answers.income > limit.amount) {
      // Programs count ADJUSTED income — gross minus deductions for
      // dependents, childcare, and medical or disability expenses — which is
      // always lower than the gross figure someone types in here. Being over
      // on gross is genuinely not a decision, so it is a prompt, not a cut.
      checks.push(`Your income is above the published limit of ${money(limit.amount)}, but programs count income after deductions for dependents and medical costs — still worth applying.`);
    }
  }

  if (amiMin && answers.income != null) {
    const floor = resolveLimit(lookup, standardId, amiMin, answers.householdSize);
    if (floor && answers.income < floor.amount) {
      checks.push(`This program also has a minimum income of about ${money(floor.amount)} — confirm you qualify.`);
    }
  }

  if (amiMax && answers.income == null) {
    checks.push(
      limit && !limit.approximate
        ? `Income must be under about ${money(limit.amount)} for a household of ${answers.householdSize}.`
        : `Has an income limit (${amiMax}% of median) — check where your household falls.`,
    );
  }

  // --- Prose circumstance rules (soft) ----------------------------------
  // Someone who is already unhoused satisfies any displacement requirement —
  // they won't tick a box about *becoming* displaced, but programs whose rules
  // read "at risk of eviction, or already experiencing homelessness" are
  // squarely meant for them.
  const circumstances = {
    ...(answers.circumstances || {}),
    crisis: Boolean(answers.circumstances?.crisis) || answers.situation === 'unhoused',
  };

  for (const { key, field, label } of CIRCUMSTANCE_RULES) {
    const state = readRule(eligibility[field]);
    const personHasIt = Boolean(circumstances[key]);
    if (state === 'required' && !personHasIt) {
      return { verdict: 'excluded', checks, reason: `Requires ${label}` };
    }
    if (state === 'unknown' && !personHasIt) {
      checks.push(`May have requirements around ${label}.`);
    }
  }

  return {
    verdict: checks.length ? 'possible' : 'likely',
    checks,
    reason: null,
  };
}

const CONFIDENCE_RANK = { high: 0, medium: 1, moderate: 1, low: 2 };

function confidenceRank(program) {
  const raw = (program.verification?.confidence || '').toLowerCase();
  for (const [word, rank] of Object.entries(CONFIDENCE_RANK)) {
    if (raw.startsWith(word)) return rank;
  }
  return 3;
}

/**
 * Evaluates every program and returns the matches, best first.
 * `lookup(standardId, tierPct, householdSize)` resolves published dollar limits.
 */
export function screenPrograms(programs, answers, lookup) {
  const results = [];
  for (const program of programs) {
    const result = evaluateProgram(program, answers, lookup);
    if (result.verdict !== 'excluded') {
      results.push({ program, ...result });
    }
  }

  const verdictOrder = { likely: 0, possible: 1 };
  results.sort((a, b) => {
    const byVerdict = verdictOrder[a.verdict] - verdictOrder[b.verdict];
    if (byVerdict) return byVerdict;

    // A program you can actually get a form for beats one you can't.
    const aForm = a.program.forms?.some((f) => f.has_real_form) ? 0 : 1;
    const bForm = b.program.forms?.some((f) => f.has_real_form) ? 0 : 1;
    if (aForm !== bForm) return aForm - bForm;

    const byChecks = a.checks.length - b.checks.length;
    if (byChecks) return byChecks;

    return confidenceRank(a.program) - confidenceRank(b.program);
  });

  return results;
}
