// ---------------------------------------------------------------------------
// Matching a saved profile
// ---------------------------------------------------------------------------
// A thin, explainable layer over the two engines this app already has:
// evaluateProgram() in matcher.js for programs, and the same screening rules
// as screenListings() in housing.js for rentals. Nothing about eligibility is
// decided here — this module only turns a verdict into the structured,
// quotable result the dashboard renders:
//
//   { matchType, score, matchedCriteria, missingCriteria, failedCriteria,
//     explanation }
//
// The score is arithmetic, not a judgement: it is derived from the criteria
// below by a formula you can read in ten seconds (see scoreFor). Every point
// of it traces to a named criterion, so a number on screen can always be
// explained by the list printed next to it. That is the whole point — a person
// being told they might not qualify for housing help deserves a reason, not a
// confidence rating.
//
// Adding a program to the database is enough to make it matchable: the
// eligibility columns are read generically, so nothing here changes.

import { evaluateProgram } from './matcher.js?v=__BUILD__';
import { bedroomsLabel, monthlyBudget } from './housing.js?v=__BUILD__';
import { profileToAnswers } from './profile.js?v=__BUILD__';

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------
// strong  — every known criterion is met, nothing left to verify.
// possible— met what we can check, but something is unconfirmed. Each open
//           question costs POINTS_PER_OPEN_QUESTION, because a result with one
//           thing to check is a better lead than one with five.
// none    — a documented criterion is definitely not met.
//
// The targeted-fit bonus mirrors the matcher's own ranking: a veterans' fund
// for a veteran household is a better match than a general fund both qualify
// for, and it should sort that way.
const POINTS_PER_OPEN_QUESTION = 12;
const POINTS_PER_TARGETED_FIT = 5;
const MAX_FIT_BONUS = 15;
const MIN_POSSIBLE_SCORE = 40;

function scoreFor({ verdict, openQuestions, fits }) {
  if (verdict === 'excluded') return 0;
  const penalty = openQuestions * POINTS_PER_OPEN_QUESTION;
  const bonus = Math.min(fits * POINTS_PER_TARGETED_FIT, MAX_FIT_BONUS);
  const base = Math.max(100 - penalty, MIN_POSSIBLE_SCORE);
  return Math.max(0, Math.min(100, base + bonus));
}

const MATCH_TYPES = { likely: 'strong', possible: 'possible', excluded: 'none' };

function explain(matchType, { matchedCriteria, missingCriteria, failedCriteria }) {
  if (matchType === 'none') {
    return failedCriteria.length
      ? `You don't appear to qualify: ${failedCriteria[0].toLowerCase()}.`
      : 'You don’t appear to meet this program’s requirements.';
  }
  if (matchType === 'strong') {
    return matchedCriteria.length
      ? 'You appear eligible based on the information in your profile.'
      : 'Nothing in your profile rules this out — worth a call.';
  }
  const count = missingCriteria.length;
  return `You meet what we can check so far. ${count} thing${count === 1 ? '' : 's'} still ${
    count === 1 ? 'needs' : 'need'
  } confirming with the program.`;
}

// ---------------------------------------------------------------------------
// Programs
// ---------------------------------------------------------------------------

/**
 * Scores one program against one profile.
 *
 * @param {object} profile  a row from `profiles`
 * @param {object} program  a program with its eligibility/counties embeds
 * @param {function} lookup (standardId, tierPct, householdSize) => number|null
 * @param {Set<string>} proportional  standards that scale linearly
 */
export function matchUserToProgram(profile, program, lookup, proportional) {
  const answers = profileToAnswers(profile);
  return matchAnswersToProgram(answers, program, lookup, proportional);
}

/** The same, for callers that already hold an `answers` object (the wizard). */
export function matchAnswersToProgram(answers, program, lookup, proportional) {
  const result = evaluateProgram(program, answers, lookup, proportional);

  const matchedCriteria = result.matched || [];
  // The matcher's "checks" are exactly the things it could not confirm, which
  // is what a missing criterion is.
  const missingCriteria = result.verdict === 'excluded' ? [] : result.checks || [];
  const failedCriteria = result.reason ? [result.reason] : [];
  const matchType = MATCH_TYPES[result.verdict] || 'possible';

  return {
    matchType,
    score: scoreFor({
      verdict: result.verdict,
      openQuestions: missingCriteria.length,
      fits: (result.fit || []).length,
    }),
    matchedCriteria,
    missingCriteria,
    failedCriteria,
    explanation: explain(matchType, { matchedCriteria, missingCriteria, failedCriteria }),
    // Kept so the dashboard can tag a card the way the screener does.
    fit: result.fit || [],
  };
}

/**
 * Every program worth showing, best first.
 *
 * `includeNonMatches` is off by default: the dashboard is a list of things to
 * try, not a rejection letter. It exists so a "why isn't X here?" view can be
 * built later without a second matching path.
 */
export function matchProfileToPrograms(profile, programs, lookup, proportional, { includeNonMatches = false } = {}) {
  const answers = profileToAnswers(profile);
  const results = [];

  for (const program of programs || []) {
    const match = matchAnswersToProgram(answers, program, lookup, proportional);
    if (match.matchType === 'none' && !includeNonMatches) continue;
    results.push({ program, match });
  }

  results.sort((a, b) => {
    // Targeted programs first, exactly as the screener ranks them, then score.
    const byFit = b.match.fit.length - a.match.fit.length;
    if (byFit) return byFit;
    if (b.match.score !== a.match.score) return b.match.score - a.match.score;
    return String(a.program.program_name).localeCompare(String(b.program.program_name));
  });

  return results;
}

