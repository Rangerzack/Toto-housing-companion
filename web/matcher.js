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

/** Estimated AMI percentage, or null when income wasn't provided. */
export function estimateAmiPercent(annualIncome, householdSize, areaMedianIncomeFor) {
  if (annualIncome == null || !householdSize) return null;
  const median = areaMedianIncomeFor(householdSize);
  if (!median) return null;
  return (annualIncome / median) * 100;
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
export function evaluateProgram(program, answers, areaMedianIncomeFor) {
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

  // --- Income (hard, where there are real numbers) ----------------------
  const amiPercent = estimateAmiPercent(
    answers.income,
    answers.householdSize,
    areaMedianIncomeFor,
  );
  const amiMax = eligibility.ami_max == null ? null : Number(eligibility.ami_max);
  const amiMin = eligibility.ami_min == null ? null : Number(eligibility.ami_min);

  if (amiPercent != null && amiMax) {
    // A 10% relative grace band, because the AMI table is an estimate and HUD
    // limits vary by county — someone just over the line should still see the
    // program rather than being silently dropped.
    if (amiPercent > amiMax * 1.1) {
      return { verdict: 'excluded', checks, reason: 'Household income is above the program limit' };
    }
    if (amiPercent > amiMax) {
      checks.push(
        `Your income is right around this program's limit (${amiMax}% AMI) — worth applying anyway, since official limits vary by county.`,
      );
    }
  }
  if (amiPercent != null && amiMin) {
    if (amiPercent < amiMin) {
      checks.push(`This program also has a minimum income (${amiMin}% AMI) — confirm you qualify.`);
    }
  }
  if (amiPercent == null && amiMax) {
    checks.push(`Has an income limit (${amiMax}% AMI) — check where your household falls.`);
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

/** Evaluates every program and returns the matches, best first. */
export function screenPrograms(programs, answers, areaMedianIncomeFor) {
  const results = [];
  for (const program of programs) {
    const result = evaluateProgram(program, answers, areaMedianIncomeFor);
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
