// ---------------------------------------------------------------------------
// Quick check — the qualification preview on the landing page
// ---------------------------------------------------------------------------
// Four questions, a few seconds, and a real answer: the programs somebody in
// this county, this size household, on this income is likely to be able to
// use. It is a preview of the questionnaire, not a replacement for it, and
// it says so — "See all matches" hands the same answers to the full flow.
//
// ONE MATCHER, NOT TWO. CLAUDE.md is explicit that there is a single matching
// path in this codebase, and this widget uses it: it builds the same
// `answers` object the wizard builds and calls the same screenPrograms() with
// the same published income limits. There is no separate scoring here, and
// nothing is invented — every label below is derived from the verdict the
// matcher returned. If the two ever disagreed, the widget would be lying to
// somebody about their housing, which is the whole reason for the rule.

import { el } from './account-ui.js?v=__BUILD__';
import { STATES } from './config.js?v=__BUILD__';
import { screenPrograms } from './matcher.js?v=__BUILD__';
import { fetchLimitRows, lookupLimit } from './data-api.js?v=__BUILD__';

// How somebody describes their situation, and what that means to the matcher.
//
// Two shapes per option, because the two jobs are genuinely different:
//
//   match — what the MATCHER is asked. `help` is a hard gate on a program's
//           category (matcher.js), so this is deliberately broad: a renter may
//           need help finding somewhere or help keeping where they are, and
//           narrowing it on a guess would hide programs from the preview. The
//           house rule is that missing information never excludes.
//   ask   — what the QUESTIONNAIRE is pre-ticked with when somebody carries
//           these answers forward. This one is deliberately narrow, because
//           the wizard describes "Staying in my home" as being behind on rent
//           or facing eviction — which "renting now" does not say about
//           anybody. Pre-ticking it would put words in their mouth on a
//           screen they are about to read.
//
// `ask` defaults to `match` where the two really are the same thing.
export const SITUATIONS = [
  {
    value: 'renting',
    label: 'Renting now',
    match: { help: ['rental', 'staying'], situation: 'renting', circumstances: {} },
    ask: { help: ['rental'], situation: 'renting', circumstances: {} },
  },
  {
    value: 'buying',
    label: 'Looking to buy',
    match: { help: ['buying'], situation: null, circumstances: { firstTimeBuyer: true } },
    // First-time buyer is a real question with its own checkbox; being in the
    // market does not answer it.
    ask: { help: ['buying'], situation: null, circumstances: {} },
  },
  {
    value: 'atrisk',
    label: 'At risk of losing my home',
    match: { help: ['staying', 'rental'], situation: 'renting', circumstances: { crisis: true } },
    ask: { help: ['staying'], situation: 'renting', circumstances: { crisis: true } },
  },
  {
    value: 'unhoused',
    label: 'I do not have housing right now',
    // Somebody with nowhere to live is in a crisis whether or not they would
    // use that word, and tenure must not narrow what they are shown.
    match: { help: ['rental'], situation: null, circumstances: { unhoused: true, crisis: true } },
  },
];

/**
 * Builds the wizard's `answers` shape from the four quick-check fields.
 *
 * Exported because it is the contract between this widget and the
 * questionnaire: "See all matches" prefills the wizard with exactly this, so
 * nothing anyone typed here is asked for a second time.
 *
 * Pass `{forHandoff: true}` for that prefill. It uses each situation's `ask`
 * shape rather than its `match` shape — see SITUATIONS above for why the two
 * differ.
 */
export function quickAnswers({ state, county, householdSize, income, situation }, { forHandoff = false } = {}) {
  const config = STATES.find((s) => s.code === state);
  const countyRow = config?.counties.find((c) => c.name === county);
  const option = SITUATIONS.find((s) => s.value === situation);
  const shape = (forHandoff ? option?.ask || option?.match : option?.match)
    || { help: ['rental'], situation: null, circumstances: {} };

  return {
    state,
    counties: countyRow ? [countyRow.name] : [],
    areaIds: countyRow ? [countyRow.areaId] : [],
    county: countyRow ? countyRow.name : null,
    areaId: countyRow ? countyRow.areaId : null,
    statewideAreaId: config?.statewideAreaId ?? null,
    help: [...shape.help],
    situation: shape.situation,
    bedrooms: null,
    bathrooms: null,
    maxRent: null,
    householdSize: Math.min(12, Math.max(1, Number(householdSize) || 1)),
    income: income == null || income === '' ? null : Number(income),
    incomePeriod: 'year',
    circumstances: { ...shape.circumstances },
  };
}

