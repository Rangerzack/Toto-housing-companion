import {
  SUPABASE_URL,
  FORMS_BUCKET,
  STATES,
  HOUSING_API_URL,
  HOUSING_API_HEADERS,
  CITY_COUNTIES,
} from './config.js?v=__BUILD__';
import { screenPrograms } from './matcher.js?v=__BUILD__';
// Shared with the signed-in dashboard so both read the catalogue identically.
import {
  fetchProgramCatalogue,
  fetchLimitRows,
  lookupLimit,
} from './data-api.js?v=__BUILD__';
import {
  fetchListings,
  screenListings,
  monthlyBudget,
  bedroomsLabel,
} from './housing.js?v=__BUILD__';
// Only to decide which header link to show. The wizard neither requires an
// account nor reads one; answers still live in this tab alone.
import { isSignedIn } from './auth.js?v=__BUILD__';
// The saved profile is the canonical copy of these answers. When someone is
// signed in, the wizard reads it instead of asking again.
import {
  loadProfile,
  saveProfile,
  matchReadiness,
  stepsSatisfiedBy,
  profileToAnswers,
  answersToProfile,
} from './profile.js?v=__BUILD__';
// The landing page. It renders into the intro step and hands answers back
// through startWizard(), so it never touches the wizard's own state.
import { initLanding } from './landing.js?v=__BUILD__';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const STEPS = [
  'intro', 'state', 'county', 'help', 'situation', 'bedrooms',
  'household', 'income', 'circumstances', 'results',
];

// Someone asking about a utility bill is not asked whether they rent or own —
// utility programs serve both, so the question would be friction for a person
// who may be holding a shutoff notice. That makes the question count vary,
// so the visible set is computed rather than fixed.
function questionSteps() {
  return STEPS.filter((s) => {
    if (s === 'intro' || s === 'results') return false;
    // Already answered in the saved profile — don't ask it again. Editing an
    // answer from the results chips clears it from this set (see answerChips),
    // so nothing becomes unreachable.
    if (profileSteps.has(s)) return false;
    // Rent-or-own only matters for "staying in my home" — the other needs
    // imply their situations on their own.
    if (s === 'situation') return answers.help.includes('staying');
    // Bedrooms only matter when the results will include rental listings.
    if (s === 'bedrooms') return answers.help.includes('rental');
    return true;
  });
}

const answers = {
  state: null, // county names repeat across states; both are needed
  // The local area: one or more counties. `county`/`areaId` mirror the first
  // pick so older code paths, saved sessions, and legacy share links keep
  // working.
  counties: [],
  areaIds: [],
  county: null,
  areaId: null,
  statewideAreaId: null, // where that state's SMI limits live
  help: [], // any of: rental | staying | buying | utility
  situation: null,
  bedrooms: null, // 'any' | '0'..'4' — a FLOOR (at least N), not exact
  bathrooms: null, // 'any' | '1'..'3' — also a floor
  maxRent: null, // hard ceiling on listing rent; null = no limit
  householdSize: 1,
  income: null, // ALWAYS annual gross; null means "not provided"
  incomePeriod: 'year', // how the person is typing it: 'year' | 'month'
  circumstances: {},
};

let stepIndex = 0;
let programs = null; // cached after first fetch

// Set when the wizard was started from a signed-in person's saved profile.
// `profileSteps` are the questions that profile already answers, which
// questionSteps() then drops so they are not asked a second time.
let profileRow = null;
let profileSteps = new Set();

// Opt-in tracing for diagnosing the profile handoff: add ?debug=1. Only field
// NAMES, counts and booleans are ever logged — never the values, which are
// somebody's income and housing situation.
const DEBUG = new URLSearchParams(location.search).has('debug');
function debug(...args) {
  if (DEBUG) console.log('[toto]', ...args);
}
let fetchError = null;

// Published income limits for the local-area counties plus the statewide SMI
// set, keyed `${standard}|${tier}|${size}`. Refetched when the area changes.
let limits = new Map();
let limitsKey = null;

// Standards whose tiers are exact multiples of one base (SMI, poverty
// guidelines). Scaling to an unpublished tier is arithmetic for these and an
// estimate for HUD's AMI, which computes each tier separately.
let proportionalStandards = new Set();

