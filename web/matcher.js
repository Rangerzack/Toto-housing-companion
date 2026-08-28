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
// program is ruled out. The figure typed into the wizard is a rough annual
// estimate, and programs measure income their own way — some count only the
// most recent month (Minnesota's EAP), some count different household
// members, and HUD programs apply deductions when setting the rent share.
// A figure modestly over the line is therefore a prompt, not an exclusion.
const OVER_LIMIT_MARGIN = 1.1;

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

// "QUALIFYING: 65 years of age or older" / "62 or older QUALIFIES" — one of
// several routes into the program, any single one of which is enough. These
// are not requirements: someone who qualifies through disability must not be
// demoted for leaving the veteran box unticked. All of a program's qualifying
// rules are pooled and satisfied together by any one matching circumstance.
// (The deliberately narrow pattern skips prose like "households qualify
// without FSS participation", which is an exemption note, not a route.)
const QUALIFYING_PATTERN = /^\s*qualifying\b|\bqualifies\b/i;

/**
 * Reads a prose rule field.
 * @returns {'required'|'not-required'|'qualifying'|'unknown'}
 */
export function readRule(text) {
  const value = (text || '').trim();
  if (NO_REQUIREMENT_PATTERNS.some((re) => re.test(value))) return 'not-required';
  if (QUALIFYING_PATTERN.test(value)) return 'qualifying';
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
export function resolveLimit(lookup, standardId, tierPct, householdSize, proportional) {
  const exact = lookup(standardId, tierPct, householdSize);
  if (exact != null) return { amount: exact, approximate: false };

  for (const anchor of [100, 80, 60, 50, 30]) {
    const value = lookup(standardId, anchor, householdSize);
    if (value != null) {
      // Scaling is exact for standards defined as percentages of one base:
      // 200% FPG is exactly twice the guideline, 60% SMI exactly 1.2x the 50%
      // figure. HUD's AMI tiers are each computed separately with their own
      // caps, so scaling between them is an estimate and must not exclude.
      return {
        amount: (value / anchor) * tierPct,
        approximate: !proportional?.has(standardId),
      };
    }
  }
  return null;
}

// What kind of help a program provides, read from its category. Oregon's
// categories are a clean set of three; Minnesota's are free text ("Utility
// crisis fund - county cash grant", "Home repair - deferred forgivable loan"),
// so this tests for words rather than exact values.
const HELP_PATTERNS = {
  utility: /utility|energy|heat|water|sewer|electric|gas|weatheriz/i,
  housing: /rent|housing|shelter|homeless|stabili|down payment|homebuyer|home ?ownership|home repair|mortgage|rehabilitation/i,
};

/**
 * Whether a program belongs to the kind of help someone asked for.
 *
 * The three paths do not filter symmetrically, because they are not
 * symmetric problems:
 *
 *   utility  — utility programs only. The person named the bill.
 *   finding  — housing programs only. A gas discount does not find anyone a
 *              home, so leaving those in is just noise.
 *   staying  — BOTH. A shutoff notice is one of the things that costs people
 *              their housing, so utility help belongs in this answer. St.
 *              Cloud shows why: its matrix is overwhelmingly utility-
 *              categorised, and filtering them out left someone asking how to
 *              keep their home with a single result.
 *
 * Programs whose category matches neither pattern — generic emergency funds,
 * referral desks — are never filtered out. An unclassifiable category is
 * missing information, and missing information does not exclude anyone.
 */
function matchesHelpType(category, needs) {
  if (!needs || !needs.length) return true;

  const text = category || '';
  const isUtility = HELP_PATTERNS.utility.test(text);
  const isHousing = HELP_PATTERNS.housing.test(text);
  if (!isUtility && !isHousing) return true;

  // "Staying in my home" spans housing AND utilities — a shutoff notice is
  // one of the things that costs people their housing. A program matching
  // ANY picked need stays in.
  if (isUtility && (needs.includes('utility') || needs.includes('staying'))) return true;
  if (isHousing && (needs.includes('rental') || needs.includes('staying') || needs.includes('buying'))) return true;
  return false;
}

function matchesTenure(eligibleTenure, situations) {
  // Utility- or healthcare-only visits imply no situation at all, so nothing
  // is filtered on tenure.
  if (!situations || !situations.length) return 'match';

  const raw = (eligibleTenure || '').toLowerCase();
  if (!raw.trim()) return 'unknown';

  // Strip "prospective homeowner" first so it can't satisfy a test for someone
  // who already owns their home.
  const withoutProspective = raw.replace(/prospective homeowner/g, '');

  const isRenter = /renter/.test(raw);
  const isOwner = /homeowner/.test(withoutProspective);
  const isBuyer = /prospective homeowner|first-time/.test(raw);
  const isUnhoused = /homeless|unstably housed|transitional|unhoused/.test(raw);

  // A program matching ANY of the person's situations stays in.
  let best = 'no-match';
  for (const situation of situations) {
    let verdict = 'unknown';
    switch (situation) {
      case 'renting':
        verdict = isRenter ? 'match' : 'no-match';
        break;
      case 'homeowner':
        verdict = isOwner ? 'match' : 'no-match';
        break;
      case 'buying':
        verdict = isBuyer ? 'match' : 'no-match';
        break;
      case 'unhoused':
        // Rent-support programs routinely move people from unhoused into a
        // tenancy, so they stay in play rather than being filtered out.
        verdict = isUnhoused ? 'match' : isRenter ? 'unknown' : 'no-match';
        break;
      default:
        verdict = 'unknown';
    }
    if (verdict === 'match') return 'match';
    if (verdict === 'unknown') best = 'unknown';
  }
  return best;
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
export function evaluateProgram(program, answers, lookup, proportional) {
  const checks = [];
  const eligibility = program.eligibility || {};

  // --- County (hard) ---------------------------------------------------
  // Matched on county AND state. Oregon and Minnesota both have a Douglas
  // County, so a name alone would show Minnesota programs to Oregon residents.
  const inState = (program.program_counties || [])
    .filter((c) => !c.state_code || c.state_code === answers.state)
    .map((c) => c.county);

  const servesCounty =
    inState.includes(answers.county) || inState.includes('Statewide');
  const countyUnspecified = inState.includes('Unspecified');
  if (!servesCounty && !countyUnspecified) {
    return { verdict: 'excluded', checks, reason: `Does not serve ${answers.county} County` };
  }
  if (!servesCounty && countyUnspecified) {
    checks.push(`Service area isn't clearly documented — confirm they cover ${answers.county} County.`);
  }

  // --- Kind of help (hard, where the category is classifiable) ----------
  const needs = Array.isArray(answers.help) ? answers.help : answers.help ? [answers.help] : [];
  if (needs.length && !matchesHelpType(program.category, needs)) {
    return {
      verdict: 'excluded',
      checks,
      reason: 'Helps with a different kind of need than the ones you picked',
    };
  }

  // --- Housing situation (hard, where documented) -----------------------
  // Every picked need implies its situations: seeking a rental implies
  // renting, buying implies a prospective buyer, and "staying in my home"
  // carries the rent-or-own answer.
  const situations = [];
  if (needs.includes('rental')) situations.push('renting');
  if (needs.includes('buying')) situations.push('buying');
  if (needs.includes('staying') && answers.situation) situations.push(answers.situation);
  const tenure = matchesTenure(eligibility.eligible_tenure, situations);
  if (tenure === 'no-match') {
    return { verdict: 'excluded', checks, reason: 'Serves a different housing situation' };
  }
  if (tenure === 'unknown') {
    checks.push('Confirm the program serves your housing situation.');
  }

  // --- Income (hard, against published dollar limits) --------------------
  // The tier comes from program_income_rules first. For the Minnesota programs
  // the AMI columns read "N/A (uses State Median Income, not AMI)", so
  // eligibility.ami_max is null and the only statement of the threshold is the
  // one the loader parsed out of the prose. Reading eligibility alone left
  // every SMI- and FPG-tested program with no income test at all.
  const rule = program.income_rule || {};
  const pick = (ruleValue, eligibilityValue) => {
    const value = ruleValue != null ? ruleValue : eligibilityValue;
    return value == null ? null : Number(value);
  };
  const amiMax = pick(rule.tier_max_pct, eligibility.ami_max);
  const amiMin = pick(rule.tier_min_pct, eligibility.ami_min);
  const standardId = standardForProgram(program);

  const limit = amiMax
    ? resolveLimit(lookup, standardId, amiMax, answers.householdSize, proportional)
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
      // The annual figure typed here is an estimate, and programs measure
      // income their own way — different windows, different members counted.
      // Being modestly over on that basis is not a decision, so it is a
      // prompt, not a cut.
      checks.push(`Your income is a little above the published limit of ${money(limit.amount)}, but programs measure income their own way — some count only your most recent month — so it's still worth applying.`);
    }
  }

  if (amiMin && answers.income != null) {
    const floor = resolveLimit(lookup, standardId, amiMin, answers.householdSize, proportional);
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
    crisis: Boolean(answers.circumstances?.crisis) || situations.includes('unhoused'),
    // Someone who came here to pay a utility bill has a utility bill. Making
    // them tick the box as well produced a caveat on almost every Minnesota
    // result, since 28 of its 34 programs gate on the account.
    utilityAccount:
      Boolean(answers.circumstances?.utilityAccount) || needs.includes('utility'),
  };

  // Any-of qualifying paths are pooled across all of a program's rules:
  // matching ANY one path satisfies the whole group, and only when none
  // matches does the program get a single combined note.
  const qualifyingUnmet = [];
  let qualifyingMet = false;

  for (const { key, field, label } of CIRCUMSTANCE_RULES) {
    const state = readRule(eligibility[field]);
    const personHasIt = Boolean(circumstances[key]);

    if (state === 'qualifying') {
      if (personHasIt) qualifyingMet = true;
      else qualifyingUnmet.push(label);
      continue;
    }

    // An unticked box is NOT a "no". The person may not have read that far,
    // may be unsure, or may not have thought it applied — and the question
    // itself promises that skipping one never counts against them. So a
    // requirement they haven't confirmed demotes the program to "possible"
    // and explains itself, rather than hiding it.
    //
    // Minnesota is why this matters: 28 of 34 programs require a utility
    // account and 17 require a crisis, so treating unticked as "no" left
    // someone who skipped the checkboxes with a single result.
    if (!personHasIt) {
      if (state === 'required') {
        checks.push(`Only for households with ${label} — confirm this applies to you.`);
      } else if (state === 'unknown') {
        checks.push(`May have requirements around ${label}.`);
      }
    }
  }

  if (!qualifyingMet && qualifyingUnmet.length) {
    checks.push(
      qualifyingUnmet.length === 1
        ? `Qualifies through ${qualifyingUnmet[0]} — confirm this applies to your household.`
        : `Qualifies through any one of: ${qualifyingUnmet.join('; ')} — matching a single one is enough.`,
    );
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
export function screenPrograms(programs, answers, lookup, proportional) {
  const results = [];
  for (const program of programs) {
    const result = evaluateProgram(program, answers, lookup, proportional);
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