/**
 * The words on the badge, derived from what the matcher actually decided.
 *
 * "Strong fit" is not a higher score — it means the program is BUILT for this
 * household (matcher.js's `fit` array: a veterans' fund for a veteran, a
 * seniors' property for a 70-year-old) AND had no unanswered requirement.
 * "Likely match" means it fits with nothing outstanding. "Worth a call" means
 * the matcher found something it could not confirm from four questions, which
 * is exactly what a phone call is for. Nothing here is a guess at a number.
 */
export function strengthOf(row) {
  if (row.verdict === 'likely' && (row.fit?.length || 0) > 0) {
    return { key: 'strong', label: 'Strong fit' };
  }
  if (row.verdict === 'likely') return { key: 'likely', label: 'Likely match' };
  return { key: 'call', label: 'Worth a call' };
}

/**
 * The one-line "what you get" for a program, kept short enough to scan.
 *
 * Same precedence the results page uses (app.js) so a program does not
 * describe itself one way here and another way two clicks later.
 */
export function benefitLine(program) {
  const raw =
    program.benefit_summary ||
    program.max_benefit ||
    (Array.isArray(program.eligibility) ? program.eligibility[0]?.summary : program.eligibility?.summary) ||
    '';
  const text = String(raw).replace(/\s+/g, ' ').trim();
  if (!text) return 'Contact them to find out what help is available.';
  const firstSentence = text.split(/(?<=[.!?])\s/)[0];
  return firstSentence.length > 130 ? `${firstSentence.slice(0, 127).trimEnd()}…` : firstSentence;
}

/**
 * Runs the quick check.
 *
 * Returns the matcher's rows with a strength attached, best first. The caller
 * owns the programs array (already fetched and cached by the page) so the
 * widget itself never refetches the catalogue.
 */
