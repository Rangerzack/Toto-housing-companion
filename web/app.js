import {
  SUPABASE_URL,
  SUPABASE_ANON_KEY,
  FORMS_BUCKET,
  STATES,
} from './config.js?v=__BUILD__';
import { screenPrograms } from './matcher.js?v=__BUILD__';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const STEPS = ['intro', 'county', 'situation', 'household', 'income', 'circumstances', 'results'];
const QUESTION_STEPS = STEPS.filter((s) => s !== 'intro' && s !== 'results');

const answers = {
  county: null,
  state: null, // county names repeat across states; both are needed
  areaId: null, // income_areas row backing the chosen county
  statewideAreaId: null, // where that state's SMI limits live
  situation: null,
  householdSize: 1,
  income: null, // null means "not provided"
  circumstances: {},
};

let stepIndex = 0;
let programs = null; // cached after first fetch
let fetchError = null;

// Published income limits for the selected county plus the statewide SMI set,
// keyed `${standard}|${tier}|${size}`. Refetched when the county changes.
let limits = new Map();
let limitsAreaId = null;

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
    if (child == null || child === false) continue;
    node.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

// PostgREST returns embedded one-to-one rows as an object on some versions and
// a single-element array on others; normalize both to a plain object.
const one = (value) => (Array.isArray(value) ? value[0] || {} : value || {});

async function fetchPrograms() {
  if (SUPABASE_ANON_KEY.startsWith('PASTE_')) {
    throw new Error('MISSING_KEY');
  }

  const headers = {
    apikey: SUPABASE_ANON_KEY,
    Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
  };

  const select =
    'select=*,program_counties(county,state_code),eligibility(*),contacts(*),forms(*),verification(*)';

  // program_income_rules is fetched separately rather than embedded: it has no
  // foreign key to programs (see 0004_income_limits.sql), and PostgREST can
  // only embed across a declared relationship.
  const [response, rulesResponse] = await Promise.all([
    // is_active filters out records that document something real but are not
    // assistance anyone can apply for — discontinued funds, referral desks,
    // "shutoff protection (NOT a payment program)".
    fetch(`${SUPABASE_URL}/rest/v1/programs?${select}&is_active=eq.true`, { headers }),
    fetch(`${SUPABASE_URL}/rest/v1/program_income_rules?select=*`, { headers }),
  ]);

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
  return rows.map((row) => ({
    ...row,
    eligibility: one(row.eligibility),
    contacts: one(row.contacts),
    verification: one(row.verification),
    forms: row.forms || [],
    program_counties: row.program_counties || [],
    income_rule: rulesByProgram.get(row.program_id) || null,
  }));
}

/**
 * Loads published limits for one county plus the statewide SMI table.
 *
 * v_current_income_limits already drops expired rows and expands published
 * brackets (USDA's "1-4 person") into one row per size. Several effective dates
 * can still be current at once, so the newest wins.
 */