// ---------------------------------------------------------------------------
// Tiny DOM helper
// ---------------------------------------------------------------------------

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'html') node.innerHTML = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value);
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of [].concat(children)) {
    // Skips every falsy child, not just null/false: `count && el(...)`
    // evaluates to 0 when the count is zero, and appending 0 renders "0".
    if (!child) continue;
    node.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

// One in-flight catalogue fetch, shared. The landing page's quick check, its
// property dialog and the wizard's own results all want the same rows; without
// this they would each start their own request on first paint.
let cataloguePromise = null;

function getCatalogue() {
  if (!cataloguePromise) {
    cataloguePromise = fetchProgramCatalogue().catch((error) => {
      // A failed fetch must not be cached as the answer forever — the next
      // caller should be able to try again.
      cataloguePromise = null;
      throw error;
    });
  }
  return cataloguePromise;
}

async function fetchPrograms() {
  const catalogue = await getCatalogue();
  proportionalStandards = catalogue.proportionalStandards;
  return catalogue.programs;
}

/**
 * Loads published limits for the local-area counties plus the statewide SMI
 * table.
 *
 * v_current_income_limits already drops expired rows and expands published
 * brackets (USDA's "1-4 person") into one row per size. Several effective
 * dates can still be current at once, so the newest wins per area.
 *
 * When the local area spans counties whose limits differ, the MOST GENEROUS
 * figure wins for each (standard, tier, size): the matcher can't tell which
 * county a given program will test against, and under the house rule a
 * too-generous limit only ever turns an exclusion into a worth-checking
 * phone call, never the reverse.
 */
async function fetchLimits(areaIds, statewideAreaId) {
  const ids = (Array.isArray(areaIds) ? areaIds : [areaIds]).filter(Boolean);
  const key = ids.join(',');
  if (!ids.length || limitsKey === key) return;

  limits = await fetchLimitRows(ids, statewideAreaId);
  limitsKey = key;
}

/**
 * Passed to the matcher; null means nothing is published for that combination.
 *
 * HUD publishes sizes 1-8 but this screener accepts households up to 12, so
 * larger ones fall back to HUD's own convention: add 8% of the 4-person limit
 * per additional person. This mirrors the income_limit_for() function in
 * 0004_income_limits.sql. Oregon's SMI table carries explicit rows through
 * size 12 (it grows by a different rule), so those hit the exact path first.
 */
function limitLookup(standardId, tierPct, householdSize) {
  return lookupLimit(limits, standardId, tierPct, householdSize);
}

// ---------------------------------------------------------------------------
// Accounts (entirely optional)
// ---------------------------------------------------------------------------

/**
 * Puts a sign-in or dashboard link in the header.
 *
 * The screener itself never requires an account and never reads one: every
 * answer here still lives only in this tab. This link is the single point of
 * contact between the two, so if accounts were removed tomorrow the wizard
 * would be untouched.
 */
function renderAccountLink() {
  const host = $('#account-link');
  if (!host) return;
  const signedIn = isSignedIn();
  host.replaceChildren(
    el('a', {
      class: 'btn btn--ghost btn--sm',
      href: signedIn ? 'dashboard/' : 'login/',
      text: signedIn ? 'Your matches' : 'Sign in',
    }),
  );
}

// ---------------------------------------------------------------------------
// Wizard navigation
// ---------------------------------------------------------------------------

function currentStep() {
  return STEPS[stepIndex];
}

function showStep(name, { fromHistory = false } = {}) {
  document.getElementById('program-dialog')?.close();
  stepIndex = STEPS.indexOf(name);

  $$('.step').forEach((section) => {
    section.classList.toggle('is-active', section.dataset.step === name);
  });

  const steps = questionSteps();
  const isQuestion = steps.includes(name);
  $('#progress').hidden = !isQuestion;
  $('#restart-top').hidden = name === 'intro';

  // The section nav belongs to the landing page. Halfway through a form,
  // three links to somewhere else is noise, so it only exists on the intro.
  const nav = $('#site-nav');
  if (nav) nav.hidden = name !== 'intro';
  if (name === 'intro') bootLanding();

  if (isQuestion) {
    const position = steps.indexOf(name) + 1;
    const pct = Math.round((position / steps.length) * 100);
    // No "of N": answering "Finding a home" inserts the preferences step, so
    // a stated total would visibly grow mid-flow. The bar carries the total.
    $('#progress-label').textContent = `Question ${position}`;
    $('#progress-pct').textContent = `${pct}%`;
    $('#progress-fill').style.width = `${pct}%`;
    $('#progress-bar').setAttribute('aria-valuenow', String(pct));
  }

  const section = $(`.step[data-step="${name}"]`);
  section.focus({ preventScroll: true });
  window.scrollTo({ top: 0, behavior: 'smooth' });

  // Each step is a history entry, so the browser's Back button walks the
  // wizard; the results entry carries the shareable answers hash.
  if (!fromHistory) {
    const url =
      name === 'results' && answers.county
        ? location.pathname + location.search + encodeShareHash()
        : location.pathname + location.search;
    if (historyReady) history.pushState({ step: name }, '', url);
    else {
      history.replaceState({ step: name }, '', url);
      historyReady = true;
    }
  }
  saveAnswers(name);

  if (name === 'results') {
    // The "just N questions to go" banner has served its purpose by the time
    // they are looking at results, where it only reads as stale.
    document.querySelector('.profile-banner')?.remove();
    renderResults();
    // Anything answered here that the profile was missing is written back, so
    // it is never asked a third time.
    persistAnswersToProfile();
  }
  if (name === 'plan') renderPlan();
  updatePlanUi();
}

// Walks STEPS in the given direction, skipping any step not currently asked.
function move(direction) {
  const skipped = STEPS.filter((s) => !questionSteps().includes(s) && s !== 'intro' && s !== 'results');
  let i = stepIndex + direction;
  while (i > 0 && i < STEPS.length - 1 && skipped.includes(STEPS[i])) i += direction;
  if (i >= 0 && i < STEPS.length) showStep(STEPS[i]);
}

function goNext() { move(1); }
function goBack() { move(-1); }

// The landing page binds listeners and renders the nav, so it is set up once
// and only once, the first time the intro is shown.
let landingReady = false;
function bootLanding() {
  if (landingReady) return;
  landingReady = true;
  initLanding({ getCatalogue, startWizard });
}

/**
 * Starts the questionnaire already knowing some answers.
 *
 * This is the landing page's only way into the wizard — the quick check hands
 * over the four things it asked, "Check my fit" hands over a property's rent
 * and county. `satisfied` names the steps those answers settle, which
 * questionSteps() then drops, so nobody is asked the same thing twice. It is
 * the same mechanism the saved profile uses, and Start over clears it the
 * same way.
 *
 * Editing an answer from the results chips removes that step from the set
 * (see answerChips), so nothing here can make a question unreachable.
 */
function startWizard(prefill, { satisfied = [], openProgram = null } = {}) {
  if (prefill) {
    Object.assign(answers, prefill);
    profileSteps = new Set(satisfied);
    hydrateUi();
  }
  pendingProgramId = openProgram;

  // The first question they have NOT already answered. If that is none of
  // them, they have earned the results.
  const remaining = questionSteps();
  showStep(remaining[0] || 'results');
}

// Set when someone asked to open a specific program on arrival ("See details"
// in the quick check). Consumed by renderResults once the cards exist.
let pendingProgramId = null;

function restart() {
  // Start over means start over: the profile no longer stands in for any
  // answer. Without this the wizard would keep skipping questions whose
  // answers were just cleared, and land on results with nothing to match on.
  profileRow = null;
  profileSteps = new Set();
  document.querySelector('.profile-banner')?.remove();

  answers.county = null;
  answers.state = null;
  answers.areaId = null;
  answers.counties = [];
  answers.areaIds = [];
  answers.statewideAreaId = null;
  answers.help = [];
  answers.situation = null;
  answers.bedrooms = null;
  answers.bathrooms = null;
  answers.maxRent = null;
  answers.householdSize = 1;
  answers.income = null;
  answers.incomePeriod = 'year';
  answers.circumstances = {};

  $$('input[type="radio"], input[type="checkbox"]').forEach((input) => {
    input.checked = false;
  });
  $('#county-choices').replaceChildren();
  $('#county-filter').hidden = true;
  $('#county-filter').value = '';
  $('#situation-choices').replaceChildren();
  $('#household-size').value = '1';
  $('#income').value = '';
  $('#income-feedback').textContent = '';
  $('#max-rent').value = '';
  const yearRadio = $('input[name="income-period"][value="year"]');
  if (yearRadio) yearRadio.checked = true;
  $('#income-suffix').textContent = 'per year';
  plan = [];
  savePlan();
  syncChoiceSelection();
  syncHouseholdUi();
  syncCircumstanceVisibility();
  refreshContinueButtons();
  showStep('intro');
}

// A step's Continue button stays disabled until that step has an answer.
function refreshContinueButtons() {
  const gates = {
    state: answers.state,
    county: answers.counties.length,
    help: answers.help.length,
    situation: answers.situation,
  };
  for (const [step, answered] of Object.entries(gates)) {
    const btn = $(`.step[data-step="${step}"] [data-action="next"]`);
    if (btn) btn.disabled = !answered;
  }
}

// ---------------------------------------------------------------------------
// Step wiring
// ---------------------------------------------------------------------------

function buildStateChoices() {
  const container = $('#state-choices');
  for (const state of STATES) {
    const input = el('input', { type: 'radio', name: 'state', value: state.code });
    input.addEventListener('change', () => {
      if (answers.state !== state.code) {
        // Counties are state-specific, so a changed state invalidates the picks.
        answers.county = null;
        answers.areaId = null;
        answers.counties = [];
        answers.areaIds = [];
      }
      answers.state = state.code;
      answers.statewideAreaId = state.statewideAreaId;
      buildCountyChoices();
      refreshContinueButtons();
    });
    container.append(
      el('label', { class: 'choice' }, [
        input,
        el('span', { class: 'choice__body' }, [
          el('span', { class: 'choice__title', text: state.label }),
          el('span', { class: 'choice__desc', text: state.name }),
        ]),
      ]),
    );
  }
}

// Hides county options that don't match the filter text. Filtering never
// clears a selection — a chosen county stays chosen even when typed past.
function filterCountyChoices() {
  const query = $('#county-filter').value.trim().toLowerCase();
  $$('#county-choices .choice').forEach((label) => {
    const name = label.textContent.trim().toLowerCase();
    label.hidden = Boolean(query) && !name.includes(query);
  });
}

// Rebuilt whenever the state changes. Only that state's counties are offered,
// which is what removes the old ambiguity — "Douglas" now means exactly one
// county, because the state was already established.
function buildCountyChoices() {
  const container = $('#county-choices');
  container.replaceChildren();

  const filter = $('#county-filter');
  filter.value = '';

  const state = STATES.find((s) => s.code === answers.state);
  if (!state) {
    filter.hidden = true;
    return;
  }

  // A dozen-plus tiles is a lot of scanning on a phone; a short list
  // doesn't need the extra control.
  filter.hidden = state.counties.length <= 8;

  // Checkboxes, not radios: the local area can span several counties.
  for (const { name } of state.counties) {
    const input = el('input', { type: 'checkbox', name: 'county', value: name });
    input.checked = answers.counties.includes(name);
    input.addEventListener('change', () => {
      const picked = new Set($$('#county-choices input:checked').map((i) => i.value));
      const chosen = state.counties.filter((c) => picked.has(c.name));
      answers.counties = chosen.map((c) => c.name);
      answers.areaIds = chosen.map((c) => c.areaId);
      answers.county = answers.counties[0] || null;
      answers.areaId = answers.areaIds[0] || null;
      refreshContinueButtons();
      // Warm the limits while they answer the next questions, so the income
      // step can show real thresholds the moment it opens.
      if (answers.areaIds.length) {
        fetchLimits(answers.areaIds, state.statewideAreaId)
          .then(updateIncomeFeedback)
          .catch(() => {});
      }
    });
    container.append(
      el('label', { class: 'choice choice--check' }, [
        input,
        el('span', { class: 'choice__body' }, [
          el('span', { class: 'choice__title', text: name }),
        ]),
      ]),
    );
  }
}

// The tenure follow-up depends on what kind of help was asked for. Someone
// looking for a place needs different options from someone trying to keep the
// home they have, and asking one generic question served both badly.
const STAYING_SITUATION = {
  title: 'Do you rent or own your home?',
  hint: 'Programs differ depending on which, so this narrows things considerably.',
  options: [
    ['renting', 'I rent', 'Including if you are behind on rent or facing eviction'],
    ['homeowner', 'I own my home', 'Including mortgage trouble and home repairs'],
  ],
};

function buildSituationChoices() {
  const set = answers.help.includes('staying') ? STAYING_SITUATION : null;
  const container = $('#situation-choices');
  container.replaceChildren();
  if (!set) return;

  $('#situation-title').textContent = set.title;
  $('#situation-hint').textContent = set.hint;

  for (const [value, title, desc] of set.options) {
    const input = el('input', { type: 'radio', name: 'situation', value });
    input.checked = answers.situation === value;
    input.addEventListener('change', () => {
      answers.situation = value;
      syncCircumstanceVisibility();
      refreshContinueButtons();
    });
    container.append(
      el('label', { class: 'choice' }, [
        input,
        el('span', { class: 'choice__body' }, [
          el('span', { class: 'choice__title', text: title }),
          el('span', { class: 'choice__desc', text: desc }),
        ]),
      ]),
    );
  }
}

function wireHelpChoices() {
  $$('#help-choices input[type="checkbox"]').forEach((input) => {
    input.addEventListener('change', () => {
      answers.help = $$('#help-choices input:checked').map((i) => i.value);
      if (!answers.help.includes('staying')) answers.situation = null;
      if (!answers.help.includes('rental')) answers.bedrooms = null;
      buildSituationChoices();
      syncCircumstanceVisibility();
      refreshContinueButtons();
    });
  });
}

function wireRentalPrefs() {
  $$('#bedrooms-choices input[type="radio"]').forEach((input) => {
    input.addEventListener('change', () => {
      answers.bedrooms = input.value; // 'any' or '0'..'4' — kept as strings
    });
  });
  $$('#bathrooms-choices input[type="radio"]').forEach((input) => {
    input.addEventListener('change', () => {
      answers.bathrooms = input.value; // 'any' or '1'..'3'
    });
  });
  const maxRent = $('#max-rent');
  maxRent.addEventListener('input', () => {
    const digits = maxRent.value.replace(/[^\d]/g, '');
    maxRent.value = digits ? currency.format(Number(digits)) : '';
    answers.maxRent = digits ? Number(digits) : null;
  });
}

function syncHouseholdUi() {
  const size = answers.householdSize;
  $('#hh-unit').textContent = size === 1 ? 'person' : 'people';
  $('#hh-minus').disabled = size <= 1;
  $('#hh-plus').disabled = size >= 12;
  updateIncomeFeedback();
}

function setHouseholdSize(next) {
  answers.householdSize = Math.min(12, Math.max(1, next || 1));
  $('#household-size').value = String(answers.householdSize);
  syncHouseholdUi();
}

const currency = new Intl.NumberFormat('en-US');
const money = (amount) => `$${currency.format(Math.round(amount))}`;

// Real published thresholds beat a percentage nobody can act on: "under
// $70,650" is checkable, "80% of AMI" is not.
function updateIncomeFeedback() {
  const feedback = $('#income-feedback');
  // Good news must not arrive in the brand red — in a form that hue reads as
  // an error. Green for under-limit, amber for over, neutral for plain info.
  const setTone = (tone) => {
    feedback.classList.toggle('feedback--good', tone === 'good');
    feedback.classList.toggle('feedback--over', tone === 'over');
  };
  setTone(null);
  const size = answers.householdSize;
  const at80 = limitLookup('HUD-MFI', 80, size);
  const at50 = limitLookup('HUD-MFI', 50, size);
  const areaLabel =
    answers.counties.length > 1 ? 'your area' : `${answers.county} County`;
  // When they're typing a monthly figure, confirm the annual number the
  // programs will actually measure against.
  const annualNote =
    answers.incomePeriod === 'month' && answers.income != null
      ? `That's about ${money(answers.income)} a year. `
      : '';

  if (answers.income == null) {
    feedback.textContent = at80
      ? `Most housing programs in ${areaLabel} serve households of ${size} earning under ${money(at80)}.`
      : '';
    return;
  }

  if (!at80 || !at50) {
    feedback.textContent = annualNote;
    return;
  }

  if (answers.income <= at50) {
    setTone('good');
    feedback.textContent = `${annualNote}That's within reach of most programs here, including those limited to ${money(at50)} for a household of ${size}.`;
  } else if (answers.income <= at80) {
    setTone('good');
    feedback.textContent = `${annualNote}That's under the ${money(at80)} limit most housing programs use for a household of ${size}.`;
  } else {
    setTone('over');
    feedback.textContent = `${annualNote}That's above the usual ${money(at80)} limit for a household of ${size}, but close numbers are worth checking — programs measure income their own way — and you'll still see what may fit.`;
  }
}

function wireIncomeStep() {
  const input = $('#income');
  const skip = $('#income-skip');

  // answers.income is ALWAYS the annual figure; the period toggle only
  // changes how the typed number is read.
  const readIncome = () => {
    const digits = input.value.replace(/[^\d]/g, '');
    input.value = digits ? currency.format(Number(digits)) : '';
    const entered = digits ? Number(digits) : null;
    answers.income =
      entered == null ? null : answers.incomePeriod === 'month' ? entered * 12 : entered;
    if (digits) skip.checked = false;
    updateIncomeFeedback();
  };

  input.addEventListener('input', readIncome);

  $$('input[name="income-period"]').forEach((radio) => {
    radio.addEventListener('change', () => {
      answers.incomePeriod = radio.value;
      $('#income-suffix').textContent = radio.value === 'month' ? 'per month' : 'per year';
      input.placeholder = radio.value === 'month' ? '2,900' : '35,000';
      readIncome();
    });
  });

  skip.addEventListener('change', () => {
    if (skip.checked) {
      input.value = '';
      answers.income = null;
      updateIncomeFeedback();
    }
  });
}

function wireCircumstances() {
  $$('#circumstance-choices input[type="checkbox"]').forEach((input) => {
    input.addEventListener('change', () => {
      answers.circumstances[input.value] = input.checked;
    });
  });
}

// The first-time-buyer checkbox is only relevant to buyers; hiding it
// elsewhere keeps the circumstances list short.
function syncCircumstanceVisibility() {
  $('#ftb-choice').hidden = !answers.help.includes('buying');
}

// Selection is mirrored to a class the moment any choice input changes.
// The stylesheet's :has(input:checked) rule SHOULD do this alone, but
// browsers were observed caching the non-matching state for these cards and
// never repainting on the flip (Chrome 151, against the live site) — which
// left people tapping answers with no visible response. The class is the
// guarantee; :has() stays as the declarative fallback.
function syncChoiceSelection() {
  $$('.choice input').forEach((input) => {
    input.closest('.choice').classList.toggle('is-selected', input.checked);
  });
}
document.addEventListener('change', (event) => {
  if (event.target instanceof HTMLInputElement && event.target.closest('.choice')) {
    syncChoiceSelection();
  }
});

// Single-choice steps advance on their own: picking the answer IS the
// submission, and the pause lets the selection paint before the step moves
// (the measured journey drops from ~15 taps to ~9). The timer debounces
// keyboard arrow-through so a screen-reader or keyboard user exploring the
// options isn't yanked forward mid-list; Back stays for corrections.
// The help step is multi-select now, so it keeps its Continue button.
// County is a multi-select now and the rental-preferences step holds several
// inputs, so both keep a Continue button instead of advancing on selection.
const AUTO_ADVANCE_STEPS = new Set(['state', 'situation']);
let advanceTimer = null;
document.addEventListener('change', (event) => {
  const step = event.target.closest('.step')?.dataset.step;
  if (!AUTO_ADVANCE_STEPS.has(step) || event.target.type !== 'radio') return;
  clearTimeout(advanceTimer);
  advanceTimer = setTimeout(() => {
    if (currentStep() === step) goNext();
  }, 450);
});

// ---------------------------------------------------------------------------
// Keeping answers through refresh, Back, and shared links
// ---------------------------------------------------------------------------
// Three promises: the browser's Back button walks the wizard instead of
// leaving it; a refresh resumes where the person was; and the results page
// gets a URL that can be bookmarked or texted to a caseworker. Everything
// stays on the device — the hash and sessionStorage are the only stores.

const ANSWERS_KEY = 'toto-answers';
let historyReady = false;

function saveAnswers(step) {
  try {
    sessionStorage.setItem(ANSWERS_KEY, JSON.stringify({ answers, step }));
  } catch {
    /* private browsing */
  }
}

const HELP_VALUES = ['rental', 'staying', 'buying', 'utility'];
// Links minted before the multi-select help step keep working.
const LEGACY_HELP = { finding: 'rental' };

function encodeShareHash() {
  const circs = Object.keys(answers.circumstances).filter((k) => answers.circumstances[k]);
  return (
    '#a=' +
    [
      answers.state,
      answers.counties.join('+'),
      answers.help.join('+'),
      answers.situation || 'x',
      answers.householdSize,
      answers.income ?? 'x',
      circs.join('+') || 'x',
      answers.bedrooms ?? 'x',
      answers.maxRent ?? 'x',
      answers.bathrooms ?? 'x',
    ]
      .map(encodeURIComponent)
      .join('/')
  );
}

const BEDROOM_VALUES = ['any', '0', '1', '2', '3', '4'];
const BATHROOM_VALUES = ['any', '1', '2', '3'];

function decodeShareHash(hash) {
  const match = /^#a=(.+)$/.exec(hash || '');
  if (!match) return null;
  const parts = match[1].split('/').map(decodeURIComponent);
  // Links have grown over time: 7 parts predates the bedrooms question,
  // 8 predates max rent and bathrooms. All still decode.
  if (parts.length < 7 || parts.length > 10) return null;
  const [state, countyRaw, helpRaw, situationRaw, size, income, circs, bedroomsRaw, maxRentRaw, bathroomsRaw] = parts;
  const config = STATES.find((s) => s.code === state);
  // The county slot may name several local-area counties.
  const countyRows = countyRaw
    .split('+')
    .map((name) => config?.counties.find((c) => c.name === name))
    .filter(Boolean);
  const countyRow = countyRows[0];
  const help = helpRaw
    .split('+')
    .map((h) => LEGACY_HELP[h] || h)
    .filter((h) => HELP_VALUES.includes(h));
  if (!config || !countyRow || !help.length) return null;
  let situation = situationRaw === 'x' ? null : situationRaw;
  if (situation === 'buying' && !help.includes('buying')) help.push('buying');
  if (!['renting', 'homeowner'].includes(situation)) situation = null;
  return {
    state,
    counties: countyRows.map((c) => c.name),
    areaIds: countyRows.map((c) => c.areaId),
    county: countyRow.name,
    areaId: countyRow.areaId,
    statewideAreaId: config.statewideAreaId,
    help,
    situation,
    bedrooms:
      bedroomsRaw && bedroomsRaw !== 'x' && BEDROOM_VALUES.includes(bedroomsRaw)
        ? bedroomsRaw
        : null,
    maxRent:
      maxRentRaw && maxRentRaw !== 'x' && Number(maxRentRaw) > 0 ? Number(maxRentRaw) : null,
    bathrooms:
      bathroomsRaw && bathroomsRaw !== 'x' && BATHROOM_VALUES.includes(bathroomsRaw)
        ? bathroomsRaw
        : null,
    householdSize: Math.min(12, Math.max(1, Number(size) || 1)),
    income: income === 'x' ? null : Number(income) || null,
    circumstances:
      circs === 'x' ? {} : Object.fromEntries(circs.split('+').map((k) => [k, true])),
  };
}

// Rebuilds every input from `answers` after a restore.
function hydrateUi() {
  const check = (selector, value) => {
    const input = $$(selector).find((i) => i.value === value);
    if (input) input.checked = true;
  };
  check('#state-choices input', answers.state);
  if (answers.state) buildCountyChoices();
  for (const name of answers.counties) check('#county-choices input', name);
  for (const need of answers.help) check('#help-choices input', need);
  buildSituationChoices();
  check('#situation-choices input', answers.situation);
  if (answers.bedrooms != null) check('#bedrooms-choices input', String(answers.bedrooms));
  if (answers.bathrooms != null) check('#bathrooms-choices input', String(answers.bathrooms));
  if (answers.maxRent != null) $('#max-rent').value = currency.format(answers.maxRent);
  $('#household-size').value = String(answers.householdSize);
  check('input[name="income-period"]', answers.incomePeriod || 'year');
  $('#income-suffix').textContent = answers.incomePeriod === 'month' ? 'per month' : 'per year';
  if (answers.income != null) {
    // Display in the period they were typing in; the stored figure is annual.
    const shown =
      answers.incomePeriod === 'month' ? Math.round(answers.income / 12) : answers.income;
    $('#income').value = currency.format(shown);
  }
  for (const [key, value] of Object.entries(answers.circumstances || {})) {
    if (value) check('#circumstance-choices input', key);
  }
  syncChoiceSelection();
  syncHouseholdUi();
  syncCircumstanceVisibility();
  refreshContinueButtons();
  if (answers.areaIds.length) {
    fetchLimits(answers.areaIds, answers.statewideAreaId).then(updateIncomeFeedback).catch(() => {});
  }
}

window.addEventListener('popstate', (event) => {
  const step = event.state?.step;
  const known = STEPS.includes(step) || step === 'plan';
  showStep(known ? step : 'intro', { fromHistory: true });
});

// ---------------------------------------------------------------------------
// Housing plan
// ---------------------------------------------------------------------------
// Programs pinned from the results into the short list someone will actually
// work: every intake step expanded, contacts inline, printable. It lives in
// this browser tab only (sessionStorage) — like every other answer here,
// nothing leaves the device.

const PLAN_KEY = 'toto-plan';
let plan = [];
try {
  plan = JSON.parse(sessionStorage.getItem(PLAN_KEY) || '[]');
  if (!Array.isArray(plan)) plan = [];
} catch {
  plan = [];
}

function savePlan() {
  try {
    sessionStorage.setItem(PLAN_KEY, JSON.stringify(plan));
  } catch {
    /* private browsing: the plan still works for this page view */
  }
}

const inPlan = (id) => plan.includes(id);

function togglePlan(id) {
  plan = inPlan(id) ? plan.filter((p) => p !== id) : [...plan, id];
  savePlan();
  updatePlanUi();
}

const planToggleLabel = (id) => (inPlan(id) ? '✓ In your plan' : '+ Add to plan');

function updatePlanUi() {
  $$('.save-btn').forEach(paintSaveButton);
  $$('.plan-toggle').forEach((btn) => {
    const chosen = inPlan(btn.dataset.program);
    btn.textContent = planToggleLabel(btn.dataset.program);
    btn.classList.toggle('plan-toggle--on', chosen);
  });
  const bar = $('#plan-bar');
  if (bar) {
    bar.hidden = plan.length === 0 || currentStep() !== 'results';
    $('#plan-count').textContent =
      `${plan.length} program${plan.length === 1 ? '' : 's'} in your plan`;
  }
}

function renderPlan() {
  const host = $('#plan-state');
  host.replaceChildren();

  const chosen = plan
    .map((id) => (programs || []).find((p) => p.program_id === id))
    .filter(Boolean);

  if (!chosen.length) {
    host.append(
      renderNotice({
        icon: '📋',
        title: 'Your plan is empty',
        body: 'Add programs from your results with the "+ Add to plan" button, and they collect here with every step you need to apply.',
        actionLabel: 'Back to results',
        onAction: () => showStep('results'),
      }),
    );
    return;
  }

  host.append(
    el('div', { class: 'plan__header' }, [
      el('h2', { class: 'results__count', text: 'Your housing plan' }),
      el('p', {
        class: 'results__summary',
        text: `${chosen.length} program${chosen.length === 1 ? '' : 's'} to work through, with every application step in one place. Print it, or save it as a PDF to bring to a caseworker.`,
      }),
      el('div', { class: 'plan__actions' }, [
        el('button', {
          type: 'button',
          class: 'btn btn--primary',
          text: 'Print or save as PDF',
          onclick: () => window.print(),
        }),
        el('button', {
          type: 'button',
          class: 'btn btn--ghost',
          text: 'Back to results',
          onclick: () => showStep('results'),
        }),
      ]),
    ]),
  );

  const list = el('ol', { class: 'plan__list' });
  for (const program of chosen) {
    const contacts = program.contacts || {};
    const item = el('li', { class: 'plan-item' });

    item.append(
      el('div', { class: 'plan-item__top' }, [
        el('div', {}, [
          el('h3', { class: 'result__name', text: program.program_name }),
          program.administrator &&
            el('p', { class: 'result__admin', text: program.administrator }),
        ]),
        el('button', {
          type: 'button',
          class: 'btn btn--ghost btn--sm plan-item__remove',
          text: 'Remove',
          onclick: () => {
            togglePlan(program.program_id);
            renderPlan();
          },
        }),
      ]),
    );

    const steps = [];
    const openness = [program.application_status, program.application_window]
      .filter(Boolean)
      .join(' — ');
    if (openness) steps.push(['Is it open?', openness]);
    if (program.application_method) steps.push(['How to apply', program.application_method]);
    if (program.required_documents) steps.push(['What to bring', program.required_documents]);
    if (contacts.address) steps.push(['Where', contacts.address]);
    if (contacts.intake_hours) steps.push(['Hours', contacts.intake_hours]);
    if (steps.length) {
      item.append(
        el(
          'dl',
          { class: 'plan-item__steps' },
          steps.flatMap(([term, value]) => [el('dt', { text: term }), el('dd', { text: value })]),
        ),
      );
    }

    const contactBits = [];
    const phone = contactLink({
      value: contacts.phone,
      pattern: PHONE_RE,
      scheme: 'tel',
      sanitize: (v) => v.replace(/[^\d+]/g, ''),
    });
    if (phone) contactBits.push(phone);
    const email = contactLink({ value: contacts.email, pattern: EMAIL_RE, scheme: 'mailto' });
    if (email) contactBits.push(email);
    if (contactBits.length) item.append(el('div', { class: 'result__contact' }, contactBits));

    const links = [];
    const formUrl = formUrlFor(program);
    if (formUrl) {
      links.push(
        el('a', {
          class: 'btn btn--primary btn--sm',
          href: formUrl,
          target: '_blank',
          rel: 'noopener noreferrer',
          text: 'Get the application form',
        }),
      );
    }
    if (program.source_url) {
      links.push(
        el('a', {
          class: 'btn btn--ghost btn--sm',
          href: program.source_url,
          target: '_blank',
          rel: 'noopener noreferrer',
          text: 'Program details',
        }),
      );
    }
    if (links.length) item.append(el('div', { class: 'result__actions plan-item__links' }, links));

    list.append(item);
  }
  host.append(list);
}

$('#plan-view')?.addEventListener('click', () => showStep('plan'));

// ---------------------------------------------------------------------------
// Rental listings (Range Lab housing data, via the housing-search function)
// ---------------------------------------------------------------------------
// When "Finding a rental" is among the needs, the results page opens with an
// Available-rentals section — actual listings from the housing data API,
// which the housing-search edge function proxies so its key stays
// server-side. housing.js normalizes and screens them; this block fetches,
// caches, and renders.

let listings = null;
let listingsError = null;
let listingsKey = null; // per state|county, so path changes don't refetch

async function loadListings() {
  const key = `${answers.state}|${answers.counties.join('+')}`;
  if (listingsKey === key) return;

  listings = null;
  listingsError = null;
  try {
    listings = await fetchListings({
      url: HOUSING_API_URL,
      headers: HOUSING_API_HEADERS,
      state: answers.state,
      county: answers.county,
    });
  } catch (error) {
    listingsError = error;
  }
  listingsKey = key;
}

// The listings API carries a city but no county, and the screener asks for a
// county — CITY_COUNTIES (config.js) bridges the two. Null for a city the map
// doesn't know, which keeps the listing visible.
function countiesForCity(city, stateCode) {
  const byState = CITY_COUNTIES[String(stateCode || '').toUpperCase()];
  return (byState && byState[String(city).trim().toLowerCase()]) || null;
}

// The stroke house from the site's own brand mark, drawn faint — the photo
// placeholder for listings whose API record carries no image.
const HOUSE_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/><path d="M9.5 21v-6h5v6"/></svg>';

// Photo-forward listing card: an image (or placeholder) on top with the
// affordability badge overlaid, the rent beside the name, one quiet facts
// line, and a contact/action footer.
function renderListingCard({ listing, affordable }) {
  const card = el('li', { class: 'result result--listing' });
  const budget = monthlyBudget(answers.income);
  const cap = answers.maxRent != null ? Number(answers.maxRent) : budget;

  card.append(
    el('div', { class: 'result__media' }, [
      listing.photo
        ? el('img', { src: listing.photo, alt: '', loading: 'lazy' })
        : el('span', { class: 'result__media-placeholder', html: HOUSE_SVG }),
    ]),
  );

  const body = el('div', { class: 'result__lbody' });

  // Rent leads: it is the first thing anyone looks for, and the reason the
  // list is sorted the way it is.
  body.append(
    el('div', { class: 'result__headline' }, [
      el('span', {
        class: `result__rent${listing.rent == null ? ' result__rent--unknown' : ''}`,
        html: listing.rent != null ? `${money(listing.rent)}<small>/mo</small>` : 'Rent not listed',
      }),
      listing.availability
        ? el('span', { class: 'result__avail' }, [
            el('span', { class: 'dot dot--open', 'aria-hidden': 'true' }),
            listing.availability,
          ])
        : null,
    ]),
  );

  const facts = [
    bedroomsLabel(listing.bedrooms),
    listing.bathrooms != null && `${listing.bathrooms} bath`,
    listing.type,
    listing.subsidized && 'Income-restricted',
  ].filter(Boolean);
  if (facts.length) {
    body.append(el('p', { class: 'result__facts', text: facts.join(' · ') }));
  }

  // The feed often uses the street address AS the name, so the two must not
  // cancel each other out — dropping the "duplicate" left cards showing only
  // a city. Street always shows; a genuinely different name (a named
  // community) gets its own line above it.
  const street = listing.address || listing.name;
  const named = listing.name && listing.name !== street ? listing.name : null;
  if (named) body.append(el('p', { class: 'result__name', text: named }));
  const place = [street, listing.city].filter(Boolean).join(', ');
  if (place) body.append(el('p', { class: 'result__admin', text: place }));

  // Saying HOW FAR under the cap is more use than saying it fits: it is the
  // difference between "this is possible" and "this leaves room for bills".
  if (affordable === true && listing.rent != null && cap > 0) {
    const under = Math.round(cap - listing.rent);
    body.append(
      el('p', { class: 'result__budget result__budget--in' }, [
        el('strong', { text: '✓ Within your budget' }),
        under > 0
          ? el('small', {
              text: `${money(under)} below your ${answers.maxRent != null ? 'maximum' : 'recommended max'}`,
            })
          : null,
      ]),
    );
  } else if (affordable === false && listing.rent != null && budget > 0) {
    const over = Math.round(listing.rent - budget);
    body.append(
      el('p', { class: 'result__budget result__budget--over' }, [
        el('strong', { text: '◔ Above the 30% guideline' }),
        el('small', { text: `${money(over)} over — rent help may close the gap` }),
      ]),
    );
  }

  const contact =
    contactLink({
      value: listing.phone,
      pattern: PHONE_RE,
      scheme: 'tel',
      sanitize: (v) => v.replace(/[^\d+]/g, ''),
    }) || contactLink({ value: listing.email, pattern: EMAIL_RE, scheme: 'mailto' });

  const action = listing.url
    ? el('a', {
        class: 'btn btn--primary',
        href: listing.url,
        target: '_blank',
        rel: 'noopener noreferrer',
        text: 'View rental',
      })
    : contact && listing.rent == null
      ? el('span', { class: 'result__foot-note', text: 'Call to ask about rent' })
      : null;

  if (contact || action) {
    body.append(el('div', { class: 'result__foot' }, [contact, action]));
  }

  card.append(body);
  return card;
}

// The Available-rentals block at the top of the results. Its failures stay
// inline and small — a broken listings feed must never take the program
// results down with it.
function buildListingsSection() {
  const frag = el('section', { class: 'rsection', id: 'rentals' });

  if (listingsError) {
    const isMissingApi = listingsError.message === 'MISSING_HOUSING_API';
    frag.append(
      el('h3', { class: 'rsection__title', text: 'Rentals within your budget' }),
      el('div', { class: 'listings-note' }, [
        el('span', {
          text: isMissingApi
            ? 'The rental listings source isn’t configured yet — see the rental search section of web/README.md.'
            : `Couldn't load rental listings: ${listingsError.message}`,
        }),
        !isMissingApi &&
          el('button', {
            type: 'button',
            class: 'btn btn--ghost btn--sm',
            text: 'Try again',
            onclick: () => {
              listingsKey = null;
              renderResults();
            },
          }),
      ]),
    );
    return frag;
  }

  const matches = screenListings(listings || [], answers, countiesForCity);
  const total = (listings || []).length;
  frag.append(
    el('div', { class: 'rsection__head' }, [
      el('h3', { class: 'rsection__title', text: 'Rentals within your budget' }),
      el('span', {
        class: 'rsection__count',
        text: total > matches.length
          ? `${matches.length} of ${total} rentals · lowest rent first`
          : `${matches.length} rental${matches.length === 1 ? '' : 's'} · lowest rent first`,
      }),
    ]),
  );

  if (!matches.length) {
    const areaLabel =
      answers.counties.length > 1
        ? `${answers.counties.join(' / ')} counties`
        : `${answers.county} County`;
    frag.append(
      el('div', { class: 'listings-note' }, [
        el('span', {
          text: `No current listings matched in ${areaLabel}. Listings turn over quickly — worth checking back, or try loosening your max rent or size.`,
        }),
      ]),
    );
    return frag;
  }

  const budget = monthlyBudget(answers.income);
  const cap = answers.maxRent != null ? Number(answers.maxRent) : budget;
  frag.append(
    el('p', {
      class: 'rsection__hint',
      text:
        (cap > 0
          ? `These fit ${answers.maxRent != null ? 'the maximum you set' : 'your recommended maximum'} of about ${money(cap)}/month. `
          : '') +
        'Budget fit is an estimate — the landlord sets the final terms.',
    }),
  );

  // Same fold as the program sections: best four, the rest behind Show more
  // (which the print handler expands along with everything else).
  const VISIBLE = 4;
  const list = el(
    'ul',
    { class: 'results__list results__list--rentals' },
    matches.slice(0, VISIBLE).map(renderListingCard),
  );
  frag.append(list);
  const rest = matches.slice(VISIBLE);
  if (rest.length) {
    const btn = el('button', {
      type: 'button',
      class: 'btn btn--ghost btn--sm results__more',
      text: `Show ${rest.length} more`,
      onclick: () => {
        rest.forEach((m) => list.append(renderListingCard(m)));
        btn.remove();
      },
    });
    frag.append(btn);
  }
  return frag;
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

function formUrlFor(program) {
  const form = (program.forms || []).find((f) => f.storage_path || f.has_real_form);
  if (!form) return null;
  if (form.storage_path) {
    return `${SUPABASE_URL}/storage/v1/object/public/${FORMS_BUCKET}/${form.storage_path}`;
  }
  return form.has_real_form ? form.form_url : null;
}

// The contact columns are free text transcribed by researchers: phone fields
// carry fax numbers and extensions ("(541) 779-5785 (fax 541-857-1118)"),
// and the email column sometimes holds a street address or a note like
// "Not published; use phone". Pull out the first real value for the link and
// fall back to plain text, so nobody taps a dead tel:/mailto: link.
const PHONE_RE = /(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/;
const EMAIL_RE = /[^\s;,<>()]+@[^\s;,<>()]+\.[a-z]{2,}/i;

function contactLink({ value, pattern, scheme, sanitize }) {
  if (!value) return null;
  const match = value.match(pattern);
  if (!match) return el('span', { text: value });
  const target = sanitize ? sanitize(match[0]) : match[0];
  return el('a', { href: `${scheme}:${target}`, text: value });
}

// Labels for the "built for you" tags on a result card — shown when a
// program specifically serves a circumstance the person confirmed.
const FIT_LABELS = {
  veteran: 'For veterans',
  senior: 'For seniors 60+',
  disability: 'For people with disabilities',
  children: 'For families with children',
  crisis: 'For crisis situations',
  firstTimeBuyer: 'For first-time buyers',
  unhoused: 'For people without stable housing',
};

// Results group by what a program actually is, so rent help, homebuying
// help, and utility help never interleave. Classification order matters:
// hybrid categories (utility payment + housing stabilisation) count as
// their primary thing, checked first.
const RESULT_SECTIONS = [
  { id: 'buy', label: 'Buying a home', test: /down payment|homebuyer|home ?ownership/i },
  { id: 'repair', label: 'Home repair', test: /home repair|rehabilitation|weatheriz/i },
  { id: 'utility', label: 'Utility bills', test: /utility|energy|heat|water|sewer|electric|gas/i },
  { id: 'housing', label: 'Housing & rent help', test: /rent|housing|shelter|homeless|stabili|eviction/i },
];

function sectionOf(category) {
  return RESULT_SECTIONS.find((s) => s.test.test(category || ''))?.id || 'other';
}

// Sections the person actually asked about come first.
function sectionDisplayOrder() {
  const wants = {
    housing: answers.help.includes('rental') || answers.help.includes('staying'),
    buy: answers.help.includes('buying'),
    repair: answers.help.includes('staying'),
    utility: answers.help.includes('utility') || answers.help.includes('staying'),
    other: false,
  };
  return [
    { id: 'housing', label: 'Housing & rent help' },
    { id: 'buy', label: 'Buying a home' },
    { id: 'repair', label: 'Home repair' },
    { id: 'utility', label: 'Utility bills' },
    { id: 'other', label: 'Other support' },
  ]
    .map((s, i) => ({ ...s, rank: (wants[s.id] ? 0 : 100) + i }))
    .sort((a, b) => a.rank - b.rank);
}

function renderResultCard(match, { lead = false } = {}) {
  const { program, verdict, checks, fit } = match;

  // The card stays compact — name, who runs it, tags, benefit, caveat
  // count. Details open in a focused dialog instead of expanding in
  // place, so the grid never distorts.
  const outer = el('li', { class: `result${lead ? ' result--lead' : ''}` });
  outer.addEventListener('click', (event) => {
    // Links and buttons inside the card do their own thing.
    if (event.target.closest('a, button')) return;
    openProgramDialog(match);
  });

  outer.append(
    el('div', { class: 'result__head' }, [
      el('div', { class: 'result__headmain' }, [
        el('h3', { class: 'result__name', text: program.program_name }),
        program.administrator &&
          el('p', { class: 'result__admin', text: program.administrator }),
        checks.length
          ? el('p', {
              class: 'result__caveats',
              text: `${checks.length} thing${checks.length === 1 ? '' : 's'} worth checking`,
            })
          : null,
      ]),
      // The badge stands alone up here — a button beside it crushed the
      // name column in narrow grid columns.
      el('span', { class: 'result__headside' }, [
        el('span', {
          class: `badge badge--${verdict}`,
          text: verdict === 'likely' ? '✓ Likely match' : 'Possible match',
        }),
      ]),
      // Tags get the card's full width — a long one overflows the name
      // column in a four-column grid.
      fit && fit.length
        ? el(
            'div',
            { class: 'result__fit' },
            fit.map((k) => el('span', { class: 'tag tag--fit', text: FIT_LABELS[k] || k })),
          )
        : null,
      // The full benefit stays visible on the collapsed card — what a
      // program pays is half of deciding whether to open it. It wraps to
      // its own full-width line under the head row, and hides when the
      // open body shows its own copy.
      program.max_benefit
        ? el('p', { class: 'result__gets' }, [
            el('span', { class: 'result__gets-label', text: 'May get:' }),
            el('span', { text: program.max_benefit }),
          ])
        : null,
    ]),
    // Actions sit in their own row pinned to the card's bottom edge, so
    // stretched cards in a row share one aligned button line.
    el('div', { class: 'result__cardactions' }, [
      el('button', {
        type: 'button',
        class: `btn btn--ghost btn--sm plan-toggle${inPlan(program.program_id) ? ' plan-toggle--on' : ''}`,
        'data-program': program.program_id,
        text: planToggleLabel(program.program_id),
        onclick: (event) => {
          event.stopPropagation();
          togglePlan(program.program_id);
        },
      }),
      el('button', {
        type: 'button',
        class: 'btn btn--ghost btn--sm',
        text: 'See details',
        onclick: () => openProgramDialog(match),
      }),
    ]),
  );

  return outer;
}

// The full program detail shown inside the dialog: facts in a readable
// main column, everything actionable in an aside rail.
const programDialog = document.getElementById('program-dialog');

function openProgramDialog(match) {
  const { program, verdict } = match;
  const eligibility = program.eligibility || {};
  const contacts = program.contacts || {};
  const phone = contacts.phone && PHONE_RE.test(contacts.phone) ? contacts.phone : null;
  const firstNumber = phone ? phone.split(';')[0].trim() : null;

  // --- What to do next -------------------------------------------------
  // The rail is a numbered sequence, not a fold: someone who has decided to
  // act needs to know what the first move is, and the call button IS step one
  // wherever there is a number to call.
  const steps = [];
  if (firstNumber) {
    steps.push([
      contacts.intake_hours ? `Call ${contacts.intake_hours.toLowerCase().includes('helpline') ? 'the HelpLine' : 'them'}` : 'Call them',
      el('a', {
        class: 'btn btn--primary pdialog__call',
        href: `tel:${firstNumber.replace(/[^\d+]/g, '')}`,
        text: `☎ Call ${firstNumber}`,
      }),
    ]);
  }
  if (program.application_method) {
    steps.push([program.application_method, null]);
  } else if (!firstNumber && program.source_url) {
    steps.push(['Apply through the program’s own website', null]);
  }
  if (program.required_documents) {
    steps.push([`Bring what they ask for: ${program.required_documents}`, null]);
  }
  steps.push(['They will confirm whether you qualify and what they can offer.', null]);

  const rail = el('div', { class: 'pdialog__rail' }, [
    el('h4', { class: 'pdialog__railtitle', text: 'What to do next' }),
    el(
      'ol',
      { class: 'steps' },
      steps.map(([text, node]) =>
        el('li', { class: 'steps__item' }, [
          el('span', { class: 'steps__body' }, [el('span', { text }), node]),
        ]),
      ),
    ),
    program.application_status || contacts.intake_hours
      ? el('p', { class: 'pdialog__open' }, [
          el('span', { class: 'dot dot--open', 'aria-hidden': 'true' }),
          [program.application_status, contacts.intake_hours].filter(Boolean).join(' · '),
        ])
      : null,
  ]);

  // --- The facts -------------------------------------------------------
  const facts = el('div', { class: 'pdialog__facts' });
  if (eligibility.summary) {
    facts.append(
      el('h4', { class: 'pdialog__label', text: 'Why this may help' }),
      el('p', { class: 'pdialog__text', text: eligibility.summary }),
    );
  }
  const benefit = program.benefit_summary || program.max_benefit;
  if (benefit) {
    facts.append(
      el('h4', { class: 'pdialog__label', text: 'What you may receive' }),
      el('p', { class: 'pdialog__text pdialog__text--strong', text: benefit }),
    );
  }
  if (program.required_documents) {
    facts.append(
      el('h4', { class: 'pdialog__label', text: 'What you need' }),
      el('p', { class: 'pdialog__text', text: program.required_documents }),
    );
  }
  if (match.checks?.length) {
    facts.append(
      el('h4', { class: 'pdialog__label', text: 'Worth checking' }),
      el('ul', { class: 'pdialog__checks' }, match.checks.map((c) => el('li', { text: c }))),
    );
  }
  // Location and hours sit side by side: they are the two things somebody
  // copies down before they set off.
  const place = [];
  if (contacts.address) {
    place.push(
      el('div', {}, [
        el('h4', { class: 'pdialog__label', text: 'Location' }),
        el('p', { class: 'pdialog__text', text: contacts.address }),
        el('a', {
          class: 'btn btn--ghost btn--sm',
          href: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(contacts.address)}`,
          target: '_blank',
          rel: 'noopener noreferrer',
          text: 'Get directions ↗',
        }),
      ]),
    );
  }
  if (contacts.intake_hours || phone) {
    place.push(
      el('div', {}, [
        el('h4', { class: 'pdialog__label', text: 'Hours & contact' }),
        contacts.intake_hours ? el('p', { class: 'pdialog__text', text: contacts.intake_hours }) : null,
        phone ? el('p', { class: 'pdialog__text', text: phone }) : null,
        contacts.email ? el('p', { class: 'pdialog__text', text: contacts.email }) : null,
      ]),
    );
  }
  if (place.length) facts.append(el('div', { class: 'pdialog__place' }, place));

  // --- Footer ----------------------------------------------------------
  const formUrl = formUrlFor(program);
  const footer = el('div', { class: 'pdialog__foot' }, [
    el('span', { class: 'pdialog__note', text: 'Details are estimates — confirm with the program.' }),
    el('div', { class: 'pdialog__footactions' }, [
      formUrl
        ? el('a', {
            class: 'btn btn--ghost',
            href: formUrl,
            target: '_blank',
            rel: 'noopener noreferrer',
            text: 'Get the application form',
          })
        : program.source_url
          ? el('a', {
              class: 'btn btn--ghost',
              href: program.source_url,
              target: '_blank',
              rel: 'noopener noreferrer',
              text: 'View full program details',
            })
          : null,
      el('button', {
        type: 'button',
        class: `btn plan-toggle btn--solid${inPlan(program.program_id) ? ' plan-toggle--on' : ''}`,
        'data-program': program.program_id,
        text: planToggleLabel(program.program_id),
        onclick: () => togglePlan(program.program_id),
      }),
    ]),
  ]);

  programDialog.replaceChildren(
    el('div', { class: 'pdialog__top' }, [
      el('div', { class: 'pdialog__flags' }, [
        matchBadge(match),
        el('span', { class: 'pdialog__reason', text: matchReason(match) }),
        crisisTag(match),
      ]),
      el('button', {
        type: 'button',
        class: 'pdialog__close',
        'aria-label': 'Close',
        text: '✕',
        onclick: () => programDialog.close(),
      }),
    ]),
    el('h3', { class: 'pdialog__name', id: 'pdialog-title', text: program.program_name }),
    el('p', {
      class: 'pdialog__where',
      text: [programWhere(program), program.administrator && `Run by ${program.administrator}`]
        .filter(Boolean)
        .join(' · '),
    }),
    el('div', { class: 'pdialog__cols' }, [facts, rail]),
    footer,
  );
  programDialog.showModal();
  programDialog.querySelector('.pdialog__close')?.focus();
}

function renderNotice({ icon, title, body, actionLabel, onAction }) {
  return el('div', { class: 'notice' }, [
    el('span', { class: 'notice__icon', 'aria-hidden': 'true', text: icon }),
    el('h2', { text: title }),
    el('p', { text: body }),
    actionLabel &&
      el('button', {
        type: 'button',
        class: 'btn btn--primary',
        text: actionLabel,
        onclick: onAction,
      }),
  ]);
}

// Each chip carries the step it edits: on the results page they are buttons
// that jump straight back to that question, answers intact — a two-tap
// correction instead of Start over.
function answerChips() {
  const areaLabel =
    answers.counties.length > 1
      ? `${answers.counties.join(', ')} counties, ${answers.state}`
      : `${answers.county} County, ${answers.state}`;
  const chips = [[areaLabel, 'county']];

  const helpLabels = {
    rental: 'Finding a home',
    staying: 'Staying housed',
    buying: 'Buying a house',
    utility: 'Utility bill',
  };
  chips.push([answers.help.map((h) => helpLabels[h] || h).join(' · '), 'help']);

  // The rental search preferences, when any were set.
  if (answers.help.includes('rental')) {
    const bits = [];
    if (answers.bedrooms && answers.bedrooms !== 'any') {
      bits.push(answers.bedrooms === '0' ? 'Studio+' : `${answers.bedrooms}+ bd`);
    }
    if (answers.bathrooms && answers.bathrooms !== 'any') bits.push(`${answers.bathrooms}+ ba`);
    if (answers.maxRent != null) bits.push(`≤ $${currency.format(answers.maxRent)}/mo`);
    if (bits.length) chips.push([bits.join(' · '), 'bedrooms']);
  }

  const situationLabels = {
    renting: 'Renting',
    homeowner: 'Homeowner',
  };
  if (situationLabels[answers.situation]) chips.push([situationLabels[answers.situation], 'situation']);
  chips.push([
    `${answers.householdSize} ${answers.householdSize === 1 ? 'person' : 'people'}`,
    'household',
  ]);
  if (answers.income != null) chips.push([`$${currency.format(answers.income)}/yr`, 'income']);
  else chips.push(['Income not given', 'income']);

  return chips;
}

// Results renders await network calls, and the person can change answers
// while one is in flight; each render claims a sequence number and abandons
// itself the moment a newer render starts, so a slow fetch can never paint
// stale results over current ones.
let renderSeq = 0;

// ---------------------------------------------------------------------------
// Results — the 2026 redesign
// ---------------------------------------------------------------------------
// The page answers five questions in order, and the sections below are those
// answers: what am I working with (needs summary) -> is this an emergency
// (crisis strip) -> what should I do first (best next steps) -> what can I
// afford (rentals in budget) -> what else is there (more programs).

/** "Based on 3 of your answers" / "One requirement needs to be confirmed". */
function matchReason(match) {
  if (match.verdict === 'likely') {
    const n = (match.matched || []).length;
    if (!n) return 'Nothing in your answers rules this out';
    return `Based on ${n} of your answer${n === 1 ? '' : 's'}`;
  }
  const n = (match.checks || []).length;
  return n === 1
    ? 'One eligibility requirement needs to be confirmed'
    : `${n} requirements need to be confirmed`;
}

function matchBadge(match) {
  return match.verdict === 'likely'
    ? el('span', { class: 'badge badge--likely', text: '✓ Likely match' })
    : el('span', { class: 'badge badge--possible', text: '◔ Worth checking' });
}

// Whether a programme is BUILT for a crisis. Read from the programme, not
// from what the person ticked: someone fleeing violence at 2am has not
// necessarily checked a box, and a 24/7 line they qualify for should not be
// hidden because of it. Same three-column evidence the matcher uses for
// homeless-serving, because markets document this inconsistently.
const CRISIS_EVIDENCE =
  /homeless|unstably housed|transitional|shelter|crisis|domestic violence|survivor|traffick|eviction|displac|hotline|help ?line/i;

function servesCrisis(program) {
  const e = program.eligibility || {};
  return CRISIS_EVIDENCE.test(
    [e.crisis_required, e.eligible_tenure, e.summary, program.program_name, program.category]
      .filter(Boolean)
      .join(' '),
  );
}

/** Programs built for a crisis carry a tag, in the accent at a darker weight. */
function crisisTag(match) {
  return servesCrisis(match.program)
    ? el('span', { class: 'tag tag--crisis', text: 'For crisis situations' })
    : null;
}

/** Category · county, the one line that says what a program is and where. */
function programWhere(program) {
  const counties = (program.program_counties || [])
    .filter((c) => !c.state_code || c.state_code === answers.state)
    .map((c) => c.county)
    .filter((c) => c !== 'Unspecified');
  const area = counties.includes('Statewide')
    ? 'Statewide'
    : counties.length === 1
      ? `${counties[0]} County`
      : counties.length
        ? `${counties.length} counties`
        : null;
  return [program.category, area].filter(Boolean).join(' · ');
}

/**
 * "Your housing needs" — the answers this page was built from, as a readable
 * summary rather than a row of chips. Every line is editable in one click,
 * which is what the chips were for.
 */
function buildNeedsCard() {
  const rows = [];
  const jump = (step) => () => {
    profileSteps.delete(step);
    showStep(step);
  };

  const area = answers.counties.length
    ? `${answers.counties.join(' & ')} Count${answers.counties.length === 1 ? 'y' : 'ies'}, ${answers.state}`
    : null;
  if (area) rows.push(['Where', area, null]);

  if (answers.householdSize) {
    rows.push(['Household', `${answers.householdSize} ${answers.householdSize === 1 ? 'person' : 'people'}`, null]);
  }

  const wants = [];
  if (answers.help.includes('rental')) wants.push('Rent');
  if (answers.help.includes('buying')) wants.push('Buy');
  if (answers.help.includes('staying')) wants.push('Stay housed');
  if (answers.help.includes('utility')) wants.push('Utility help');
  const size = answers.bedrooms != null && answers.bedrooms !== 'any'
    ? bedroomsLabel(Number(answers.bedrooms))
    : null;
  if (wants.length) {
    rows.push(['Looking to', [wants.join(' · '), size && `${size} or more`].filter(Boolean).join(' · '), null]);
  }

  // The budget line prefers what the person set over what we recommend, and
  // says which it is showing — a recommendation presented as a decision would
  // be putting words in their mouth.
  const budget = monthlyBudget(answers.income);
  if (answers.maxRent != null) {
    rows.push(['Budget', `Up to ${money(answers.maxRent)}/month`, 'The most you told us you can pay']);
  } else if (budget > 0) {
    rows.push(['Budget', `Up to about ${money(budget)}/month`, 'Recommended, based on 30% of income']);
  }

  return el('aside', { class: 'needs' }, [
    el('div', { class: 'needs__top' }, [
      el('h3', { class: 'needs__title', text: 'Your housing needs' }),
      el('button', {
        type: 'button',
        class: 'btn btn--ghost btn--sm',
        text: '✎ Edit answers',
        onclick: jump(answers.help.includes('rental') ? 'bedrooms' : 'county'),
      }),
    ]),
    el(
      'dl',
      { class: 'needs__list' },
      rows.flatMap(([label, value, note]) => [
        el('dt', { text: label }),
        el('dd', {}, [el('strong', { text: value }), note ? el('small', { text: note }) : null]),
      ]),
    ),
    answers.income != null
      ? el('button', {
          type: 'button',
          class: 'needs__more',
          text: 'Show income details',
          onclick: (event) => {
            const detail = event.target.nextElementSibling;
            const open = detail.hidden;
            detail.hidden = !open;
            event.target.textContent = open ? 'Hide income details' : 'Show income details';
          },
        })
      : null,
    answers.income != null
      ? el('p', { class: 'needs__detail', hidden: true, text:
          `Household income of ${money(answers.income)} a year before taxes. Programs set their own limits and measure income their own way, so treat this as a starting point.` })
      : null,
  ]);
}

/**
 * The crisis strip.
 *
 * Only shown when the results actually contain a crisis programme with a
 * phone number — a "need help right now?" banner that leads nowhere is worse
 * than none. A 24/7 line is preferred over an office line for obvious
 * reasons.
 */
function buildCrisisStrip(matches) {
  const candidates = matches.filter(
    (m) => servesCrisis(m.program) && m.program.contacts?.phone && PHONE_RE.test(m.program.contacts.phone),
  );
  if (!candidates.length) return null;
  const best =
    candidates.find((m) => /24\s*\/?\s*7|24 hour|hotline|helpline/i.test(
      `${m.program.contacts.intake_hours || ''} ${m.program.program_name}`,
    )) || candidates[0];

  const phone = best.program.contacts.phone;
  const digits = String(phone).replace(/[^\d+]/g, '');
  const hours = best.program.contacts.intake_hours;

  return el('div', { class: 'crisis' }, [
    el('div', { class: 'crisis__text' }, [
      el('strong', { text: 'Need help right now?' }),
      el('span', {
        text: [hours, best.program.administrator || best.program.program_name]
          .filter(Boolean)
          .join(' · '),
      }),
    ]),
    el('a', { class: 'btn btn--primary crisis__call', href: `tel:${digits}`, text: `☎ Call ${phone.split(';')[0].trim()}` }),
  ]);
}

/** A "Best next steps" card: the full pitch for a programme worth acting on. */
function renderBestCard(match) {
  const { program } = match;
  const benefit = program.benefit_summary || program.max_benefit;
  const eligibility = program.eligibility || {};

  return el('li', { class: 'best' }, [
    el('div', { class: 'best__flags' }, [matchBadge(match), crisisTag(match)]),
    el('p', { class: 'best__reason', text: matchReason(match) }),
    el('h3', { class: 'best__name', text: program.program_name }),
    el('p', { class: 'best__where', text: programWhere(program) }),
    eligibility.summary
      ? el('p', { class: 'best__summary', text: eligibility.summary })
      : null,
    benefit
      ? el('div', { class: 'best__gets' }, [
          el('span', { class: 'best__gets-label', text: 'What you may receive' }),
          el('strong', { text: benefit }),
        ])
      : null,
    match.verdict === 'possible' && match.checks.length
      ? el('p', { class: 'best__check', text: `◔ ${match.checks[0]}` })
      : null,
    program.contacts?.intake_hours
      ? el('p', { class: 'best__status' }, [
          el('span', { class: 'dot dot--open', 'aria-hidden': 'true' }),
          program.contacts.intake_hours,
        ])
      : null,
    el('div', { class: 'best__actions' }, [
      el('button', {
        type: 'button',
        class: 'btn btn--primary',
        text: 'See how to get help',
        onclick: () => openProgramDialog(match),
      }),
      planToggleButton(program.program_id),
    ]),
  ]);
}

/**
 * The save control on programme cards.
 *
 * It carries data-program and is repainted by updatePlanUi() like every other
 * save control, so the same programme shown in a card and in the dialog can
 * never display two different states.
 */
function planToggleButton(id) {
  const button = el('button', {
    type: 'button',
    class: 'btn btn--ghost btn--sm save-btn',
    'data-program': id,
    onclick: (event) => {
      event.stopPropagation();
      togglePlan(id);
    },
  });
  paintSaveButton(button);
  return button;
}

function paintSaveButton(button) {
  const on = inPlan(button.dataset.program);
  button.classList.toggle('save-btn--on', on);
  button.setAttribute('aria-pressed', on ? 'true' : 'false');
  button.setAttribute('aria-label', on ? 'Saved to your plan — remove it' : 'Save to your plan');
  button.replaceChildren(
    el('span', { 'aria-hidden': 'true', text: on ? '♥' : '♡' }),
    el('span', { text: on ? ' Saved' : ' Save' }),
  );
}

/** A compact row for the long tail of programmes that need a detail confirmed. */
function renderCompactRow(match) {
  const { program } = match;
  return el('li', { class: 'crow' }, [
    el('div', { class: 'crow__main' }, [
      el('div', { class: 'crow__head' }, [
        el('h3', { class: 'crow__name', text: program.program_name }),
        // Carried on rows as well as cards: a programme built for a crisis is
        // worth spotting wherever it appears in the list.
        crisisTag(match),
      ]),
      el('p', { class: 'crow__meta' }, [
        programWhere(program),
        el('span', { class: 'crow__check' }, [
          ' · ',
          el('span', { text: match.verdict === 'likely' ? '✓ Likely match' : `◔ ${shortCheck(match)}` }),
        ]),
      ]),
    ]),
    el('div', { class: 'crow__actions' }, [
      planToggleButton(program.program_id),
      el('button', {
        type: 'button',
        class: 'btn btn--ghost btn--sm',
        text: 'Details →',
        onclick: () => openProgramDialog(match),
      }),
    ]),
  ]);
}

/** The shortest honest phrasing of what a programme still needs confirmed. */
function shortCheck(match) {
  const first = (match.checks || [])[0] || '';
  if (/income/i.test(first)) return 'Income limit needs confirming';
  if (/veteran/i.test(first)) return 'Veteran status needs confirming';
  if (/age/i.test(first)) return 'Age requirement needs confirming';
  if (/disab/i.test(first)) return 'Disability requirement needs confirming';
  if (/children|pregnan/i.test(first)) return 'Household requirement needs confirming';
  if (/eviction|shutoff|crisis|displace/i.test(first)) return 'Crisis requirement needs confirming';
  if (/utility account/i.test(first)) return 'Utility account needs confirming';
  if (/housing situation|tenure/i.test(first)) return 'Housing situation needs confirming';
  if (/service area|county/i.test(first)) return 'Service area needs confirming';
  return 'One detail needs confirming';
}

async function renderResults() {
  const seq = ++renderSeq;
  const host = $('#results-state');
  host.replaceChildren();

  // "See details" in the landing page's quick check names a program to open
  // once the results exist. Read once, so a later re-render (editing a chip)
  // does not pop the dialog open again.
  const openOnArrival = pendingProgramId;
  pendingProgramId = null;

  // Rentals load in parallel with the program data; the section renders
  // once both are in.
  const listingsPromise = answers.help.includes('rental') ? loadListings() : null;

  if (!programs && !fetchError) {
    host.append(
      el('div', { class: 'skeleton' }, [
        el('div', { class: 'skeleton__card' }),
        el('div', { class: 'skeleton__card' }),
        el('div', { class: 'skeleton__card' }),
      ]),
    );
    try {
      programs = await fetchPrograms();
    } catch (error) {
      fetchError = error;
    }
    if (seq !== renderSeq) return;
    host.replaceChildren();
  }

  // The warm fetch on county selection usually has this ready; awaiting covers
  // a slow connection or a failed warm-up. If it still fails, every lookup
  // returns null and income limits become "worth checking" notes rather than
  // exclusions — nobody is filtered out on data we don't have.
  if (!fetchError && answers.areaIds.length) {
    try {
      await fetchLimits(answers.areaIds, answers.statewideAreaId);
    } catch {
      /* fall through with whatever limits we have */
    }
    if (seq !== renderSeq) return;
  }

  if (fetchError) {
    const isMissingKey = fetchError.message === 'MISSING_KEY';
    host.append(
      renderNotice({
        icon: isMissingKey ? '🔑' : '⚠️',
        title: isMissingKey ? 'Connection not configured yet' : "Couldn't load programs",
        body: isMissingKey
          ? 'Add your Supabase "anon public" key to web/config.js, then reload this page.'
          : `${fetchError.message}. Check your connection and try again.`,
        actionLabel: 'Try again',
        onAction: () => {
          fetchError = null;
          renderResults();
        },
      }),
    );
    return;
  }

  const matches = screenPrograms(programs, answers, limitLookup, proportionalStandards);
  const strong = matches.filter((m) => m.verdict === 'likely');
  const worthChecking = matches.filter((m) => m.verdict !== 'likely');

  // The headline is filled in properly once the rentals resolve; this is what
  // it says when there are none to count.
  const headline = el('h2', { class: 'results__count', text:
    matches.length
      ? `${matches.length} program${matches.length === 1 ? '' : 's'} may be able to help`
      : 'No clear program matches in your area' });

  const strongLine = el('p', { class: 'results__strong', hidden: !strong.length, text:
    `✓ ${strong.length} program${strong.length === 1 ? '' : 's'} may be a strong match for you` });

  const jumpTo = (selector, label) =>
    el('button', {
      type: 'button',
      class: 'btn btn--primary',
      text: label,
      onclick: () => {
        const target = host.querySelector(selector);
        target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      },
    });

  const header = el('div', { class: 'results__header' }, [
    el('div', { class: 'results__intro' }, [
      headline,
      strongLine,
      matches.length
        ? el('p', {
            class: 'results__summary',
            text: strong.length
              ? 'Start with the strongest matches below. Availability changes fast — call before visiting.'
              : 'Each of these has a requirement we could not confirm from your answers, so they are worth a call.',
          })
        : null,
      el('div', { class: 'results__cta' }, [
        matches.length ? jumpTo('#best-steps', 'See best next steps ↓') : null,
        el('button', {
          type: 'button',
          class: 'btn btn--ghost results__share',
          text: 'Copy link to these results',
          onclick: async (event) => {
            try {
              await navigator.clipboard.writeText(location.href);
              event.target.textContent = 'Link copied ✓';
              setTimeout(() => {
                event.target.textContent = 'Copy link to these results';
              }, 2000);
            } catch {
              /* clipboard denied: the URL in the address bar is the same link */
            }
          },
        }),
      ]),
    ]),
    buildNeedsCard(),
  ]);
  host.append(header);

  const crisis = buildCrisisStrip(matches);
  if (crisis) host.append(crisis);

  // Actual rentals lead the page for anyone finding a rental — the concrete
  // thing they asked for, above the programs that help pay for it.
  // The rentals section is built after the programmes so "best next steps"
  // sits first in the DOM, then moved above them: what someone can act on
  // today leads the page, but the jump link still has a target to find.
  let rentalsSection = null;
  let places = 0;
  if (listingsPromise) {
    await listingsPromise;
    if (seq !== renderSeq) return;
    places = listingsError ? 0 : screenListings(listings || [], answers, countiesForCity).length;
    if (places) {
      // The headline counts what is actually on the page: "2 programs" above
      // sixty rentals undersells it for someone looking for a place.
      headline.textContent = `We found ${places} housing option${places === 1 ? '' : 's'}`;
      const cta = header.querySelector('.results__cta');
      const browse = el('button', {
        type: 'button',
        class: 'btn btn--ghost',
        text: 'Browse rentals in budget',
        onclick: () => host.querySelector('#rentals')?.scrollIntoView({ behavior: 'smooth', block: 'start' }),
      });
      // After the primary, not before it: "see best next steps" is the action
      // this page is recommending.
      cta.firstElementChild ? cta.firstElementChild.after(browse) : cta.prepend(browse);
    }
    rentalsSection = buildListingsSection();
  }

  if (!matches.length) {
    if (rentalsSection) host.append(rentalsSection);
    host.append(
      renderNotice({
        icon: '🔍',
        title: 'Nothing matched every answer',
        body:
          'That does not mean there is no help available. Call 211 to talk with someone who can look at your situation directly, or go back and try adjusting your answers.',
        actionLabel: 'Change my answers',
        onAction: () => showStep('circumstances'),
      }),
    );
  } else {
    // Best next steps: the programmes worth acting on today, in full. Capped
    // at three — a list of "start here" that runs to a dozen is not a
    // starting point. Anything beyond it joins the list below.
    const BEST = 3;
    const best = (strong.length ? strong : worthChecking).slice(0, BEST);
    const rest = [...strong.slice(best.length), ...worthChecking].filter(
      (m) => !best.includes(m),
    );

    const bestSection = el('section', { class: 'rsection', id: 'best-steps' }, [
      el('div', { class: 'rsection__head' }, [
        el('h3', { class: 'rsection__title', text: 'Best next steps' }),
        el('span', { class: 'rsection__count', text: `${best.length} program${best.length === 1 ? '' : 's'}` }),
      ]),
      el('p', {
        class: 'rsection__hint',
        text: strong.length
          ? 'These programs may make housing attainable — reach out to them first.'
          : 'Start with these, and ask about the detail each one still needs.',
      }),
      el('ul', { class: 'best-list' }, best.map(renderBestCard)),
    ]);
    host.append(bestSection);

    // Rentals sit between the two programme groups: act-today help first,
    // then somewhere to live, then the longer list to work through.
    if (rentalsSection) host.append(rentalsSection);

    if (rest.length) {
      const list = el('ul', { class: 'crow-list' }, rest.slice(0, 4).map(renderCompactRow));
      const more = rest.slice(4);
      const section = el('section', { class: 'rsection' }, [
        el('div', { class: 'rsection__head' }, [
          el('h3', { class: 'rsection__title', text: 'More programs that may help' }),
          el('span', { class: 'rsection__count', text: `${rest.length} program${rest.length === 1 ? '' : 's'}` }),
        ]),
        el('p', {
          class: 'rsection__hint',
          text: 'Each of these needs a detail or two confirmed before we can say how well it fits.',
        }),
        list,
      ]);
      if (more.length) {
        const btn = el('button', {
          type: 'button',
          class: 'btn btn--ghost btn--sm results__more',
          text: `Show all ${rest.length} programs`,
          onclick: () => {
            more.forEach((m) => list.append(renderCompactRow(m)));
            btn.remove();
          },
        });
        section.append(btn);
      }
      host.append(section);
    }
  }

  host.append(
    el('div', { class: 'step__actions' }, [
      el('button', {
        type: 'button',
        class: 'btn btn--ghost',
        text: 'Change my answers',
        onclick: () => showStep('circumstances'),
      }),
      el('button', {
        type: 'button',
        class: 'btn btn--ghost',
        text: 'Print or save',
        onclick: () => {
          // The printout is a full referral sheet, so folded-away
          // programs come out from behind their Show-more buttons first.
          $$('.results__more').forEach((b) => b.click());
          window.print();
        },
      }),
      el('button', {
        type: 'button',
        class: 'btn btn--ghost',
        text: 'Start over',
        onclick: restart,
      }),
    ]),
  );

  // An offer, never a wall: the results above are complete and printable
  // without an account. Someone signed in already has all of this.
  if (!isSignedIn()) {
    host.append(
      el('p', { class: 'results__account-offer' }, [
        'Want these to still be here next time? ',
        el('a', { href: 'signup/', text: 'Create an account' }),
        ' and we’ll bring these answers across — or keep using it without one.',
      ]),
    );
  }

  // Somebody who pressed "See details" on the landing page asked for one
  // specific program. Open it now that its card exists — but only if it is
  // actually among the matches, so a stale id can never open an empty dialog.
  if (openOnArrival) {
    const wanted = matches.find((m) => m.program.program_id === openOnArrival);
    if (wanted) openProgramDialog(wanted);
  }
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

function init() {
  buildStateChoices();
  $('#county-filter').addEventListener('input', filterCountyChoices);
  wireHelpChoices();
  wireRentalPrefs();
  wireIncomeStep();
  wireCircumstances();

  $('#ftb-choice').hidden = true;

  $$('[data-action="next"]').forEach((btn) => btn.addEventListener('click', goNext));
  $$('[data-action="back"]').forEach((btn) => btn.addEventListener('click', goBack));
  $('#restart-top').addEventListener('click', restart);

  $('#hh-minus').addEventListener('click', () => setHouseholdSize(answers.householdSize - 1));
  $('#hh-plus').addEventListener('click', () => setHouseholdSize(answers.householdSize + 1));
  $('#household-size').addEventListener('change', (e) =>
    setHouseholdSize(Number(e.target.value)),
  );

  // Enter advances, as long as the step's Continue is enabled. The county
  // filter is exempt: Enter is the natural act in a search box, and
  // advancing mid-filter would carry the previously selected county along.
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    if (event.target.matches('a, button, #county-filter')) return;
    const btn = $(`.step[data-step="${currentStep()}"] [data-action="next"]`);
    if (btn && !btn.disabled) {
      event.preventDefault();
      btn.click();
    }
  });

  setHouseholdSize(1);
  refreshContinueButtons();

  // A shared results link beats a saved session; a saved session beats
  // starting over.
  const shared = decodeShareHash(location.hash);
  let resumeStep = null;
  if (shared) {
    Object.assign(answers, shared);
    hydrateUi();
    resumeStep = 'results';
  } else {
    try {
      const saved = JSON.parse(sessionStorage.getItem(ANSWERS_KEY) || 'null');
      if (saved && saved.answers && saved.answers.state) {
        Object.assign(answers, saved.answers);
        // Sessions saved before the multi-select help step.
        if (typeof answers.help === 'string') {
          answers.help = answers.help === 'finding' ? ['rental'] : [answers.help];
        }
        if (!Array.isArray(answers.help)) answers.help = [];
        if (answers.situation === 'buying') {
          if (!answers.help.includes('buying')) answers.help.push('buying');
          answers.situation = null;
        }
        if (!['renting', 'homeowner'].includes(answers.situation)) answers.situation = null;
        // Sessions saved before the multi-county local area and the income
        // period toggle.
        if (!Array.isArray(answers.counties) || !answers.counties.length) {
          answers.counties = answers.county ? [answers.county] : [];
          answers.areaIds = answers.areaId ? [answers.areaId] : [];
        }
        if (answers.incomePeriod !== 'month') answers.incomePeriod = 'year';
        hydrateUi();
        if (saved.step && saved.step !== 'intro') resumeStep = saved.step;
      }
    } catch {
      /* a corrupt save just means starting fresh */
    }
  }
  renderAccountLink();

  // Warm the cache while the person reads the intro, so results feel instant.
  fetchPrograms()
    .then((rows) => {
      programs = rows;
    })
    .catch((error) => {
      fetchError = error;
    });

  // A shared link or a half-finished session in this tab is an explicit
  // intent, and beats anything saved on the account.
  if (resumeStep) {
    showStep(resumeStep);
    return;
  }

  // ?new=1 is the way back to a blank questionnaire for someone who is signed
  // in — linked from the dashboard as "Start a fresh search".
  const forceNew = new URLSearchParams(location.search).has('new');
  if (isSignedIn() && !forceNew) {
    startFromProfile();
    return;
  }

  debug('anonymous visitor, showing the questionnaire');
  showStep('intro');
}

/**
 * The signed-in path: read the saved profile FIRST, then decide what to show.
 *
 * This is the whole point of having an account. Someone who has already told
 * us their household, income and area should not be asked again — so nothing
 * is rendered until the profile has been fetched (or has definitively
 * failed), and what renders depends on what came back:
 *
 *   complete   -> straight to the dashboard, which matches from the profile
 *   partial    -> the wizard, prefilled, asking ONLY what is still missing
 *   empty/none -> the ordinary questionnaire
 */
async function startFromProfile() {
  const boot = $('#profile-boot');
  boot.hidden = false;

  let profile = null;
  try {
    // A hung request must not strand somebody on a loading message; falling
    // back to the questionnaire always works, it is just less convenient.
    profile = await Promise.race([
      loadProfile(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 8000)),
    ]);
    debug('profile found:', Boolean(profile));
  } catch (error) {
    debug('profile lookup failed:', error.message, '- falling back to questions');
  }
  boot.hidden = true;

  const readiness = matchReadiness(profile);
  debug('readiness:', {
    hasAnything: readiness.hasAnything,
    canMatch: readiness.canMatch,
    complete: readiness.complete,
    pct: readiness.pct,
    missingSteps: readiness.missingSteps,
  });

  if (!profile || !readiness.hasAnything) {
    debug('nothing saved yet, showing the questionnaire');
    showStep('intro');
    return;
  }

  // One source of truth: the wizard's answers are populated FROM the profile,
  // through the same adapter the dashboard uses.
  profileRow = profile;
  Object.assign(answers, profileToAnswers(profile));
  hydrateUi();

  if (readiness.complete) {
    debug('profile is complete, matching from it on the dashboard');
    location.replace('dashboard/');
    return;
  }

  // Partial: ask only the gaps.
  profileSteps = stepsSatisfiedBy(profile);
  const remaining = questionSteps();
  debug('asking only:', remaining);
  if (!remaining.length) {
    location.replace('dashboard/');
    return;
  }
  showProfileBanner(readiness, remaining.length);
  showStep(remaining[0]);
}

/**
 * Explains why the wizard opened part-way through, and offers a way past it.
 *
 * The escape matters: when the profile already has a state and county the
 * matcher can work, so somebody who needs help now is never held behind more
 * questions to get to it.
 */
function showProfileBanner(readiness, remainingCount) {
  const host = $('#main');
  const banner = el('div', { class: 'profile-banner', role: 'status' }, [
    el('p', { class: 'profile-banner__text' }, [
      el('strong', { text: 'Using your saved profile. ' }),
      remainingCount === 1
        ? 'Just one question we don’t have an answer for yet.'
        : `Just ${remainingCount} questions we don’t have answers for yet.`,
    ]),
    el('p', { class: 'profile-banner__actions' }, [
      readiness.canMatch
        ? el('a', { class: 'btn btn--ghost btn--sm', href: 'dashboard/', text: 'Skip to my results' })
        : null,
      el('a', { class: 'btn btn--ghost btn--sm', href: 'profile/', text: 'Update my profile' }),
    ]),
  ]);
  host.prepend(banner);
}

/**
 * Writes answers given during this session back to the profile, so the next
 * visit does not ask them again. Best-effort: a failure here must never
 * interrupt somebody reading their results.
 */
async function persistAnswersToProfile() {
  if (!profileRow) return;
  try {
    const patch = answersToProfile(answers);
    if (!Object.keys(patch).length) return;
    await saveProfile(patch);
    debug('saved back to the profile:', Object.keys(patch));
  } catch (error) {
    debug('could not save back to the profile:', error.message);
  }
}

init();