export async function runQuickCheck({ programs, proportional = new Set(), fields }) {
  const answers = quickAnswers(fields);
  if (!answers.county) return { answers, rows: [] };

  // The published limits for this county, plus the statewide SMI set. Without
  // them the matcher still runs — income tests become "worth checking" notes
  // rather than hard limits — so a failed fetch degrades, never blocks.
  let limits = new Map();
  try {
    limits = await fetchLimitRows(answers.areaIds, answers.statewideAreaId);
  } catch {
    /* no limits: the matcher treats every income test as unconfirmed */
  }

  const lookup = (standardId, tierPct, householdSize) =>
    lookupLimit(limits, standardId, tierPct, householdSize);

  const rows = screenPrograms(programs, answers, lookup, proportional);
  return { answers, rows: rows.map((row) => ({ ...row, strength: strengthOf(row) })) };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const HOUSEHOLD_MAX = 12;

/**
 * @param {object}   opts
 * @param {Element}  opts.host
 * @param {Function} opts.getPrograms  async () -> {programs, proportionalStandards}
 * @param {Function} opts.onSeeAll     called with the answers object when
 *                                     somebody wants the full questionnaire
 * @param {Function} [opts.onOpen]     called with a match row for "See details"
 */
export function renderQuickCheck({ host, getPrograms, onSeeAll, onOpen }) {
  const fields = { state: '', county: '', householdSize: 1, income: '', situation: 'renting' };

  const countySelect = el('select', { id: 'qc-county', class: 'qc__input', required: true });
  countySelect.append(el('option', { value: '', text: 'Choose your county…' }));
  for (const state of STATES) {
    const group = el('optgroup', { label: `${state.label} — ${state.name}` });
    for (const county of state.counties) {
      group.append(el('option', { value: `${state.code}|${county.name}`, text: `${county.name} County` }));
    }
    countySelect.append(group);
  }
  countySelect.addEventListener('change', (e) => {
    const [state, county] = (e.target.value || '|').split('|');
    fields.state = state;
    fields.county = county;
    validate();
  });

  const household = el('input', {
    type: 'number', id: 'qc-household', class: 'qc__input',
    min: 1, max: HOUSEHOLD_MAX, step: 1, value: 1, inputmode: 'numeric',
  });
  household.addEventListener('input', () => {
    fields.householdSize = Math.min(HOUSEHOLD_MAX, Math.max(1, Number(household.value) || 1));
  });

  const income = el('input', {
    type: 'text', id: 'qc-income', class: 'qc__input',
    inputmode: 'numeric', autocomplete: 'off', placeholder: '30,000',
    'aria-describedby': 'qc-income-hint',
  });
  income.addEventListener('input', () => {
    const digits = income.value.replace(/[^\d]/g, '');
    income.value = digits ? Number(digits).toLocaleString('en-US') : '';
    fields.income = digits ? Number(digits) : '';
  });

  const situation = el('select', { id: 'qc-situation', class: 'qc__input' });
  for (const option of SITUATIONS) situation.append(el('option', { value: option.value, text: option.label }));
  situation.addEventListener('change', (e) => { fields.situation = e.target.value; });

  const submit = el('button', { type: 'submit', class: 'btn btn--primary qc__submit', text: 'Show my matches', disabled: true });
  const results = el('div', { class: 'qc__results', 'aria-live': 'polite' });

  function validate() {
    submit.disabled = !fields.county;
  }

  const form = el('form', { class: 'qc__form', novalidate: true }, [
    el('div', { class: 'qc__field' }, [
      el('label', { class: 'qc__label', for: 'qc-county', text: 'Your county' }),
      countySelect,
    ]),
    el('div', { class: 'qc__field qc__field--small' }, [
      el('label', { class: 'qc__label', for: 'qc-household', text: 'People in your home' }),
      household,
    ]),
    el('div', { class: 'qc__field' }, [
      el('label', { class: 'qc__label', for: 'qc-income', text: 'Household income a year' }),
      el('div', { class: 'qc__money' }, [
        el('span', { class: 'qc__prefix', 'aria-hidden': 'true', text: '$' }),
        income,
      ]),
      el('span', { class: 'qc__hint', id: 'qc-income-hint', text: 'Before taxes. A rough figure is fine — leave it blank if you are not sure.' }),
    ]),
    el('div', { class: 'qc__field' }, [
      el('label', { class: 'qc__label', for: 'qc-situation', text: 'Right now you are' }),
      situation,
    ]),
    el('div', { class: 'qc__actions' }, [submit]),
  ]);

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    submit.disabled = true;
    submit.textContent = 'Checking…';
    results.replaceChildren(el('p', { class: 'qc__loading', text: 'Looking at every program in your county…' }));

    try {
      const { programs, proportionalStandards } = await getPrograms();
      const { answers, rows } = await runQuickCheck({ programs, proportional: proportionalStandards, fields });
      // The results are described with the answers they were computed from;
      // the handoff carries the narrower prefill shape.
      renderResults(rows, answers, quickAnswers(fields, { forHandoff: true }));
    } catch {
      results.replaceChildren(
        el('p', { class: 'qc__error', text: 'We could not reach the program list just now. The full questionnaire will try again.' }),
        el('button', { type: 'button', class: 'btn btn--ghost btn--sm', text: 'Open the questionnaire', onclick: () => onSeeAll?.(quickAnswers(fields, { forHandoff: true })) }),
      );
    } finally {
      submit.disabled = false;
      submit.textContent = 'Show my matches';
    }
  });

  function renderResults(rows, answers, handoff) {
    if (!rows.length) {
      results.replaceChildren(
        el('p', { class: 'qc__empty', text: `We did not find a program in ${answers.county} County from these four answers. The full questionnaire asks more, and often finds more.` }),
        el('button', { type: 'button', class: 'btn btn--primary btn--sm', text: 'Answer the full questions', onclick: () => onSeeAll?.(handoff) }),
      );
      return;
    }

    // Five at most. Progressive disclosure is the point of a preview: the
    // best few, then the door to the rest.
    const top = rows.slice(0, 5);
    results.replaceChildren(
      el('p', { class: 'qc__count' }, [
        el('strong', { text: `${rows.length} program${rows.length === 1 ? '' : 's'}` }),
        el('span', { text: ` may fit a household of ${answers.householdSize} in ${answers.county} County.` }),
      ]),
      el('ul', { class: 'qc__list' }, top.map((row) => el('li', { class: 'qc__match' }, [
        el('span', { class: `qc__badge qc__badge--${row.strength.key}`, text: row.strength.label }),
        el('span', { class: 'qc__name', text: row.program.program_name }),
        el('span', { class: 'qc__benefit', text: benefitLine(row.program) }),
        el('button', {
          type: 'button', class: 'qc__details', text: 'See details',
          onclick: () => onOpen?.(row, handoff),
        }),
      ]))),
      el('div', { class: 'qc__after' }, [
        el('button', {
          type: 'button', class: 'btn btn--primary', text: `See all ${rows.length} matches`,
          onclick: () => onSeeAll?.(handoff),
        }),
        el('p', { class: 'qc__caveat', text: 'This is a first look from four answers. The full questions ask about your situation and usually find more.' }),
      ]),
    );
  }

  host.replaceChildren(form, results);
  return { fields, validate };
}