async function fetchLimits(areaId, statewideAreaId) {
  if (limitsAreaId === areaId) return;

  // The county's own limits plus that state's statewide SMI table — Oregon
  // programs test against Oregon's SMI, Minnesota's against Minnesota's.
  const query =
    'v_current_income_limits?select=standard_id,tier_pct,household_size,amount,effective_date' +
    `&or=(area_id.eq.${areaId},area_id.eq.${statewideAreaId})`;
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${query}`, {
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
    },
  });
  if (!response.ok) throw new Error(`Income limits: ${response.status}`);

  const newest = new Map();
  const chosen = new Map();
  for (const row of await response.json()) {
    const key = `${row.standard_id}|${Number(row.tier_pct)}|${row.household_size}`;
    if (!newest.has(key) || row.effective_date > newest.get(key)) {
      newest.set(key, row.effective_date);
      chosen.set(key, Number(row.amount));
    }
  }

  limits = chosen;
  limitsAreaId = areaId;
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

// ---------------------------------------------------------------------------
// Wizard navigation
// ---------------------------------------------------------------------------

function currentStep() {
  return STEPS[stepIndex];
}

function showStep(name) {
  stepIndex = STEPS.indexOf(name);

  $$('.step').forEach((section) => {
    section.classList.toggle('is-active', section.dataset.step === name);
  });

  const isQuestion = QUESTION_STEPS.includes(name);
  $('#progress').hidden = !isQuestion;
  $('#restart-top').hidden = name === 'intro';

  if (isQuestion) {
    const position = QUESTION_STEPS.indexOf(name) + 1;
    const pct = Math.round((position / QUESTION_STEPS.length) * 100);
    $('#progress-label').textContent = `Question ${position} of ${QUESTION_STEPS.length}`;
    $('#progress-pct').textContent = `${pct}%`;
    $('#progress-fill').style.width = `${pct}%`;
    $('#progress-bar').setAttribute('aria-valuenow', String(pct));
  }

  const section = $(`.step[data-step="${name}"]`);
  section.focus({ preventScroll: true });
  window.scrollTo({ top: 0, behavior: 'smooth' });

  if (name === 'results') renderResults();
}

function goNext() {
  const step = currentStep();
  if (step === 'circumstances') {
    showStep('results');
    return;
  }
  showStep(STEPS[stepIndex + 1]);
}

function goBack() {
  if (stepIndex > 0) showStep(STEPS[stepIndex - 1]);
}

function restart() {
  answers.county = null;
  answers.state = null;
  answers.areaId = null;
  answers.statewideAreaId = null;
  answers.situation = null;
  answers.householdSize = 1;
  answers.income = null;
  answers.circumstances = {};

  $$('input[type="radio"], input[type="checkbox"]').forEach((input) => {
    input.checked = false;
  });
  $('#household-size').value = '1';
  $('#income').value = '';
  $('#income-feedback').textContent = '';
  syncHouseholdUi();
  refreshContinueButtons();
  showStep('intro');
}

// A step's Continue button stays disabled until that step has an answer.
function refreshContinueButtons() {
  const countyBtn = $('.step[data-step="county"] [data-action="next"]');
  countyBtn.disabled = !answers.county;

  const situationBtn = $('.step[data-step="situation"] [data-action="next"]');
  situationBtn.disabled = !answers.situation;
}

// ---------------------------------------------------------------------------
// Step wiring
// ---------------------------------------------------------------------------

function buildCountyChoices() {
  const container = $('#county-choices');

  for (const state of STATES) {
    // Grouped by region, because "Douglas" appears under both and the heading
    // is what tells someone which one they want.
    if (STATES.length > 1) {
      container.append(el('h3', { class: 'choices__group', text: state.name }));
    }

    const group = el('div', { class: 'choices choices--grid' });
    for (const { name, areaId } of state.counties) {
      const input = el('input', {
        type: 'radio',
        name: 'county',
        value: `${state.code}:${name}`,
      });
      input.addEventListener('change', () => {
        answers.county = name;
        answers.state = state.code;
        answers.areaId = areaId;
        answers.statewideAreaId = state.statewideAreaId;
        refreshContinueButtons();
        // Warm the limits while they answer the next three questions, so the
        // income step can show real thresholds the moment it opens.
        fetchLimits(areaId, state.statewideAreaId).then(updateIncomeFeedback).catch(() => {});
      });
      group.append(
        el('label', { class: 'choice' }, [
          input,
          el('span', { class: 'choice__body' }, [
            el('span', { class: 'choice__title', text: name }),
          ]),
        ]),
      );
    }
    container.append(group);
  }
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
  const size = answers.householdSize;
  const at80 = limitLookup('HUD-MFI', 80, size);
  const at50 = limitLookup('HUD-MFI', 50, size);

  if (answers.income == null) {
    feedback.textContent = at80
      ? `Most housing programs in ${answers.county} County serve households of ${size} earning under ${money(at80)}.`
      : '';
    return;
  }

  if (!at80 || !at50) {
    feedback.textContent = '';
    return;
  }

  if (answers.income <= at50) {
    feedback.textContent = `That's within reach of most programs here, including those limited to ${money(at50)} for a household of ${size}.`;
  } else if (answers.income <= at80) {
    feedback.textContent = `That's under the ${money(at80)} limit most housing programs use for a household of ${size}.`;
  } else {
    feedback.textContent = `That's above the usual ${money(at80)} limit for a household of ${size}, but programs count income after deductions — you'll still see what may fit.`;
  }
}

