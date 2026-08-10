import {
  SUPABASE_URL,
  SUPABASE_ANON_KEY,
  FORMS_BUCKET,
  COUNTIES,
  areaMedianIncomeFor,
} from './config.js';
import { screenPrograms, estimateAmiPercent } from './matcher.js';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const STEPS = ['intro', 'county', 'situation', 'household', 'income', 'circumstances', 'results'];
const QUESTION_STEPS = STEPS.filter((s) => s !== 'intro' && s !== 'results');

const answers = {
  county: null,
  situation: null,
  householdSize: 1,
  income: null, // null means "not provided"
  circumstances: {},
};

let stepIndex = 0;
let programs = null; // cached after first fetch
let fetchError = null;

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

  const select =
    'select=*,program_counties(county),eligibility(*),contacts(*),forms(*),verification(*)';
  const response = await fetch(`${SUPABASE_URL}/rest/v1/programs?${select}`, {
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Supabase returned ${response.status} ${response.statusText}`);
  }

  const rows = await response.json();
  return rows.map((row) => ({
    ...row,
    eligibility: one(row.eligibility),
    contacts: one(row.contacts),
    verification: one(row.verification),
    forms: row.forms || [],
    program_counties: row.program_counties || [],
  }));
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
  for (const county of COUNTIES) {
    const input = el('input', { type: 'radio', name: 'county', value: county });
    input.addEventListener('change', () => {
      answers.county = county;
      refreshContinueButtons();
    });
    container.append(
      el('label', { class: 'choice' }, [
        input,
        el('span', { class: 'choice__body' }, [
          el('span', { class: 'choice__title', text: county }),
        ]),
      ]),
    );
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

function updateIncomeFeedback() {
  const feedback = $('#income-feedback');
  if (answers.income == null) {
    feedback.textContent = '';
    return;
  }
  const pct = estimateAmiPercent(answers.income, answers.householdSize, areaMedianIncomeFor);
  if (pct == null) {
    feedback.textContent = '';
    return;
  }
  const rounded = Math.round(pct);
  const size = answers.householdSize;
  feedback.textContent =
    `That's roughly ${rounded}% of the median income for a household of ` +
    `${size} in this area — many programs here serve households under 60–80%.`;
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

  const matches = screenPrograms(programs, answers, areaMedianIncomeFor);
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