// ---------------------------------------------------------------------------
// Rentals
// ---------------------------------------------------------------------------

const strip = (v) => String(v).toLowerCase().replace(/\s+county$/, '').trim();
const sameCounty = (a, b) => strip(a) === strip(b);

const STATE_NAMES = { oregon: 'OR', minnesota: 'MN' };
function sameState(listingState, code) {
  const raw = String(listingState).trim();
  if (/^[A-Za-z]{2}$/.test(raw)) return raw.toUpperCase() === code;
  const mapped = STATE_NAMES[raw.toLowerCase()];
  return mapped ? mapped === code : true;
}

/**
 * Scores one rental listing against one profile.
 *
 * Same rules as screenListings(): bedrooms and bathrooms are FLOORS, max rent
 * is a hard ceiling, and anything the listing doesn't say is unknown rather
 * than disqualifying — an unknown becomes a missing criterion, never a failed
 * one. That is why a listing with no bedroom count still appears: the feed's
 * gaps are not the renter's problem.
 */
export function matchUserToHousing(profile, listing, countiesForCity) {
  const answers = profileToAnswers(profile);
  const matchedCriteria = [];
  const missingCriteria = [];
  const failedCriteria = [];

  const wanted = answers.counties || [];
  const budget = monthlyBudget(answers.income);

  // --- Location -------------------------------------------------------
  if (listing.state && answers.state && !sameState(listing.state, answers.state)) {
    failedCriteria.push(`This listing is not in ${answers.state}`);
  } else if (wanted.length) {
    const county =
      listing.county ||
      (listing.city && countiesForCity
        ? (countiesForCity(listing.city, listing.state || answers.state) || [])[0]
        : null);
    if (county && wanted.some((c) => sameCounty(county, c))) {
      matchedCriteria.push(`It’s in ${strip(county).replace(/^./, (m) => m.toUpperCase())} County, one of your areas`);
    } else if (county) {
      failedCriteria.push('It’s outside the counties you chose');
    } else {
      missingCriteria.push('We couldn’t tell which county this is in — check before you travel');
    }
  }

  // --- Rent -----------------------------------------------------------
  const maxRent = answers.maxRent == null ? null : Number(answers.maxRent);
  if (listing.rent == null) {
    missingCriteria.push('This listing doesn’t publish a rent — ask when you call');
  } else {
    if (maxRent != null && listing.rent > maxRent) {
      failedCriteria.push(`The rent is above the ${money(maxRent)} you set`);
    } else if (maxRent != null) {
      matchedCriteria.push(`The rent is within the ${money(maxRent)} you set`);
    }
    if (budget != null) {
      if (listing.rent <= budget) {
        matchedCriteria.push(`At ${money(listing.rent)} it fits the 30%-of-income guideline (about ${money(budget)}/mo)`);
      } else {
        missingCriteria.push(
          `At ${money(listing.rent)} it’s above the usual 30%-of-income guideline of ${money(budget)}/mo — rent help may close the gap`,
        );
      }
    }
  }

  // --- Size -----------------------------------------------------------
  const minBeds = answers.bedrooms == null || answers.bedrooms === 'any' ? null : Number(answers.bedrooms);
  if (minBeds != null) {
    if (listing.bedrooms == null) {
      missingCriteria.push('The number of bedrooms isn’t listed');
    } else if (listing.bedrooms < minBeds) {
      failedCriteria.push(`It has ${bedroomsLabel(listing.bedrooms)?.toLowerCase()}, fewer than you need`);
    } else {
      matchedCriteria.push(`${bedroomsLabel(listing.bedrooms)} meets the size you need`);
    }
  }

  const minBaths = answers.bathrooms == null || answers.bathrooms === 'any' ? null : Number(answers.bathrooms);
  if (minBaths != null && listing.bathrooms != null && listing.bathrooms < minBaths) {
    failedCriteria.push('It has fewer bathrooms than you need');
  }

  const matchType = failedCriteria.length ? 'none' : missingCriteria.length ? 'possible' : 'strong';
  return {
    matchType,
    score: scoreFor({
      verdict: failedCriteria.length ? 'excluded' : missingCriteria.length ? 'possible' : 'likely',
      openQuestions: missingCriteria.length,
      fits: 0,
    }),
    matchedCriteria,
    missingCriteria,
    failedCriteria,
    explanation: explain(matchType, { matchedCriteria, missingCriteria, failedCriteria }),
    fit: [],
  };
}

/** Every listing worth showing, cheapest first among equally good matches. */
export function matchProfileToListings(profile, listings, countiesForCity, { includeNonMatches = false } = {}) {
  const results = [];
  for (const listing of listings || []) {
    const match = matchUserToHousing(profile, listing, countiesForCity);
    if (match.matchType === 'none' && !includeNonMatches) continue;
    results.push({ listing, match });
  }
  results.sort((a, b) => {
    if (b.match.score !== a.match.score) return b.match.score - a.match.score;
    const aRent = a.listing.rent ?? Infinity;
    const bRent = b.listing.rent ?? Infinity;
    return aRent - bRent;
  });
  return results;
}

function money(amount) {
  return `$${Math.round(amount).toLocaleString('en-US')}`;
}