function wireIncomeStep() {
  const input = $('#income');
  const skip = $('#income-skip');

  input.addEventListener('input', () => {
    const digits = input.value.replace(/[^\d]/g, '');
    input.value = digits ? currency.format(Number(digits)) : '';
    answers.income = digits ? Number(digits) : null;
    if (digits) skip.checked = false;
    updateIncomeFeedback();
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

function wireSituation() {
  $$('#situation-choices input[type="radio"]').forEach((input) => {
    input.addEventListener('change', () => {
      answers.situation = input.value;
      // Only relevant to buyers; hide it elsewhere to keep the list short.
      $('#ftb-choice').hidden = input.value !== 'buying';
      refreshContinueButtons();
    });
  });
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

function renderResultCard({ program, verdict, checks }) {
  const eligibility = program.eligibility || {};
  const contacts = program.contacts || {};
  const counties = (program.program_counties || [])
    .map((c) => c.county)
    .filter((c) => c !== 'Unspecified');

  const card = el('li', { class: 'result' });

  card.append(
    el('div', { class: 'result__top' }, [
      el('div', {}, [
        el('h3', { class: 'result__name', text: program.program_name }),
        program.administrator &&
          el('p', { class: 'result__admin', text: program.administrator }),
      ]),
      el('span', {
        class: `badge badge--${verdict}`,
        text: verdict === 'likely' ? '✓ Likely match' : 'Possible match',
      }),
    ]),
  );

  const tags = [program.category, counties.length ? counties.join(', ') : null].filter(Boolean);
  if (tags.length) {
    card.append(
      el(
        'div',
        { class: 'result__meta' },
        tags.map((t) => el('span', { class: 'tag', text: t })),
      ),
    );
  }

  if (eligibility.summary) {
    card.append(el('p', { class: 'result__summary', text: eligibility.summary }));
  }

  if (program.max_benefit) {
    card.append(
      el('div', { class: 'result__benefit' }, [
        el('span', { text: 'What you may get: ' }),
        el('strong', { text: program.max_benefit }),
      ]),
    );
  }

  if (checks.length) {
    card.append(
      el('div', { class: 'checks' }, [
        el('p', { class: 'checks__title', text: 'Worth checking' }),
        el(
          'ul',
          {},
          checks.map((c) => el('li', { text: c })),
        ),
      ]),
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

  if (contacts.intake_hours) {
    contactBits.push(el('span', { text: contacts.intake_hours }));
  }
  if (contactBits.length) {
    card.append(el('div', { class: 'result__contact' }, contactBits));
  }

  const actions = [];
  const formUrl = formUrlFor(program);
  if (formUrl) {
    actions.push(
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
    actions.push(
      el('a', {
        class: 'btn btn--ghost btn--sm',
        href: program.source_url,
        target: '_blank',
        rel: 'noopener noreferrer',
        text: 'Program details',
      }),
    );
  }
  if (actions.length) {
    card.append(el('div', { class: 'result__actions' }, actions));
  }

  return card;
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

function answerChips() {
  const chips = [`${answers.county} County`];

  const situationLabels = {
    renting: 'Renting',
    unhoused: 'Not stably housed',
    homeowner: 'Homeowner',
    buying: 'Hoping to buy',
  };
  chips.push(situationLabels[answers.situation]);
  chips.push(
    `${answers.householdSize} ${answers.householdSize === 1 ? 'person' : 'people'}`,
  );
  if (answers.income != null) chips.push(`$${currency.format(answers.income)}/yr`);
  else chips.push('Income not given');

  return chips;
}

async function renderResults() {
  const host = $('#results-state');
  host.replaceChildren();

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
    host.replaceChildren();
  }

  // The warm fetch on county selection usually has this ready; awaiting covers
  // a slow connection or a failed warm-up. If it still fails, every lookup
  // returns null and income limits become "worth checking" notes rather than
  // exclusions — nobody is filtered out on data we don't have.
  if (!fetchError && answers.areaId) {
    try {
      await fetchLimits(answers.areaId, answers.statewideAreaId);
    } catch {
      /* fall through with whatever limits we have */
    }
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

  const matches = screenPrograms(programs, answers, limitLookup);
  const likely = matches.filter((m) => m.verdict === 'likely').length;

  const header = el('div', { class: 'results__header' }, [
    el('h2', {
      class: 'results__count',
      text: matches.length
        ? `${matches.length} program${matches.length === 1 ? '' : 's'} may fit your situation`
        : 'No clear matches in this county',
    }),
    matches.length &&
      el('p', {
        class: 'results__summary',
        text: likely
          ? `${likely} look${likely === 1 ? 's' : ''} like a strong fit based on what you told us. Programs are listed best-match first.`
          : 'These are worth a call — each has a requirement we couldn\'t confirm from your answers.',
      }),
    el(
      'div',
      { class: 'results__chips' },
      answerChips().map((c) => el('span', { class: 'chip', text: c })),
    ),
  ]);
  host.append(header);

  if (!matches.length) {
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
    host.append(
      el(
        'ul',
        { class: 'results__list' },
        matches.map(renderResultCard),
      ),
    );
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
        onclick: () => window.print(),
      }),
      el('button', {
        type: 'button',
        class: 'btn btn--ghost',
        text: 'Start over',
        onclick: restart,
      }),
    ]),
  );
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

function init() {
  buildCountyChoices();
  wireSituation();
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

  // Enter advances, as long as the step's Continue is enabled.
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    if (event.target.matches('a, button')) return;
    const btn = $(`.step[data-step="${currentStep()}"] [data-action="next"]`);
    if (btn && !btn.disabled) {
      event.preventDefault();
      btn.click();
    }
  });

  setHouseholdSize(1);
  refreshContinueButtons();
  showStep('intro');

  // Warm the cache while the person reads the intro, so results feel instant.
  fetchPrograms()
    .then((rows) => {
      programs = rows;
    })
    .catch((error) => {
      fetchError = error;
    });
}

init();
