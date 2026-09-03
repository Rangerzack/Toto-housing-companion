import { requireAuth, signOut, currentUser } from '../auth.js?v=__BUILD__';
import {
  completion,
  loadProfile,
  loadSaved,
  loadViewed,
  saveOpportunity,
  unsaveOpportunity,
  recordView,
  profileToAnswers,
  profileSummary,
} from '../profile.js?v=__BUILD__';
import { matchProfileToPrograms, matchProfileToListings } from '../profile-match.js?v=__BUILD__';
import { fetchProgramCatalogue, fetchLimitRows, lookupLimit } from '../data-api.js?v=__BUILD__';
import { fetchListings, bedroomsLabel } from '../housing.js?v=__BUILD__';
import { HOUSING_API_URL, HOUSING_API_HEADERS, CITY_COUNTIES } from '../config.js?v=__BUILD__';
import { $, el, renderAccountNav, setMessage } from '../account-ui.js?v=__BUILD__';

if (!requireAuth({ loginPath: '../login/' })) {
  throw new Error('redirecting to sign in');
}

const message = $('#page-message');
const resultsHost = $('#results');

renderAccountNav($('#account-nav'), {
  user: currentUser(),
  base: '../',
  onSignOut: async () => {
    await signOut();
    location.replace('../');
  },
});

let profile = null;
let limits = new Map();
let proportionalStandards = new Set();
let savedKeys = new Set();
// Programs are stored by id alone (they live in this database and can change),
// so their names are resolved from the catalogue at render time rather than
// snapshotted at save time.
let programsById = new Map();

start();

async function start() {
  try {
    profile = await loadProfile();
  } catch (error) {
    setMessage(message, error.message || 'Couldn’t load your profile.');
    return;
  }

  renderHello();

  const state = completion(profile);
  renderCompletion(state);

  // Nothing to match against yet. Say so plainly and point at the profile
  // rather than rendering an empty page that looks broken.
  if (!profile?.state || !(profile.preferred_counties || []).length) {
    resultsHost.replaceChildren(
      el('div', { class: 'empty-state' }, [
        el('p', {
          text:
            'Tell us your state and the counties that work for you, and your matches will appear here.',
        }),
        el('a', { class: 'btn btn--primary', href: '../profile/', text: 'Fill in your profile' }),
      ]),
    );
    return;
  }

  resultsHost.replaceChildren(
    el('p', { class: 'dash-sub', text: 'Working out what fits you…' }),
  );

  await Promise.all([renderMatches(), primeSaved()]);
  renderFooterActions();
}

function renderHello() {
  const name = profile?.first_name;
  $('#hello').textContent = name ? `Welcome back, ${name}` : 'Welcome back';

  // Say plainly what these results were matched against, so nobody has to
  // guess which answers produced them — and give them one click to change it.
  const summary = profileSummary(profile);
  const sub = $('#hello-sub');
  sub.replaceChildren();
  if (summary) {
    sub.append(
      el('span', { class: 'dash-basis' }, [
        el('strong', { text: 'Searching based on your profile: ' }),
        summary,
      ]),
      el('a', { class: 'dash-basis__edit', href: '../profile/', text: 'Update my profile' }),
    );
  } else {
    sub.textContent =
      'Programs and places matched against what you told us. Every match says why it’s here.';
  }
}

function renderCompletion(state) {
  $('#completion').replaceChildren(
    el('div', { class: 'completion__top' }, [
      el('span', { class: 'completion__label', text: 'Profile completion' }),
      el('span', { class: 'completion__pct', text: `${state.pct}%` }),
    ]),
    el(
      'div',
      {
        class: 'progress__track',
        role: 'progressbar',
        'aria-valuenow': String(state.pct),
        'aria-valuemin': '0',
        'aria-valuemax': '100',
        'aria-label': 'Profile completion',
      },
      [el('div', { class: 'progress__fill', style: `width: ${state.pct}%` })],
    ),
    el('p', { class: 'completion__missing' }, [
      state.incomplete.length
        ? `Adding ${state.incomplete.map((s) => s.title).join(', ')} would sharpen these matches. `
        : 'Your profile is complete. ',
      el('a', { href: '../profile/', text: state.incomplete.length ? 'Complete your profile' : 'Edit your profile' }),
    ]),
  );
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

async function renderMatches() {
  const answers = profileToAnswers(profile);
  let catalogue;
  try {
    catalogue = await fetchProgramCatalogue();
    proportionalStandards = catalogue.proportionalStandards;
    programsById = new Map(catalogue.programs.map((p) => [p.program_id, p]));
  } catch (error) {
    resultsHost.replaceChildren(
      el('div', { class: 'empty-state' }, [
        el('p', {
          text:
            error.message === 'MISSING_KEY'
              ? 'The connection to the programs database isn’t configured yet.'
              : 'Couldn’t load the programs just now. Check your connection and reload.',
        }),
      ]),
    );
    return;
  }

  try {
    limits = await fetchLimitRows(answers.areaIds, answers.statewideAreaId);
  } catch {
    // No limits means income tests become "worth checking" notes rather than
    // exclusions — nobody is filtered out on data we failed to load.
  }

  const lookup = (standardId, tier, size) => lookupLimit(limits, standardId, tier, size);
  const matches = matchProfileToPrograms(profile, catalogue.programs, lookup, proportionalStandards);

  // Housing help and everything else are different errands, so they get
  // different sections — same split the screener makes.
  const housing = matches.filter((m) => isHousing(m.program.category));
  const other = matches.filter((m) => !isHousing(m.program.category));

  resultsHost.replaceChildren();

  // Live rentals, for someone who is actually looking for a place.
  if (answers.help.includes('rental')) {
    const rentalsSection = el('section', { class: 'dash-section' });
    resultsHost.append(rentalsSection);
    renderRentals(rentalsSection).catch(() => {});
  }

  resultsHost.append(
    section({
      title: 'Recommended housing help',
      hint: housing.length
        ? 'Rent help, repairs, and homebuying programs you may qualify for.'
        : null,
      items: housing,
      empty: 'No housing programs matched yet. Adding more to your profile usually turns up more.',
    }),
    section({
      title: 'Recommended support programs',
      hint: other.length ? 'Utility bills and other help in your area.' : null,
      items: other,
      empty: 'No other support programs matched yet.',
    }),
  );

  // Placeholders appended in order now, filled in below — otherwise these
  // async sections land after the footer buttons.
  resultsHost.append(
    el('section', { class: 'dash-section', id: 'saved-section' }),
    el('section', { class: 'dash-section', id: 'viewed-section' }),
  );
  await Promise.all([renderSaved(), renderViewed()]);
}

/** A saved or viewed row's display name, resolved live for programs. */
function rowTitle(row) {
  if (row.kind === 'program') {
    return programsById.get(row.program_id)?.program_name || row.program_id;
  }
  return row.snapshot?.name || row.listing_id;
}

const HOUSING_PATTERN =
  /rent|housing|shelter|homeless|stabili|down payment|homebuyer|home ?ownership|home repair|mortgage|rehabilitation/i;
const isHousing = (category) => HOUSING_PATTERN.test(category || '');

function section({ title, hint, items, empty }) {
  const node = el('section', { class: 'dash-section' }, [
    el('div', { class: 'dash-section__head' }, [
      el('h2', { class: 'dash-section__title', text: `${title}${items.length ? ` (${items.length})` : ''}` }),
    ]),
    hint ? el('p', { class: 'dash-section__hint', text: hint }) : null,
  ]);

  if (!items.length) {
    node.append(el('div', { class: 'empty-state' }, [el('p', { text: empty })]));
    return node;
  }

  const VISIBLE = 4;
  const list = el('ul', { class: 'results__list' }, items.slice(0, VISIBLE).map(programCard));
  node.append(list);

  const rest = items.slice(VISIBLE);
  if (rest.length) {
    const more = el('button', {
      type: 'button',
      class: 'btn btn--ghost btn--sm results__more',
      text: `Show ${rest.length} more`,
      onclick: () => {
        rest.forEach((item) => list.append(programCard(item)));
        more.remove();
      },
    });
    node.append(more);
  }
  return node;
}

// ---------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------

const BADGE = {
  strong: { class: 'badge badge--likely', label: '✓ Strong match' },
  possible: { class: 'badge badge--possible', label: 'Possible match' },
  none: { class: 'badge', label: 'Not a match' },
};

/** The "why" list: met, then open questions, then anything that failed. */
function whyList(match, { limit = 3 } = {}) {
  const rows = [
    ...match.matchedCriteria.map((text) => ({ text, kind: 'is-met' })),
    ...match.missingCriteria.map((text) => ({ text, kind: 'is-open' })),
    ...match.failedCriteria.map((text) => ({ text, kind: 'is-failed' })),
  ];
  const shown = limit ? rows.slice(0, limit) : rows;
  const list = el(
    'ul',
    { class: 'match-why' },
    shown.map((row) => el('li', { class: row.kind, text: row.text })),
  );
  if (limit && rows.length > shown.length) {
    list.append(
      el('li', { class: 'is-open', text: `${rows.length - shown.length} more to check — open for details` }),
    );
  }
  return list;
}

function programCard({ program, match }) {
  const badge = BADGE[match.matchType];
  const key = `program:${program.program_id}`;

  const card = el('li', { class: 'result result--program' }, [
    el('div', { class: 'result__head' }, [
      el('div', { class: 'result__headmain' }, [
        el('h3', { class: 'result__name', text: program.program_name }),
        program.administrator
          ? el('p', { class: 'result__admin', text: program.administrator })
          : null,
      ]),
      el('div', { class: 'result__headside' }, [
        el('span', { class: badge.class, text: badge.label }),
        el('span', { class: 'match-score', text: `${match.score}/100` }),
      ]),
    ]),
    program.benefit_summary || program.max_benefit
      ? el('p', { class: 'result__summary', text: program.benefit_summary || program.max_benefit })
      : null,
    whyList(match),
    el('div', { class: 'result__cardactions' }, [
      saveButton(key, { kind: 'program', id: program.program_id }),
      el('button', {
        type: 'button',
        class: 'btn btn--ghost btn--sm',
        text: 'See details',
        onclick: () => openProgram(program, match),
      }),
    ]),
  ]);
  return card;
}

function saveButton(key, ref) {
  const button = el('button', {
    type: 'button',
    class: 'btn btn--ghost btn--sm',
    text: savedKeys.has(key) ? 'Saved ✓' : '+ Save',
    'aria-pressed': savedKeys.has(key) ? 'true' : 'false',
    onclick: async () => {
      const wasSaved = savedKeys.has(key);
      // Optimistic: the button responds immediately and reverts if the write
      // fails, because a save that feels slow gets clicked twice.
      savedKeys[wasSaved ? 'delete' : 'add'](key);
      paint();
      const ok = wasSaved ? await unsaveOpportunity(ref) : await saveOpportunity(ref);
      if (!ok) {
        savedKeys[wasSaved ? 'add' : 'delete'](key);
        paint();
        setMessage(message, 'Couldn’t update your saved list. Please try again.');
        return;
      }
      renderSaved();
    },
  });
  function paint() {
    button.textContent = savedKeys.has(key) ? 'Saved ✓' : '+ Save';
    button.setAttribute('aria-pressed', savedKeys.has(key) ? 'true' : 'false');
  }
  return button;
}

// ---------------------------------------------------------------------------
// Rentals
// ---------------------------------------------------------------------------

function countiesForCity(city, stateCode) {
  const map = CITY_COUNTIES[stateCode];
  if (!map || !city) return null;
  return map[String(city).toLowerCase().trim()] || null;
}

async function renderRentals(host) {
  const answers = profileToAnswers(profile);
  host.replaceChildren(
    el('div', { class: 'dash-section__head' }, [
      el('h2', { class: 'dash-section__title', text: 'Places to rent' }),
    ]),
    el('p', { class: 'dash-section__hint', text: 'Loading current listings…' }),
  );

  let listings = [];
  try {
    listings = await fetchListings({
      url: HOUSING_API_URL,
      headers: HOUSING_API_HEADERS,
      state: answers.state,
      county: answers.county,
    });
  } catch (error) {
    // A broken listings feed is a note, never a blocker — the program matches
    // below are the more important half of this page.
    host.replaceChildren(
      el('div', { class: 'dash-section__head' }, [
        el('h2', { class: 'dash-section__title', text: 'Places to rent' }),
      ]),
      el('div', { class: 'listings-note' }, [
        el('span', {
          text:
            error.message === 'MISSING_HOUSING_API'
              ? 'The rental listings source isn’t configured yet.'
              : 'Couldn’t load rental listings just now.',
        }),
      ]),
    );
    return;
  }

  const matches = matchProfileToListings(profile, listings, countiesForCity);
  host.replaceChildren(
    el('div', { class: 'dash-section__head' }, [
      el('h2', { class: 'dash-section__title', text: `Places to rent (${matches.length})` }),
    ]),
    el('p', {
      class: 'dash-section__hint',
      text: 'Cheapest first. Availability changes fast — call before visiting.',
    }),
  );

  if (!matches.length) {
    host.append(
      el('div', { class: 'listings-note' }, [
        el('span', {
          text: 'No current listings matched your search. Widening your counties or rent usually helps.',
        }),
      ]),
    );
    return;
  }

  const VISIBLE = 4;
  const list = el('ul', { class: 'results__list' }, matches.slice(0, VISIBLE).map(listingCard));
  host.append(list);
  const rest = matches.slice(VISIBLE);
  if (rest.length) {
    const more = el('button', {
      type: 'button',
      class: 'btn btn--ghost btn--sm results__more',
      text: `Show ${rest.length} more`,
      onclick: () => {
        rest.forEach((item) => list.append(listingCard(item)));
        more.remove();
      },
    });
    host.append(more);
  }
}

function listingCard({ listing, match }) {
  const key = `listing:${listing.id}`;
  const rent = listing.rent == null ? 'Rent not listed' : `$${Number(listing.rent).toLocaleString('en-US')}`;
  return el('li', { class: 'result result--program' }, [
    el('div', { class: 'result__head' }, [
      el('div', { class: 'result__headmain' }, [
        el('h3', { class: 'result__name', text: listing.name || 'Rental listing' }),
        el('p', {
          class: 'result__admin',
          text: [listing.address, listing.city].filter(Boolean).join(', ') || listing.city || '',
        }),
      ]),
      el('div', { class: 'result__headside' }, [
        el('span', { class: 'result__rent', text: rent }),
      ]),
    ]),
    el('p', {
      class: 'result__summary',
      text: [bedroomsLabel(listing.bedrooms), listing.bathrooms ? `${listing.bathrooms} bath` : null]
        .filter(Boolean)
        .join(' · '),
    }),
    whyList(match, { limit: 2 }),
    el('div', { class: 'result__cardactions' }, [
      saveButton(key, {
        kind: 'listing',
        id: listing.id,
        // Listings vanish from the feed, so keep enough to render the card later.
        snapshot: {
          name: listing.name,
          city: listing.city,
          rent: listing.rent,
          bedrooms: listing.bedrooms,
          url: listing.url || null,
        },
      }),
      listing.url
        ? el('a', {
            class: 'btn btn--primary btn--sm',
            href: listing.url,
            target: '_blank',
            rel: 'noopener noreferrer',
            text: 'View listing',
            onclick: () =>
              recordView({ kind: 'listing', id: listing.id, snapshot: { name: listing.name, rent: listing.rent } }),
          })
        : null,
    ]),
  ]);
}

// ---------------------------------------------------------------------------
// Program detail
// ---------------------------------------------------------------------------

function openProgram(program, match) {
  const dialog = $('#program-dialog');
  const contact = program.contacts || {};

  dialog.replaceChildren(
    el('div', { class: 'pdialog__top' }, [
      el('h2', { class: 'result__name', id: 'pdialog-title', text: program.program_name }),
      el('button', {
        type: 'button',
        class: 'pdialog__close',
        'aria-label': 'Close',
        text: '×',
        onclick: () => dialog.close(),
      }),
    ]),
    el('p', { class: 'result__summary', text: match.explanation }),
    el('h3', { class: 'checks__title', text: 'Why this is here' }),
    whyList(match, { limit: 0 }),
    program.benefit_summary
      ? el('p', { class: 'result__summary', text: program.benefit_summary })
      : null,
    contact.phone || contact.website || program.source_url
      ? el('p', { class: 'result__contact' }, [
          contact.phone ? el('a', { href: `tel:${contact.phone}`, text: contact.phone }) : null,
          contact.phone && (contact.website || program.source_url) ? ' · ' : null,
          contact.website || program.source_url
            ? el('a', {
                href: contact.website || program.source_url,
                target: '_blank',
                rel: 'noopener noreferrer',
                text: 'Program website',
              })
            : null,
        ])
      : null,
  );

  dialog.showModal();
  recordView({ kind: 'program', id: program.program_id });
}

// ---------------------------------------------------------------------------
// Saved / recently viewed
// ---------------------------------------------------------------------------

async function primeSaved() {
  const rows = await loadSaved();
  savedKeys = new Set(
    rows.map((row) => `${row.kind}:${row.kind === 'program' ? row.program_id : row.listing_id}`),
  );
}

async function renderSaved() {
  const rows = await loadSaved();
  savedKeys = new Set(
    rows.map((row) => `${row.kind}:${row.kind === 'program' ? row.program_id : row.listing_id}`),
  );

  const existing = $('#saved-section');
  const node = el('section', { class: 'dash-section', id: 'saved-section' }, [
    el('div', { class: 'dash-section__head' }, [
      el('h2', { class: 'dash-section__title', text: `Saved (${rows.length})` }),
    ]),
    rows.length
      ? el(
          'ul',
          { class: 'results__list' },
          rows.map((row) =>
            el('li', { class: 'result result--program' }, [
              el('h3', { class: 'result__name', text: rowTitle(row) }),
              el('p', {
                class: 'result__admin',
                text: row.kind === 'listing' ? 'Rental listing' : 'Program',
              }),
              el('div', { class: 'result__cardactions' }, [
                el('button', {
                  type: 'button',
                  class: 'btn btn--ghost btn--sm',
                  text: 'Remove',
                  onclick: async () => {
                    await unsaveOpportunity({
                      kind: row.kind,
                      id: row.kind === 'program' ? row.program_id : row.listing_id,
                    });
                    renderSaved();
                  },
                }),
              ]),
            ]),
          ),
        )
      : el('div', { class: 'empty-state' }, [
          el('p', { text: 'Nothing saved yet. Use “+ Save” on anything you want to come back to.' }),
        ]),
  ]);

  if (existing) existing.replaceWith(node);
  else resultsHost.append(node);
}

async function renderViewed() {
  const rows = await loadViewed(6);
  const existing = $('#viewed-section');
  // Nothing viewed yet is not worth a heading and an empty box; drop the
  // placeholder rather than leaving a stub on the page.
  if (!rows.length) {
    existing?.remove();
    return;
  }
  const node = el('section', { class: 'dash-section', id: 'viewed-section' }, [
    el('div', { class: 'dash-section__head' }, [
      el('h2', { class: 'dash-section__title', text: 'Recently viewed' }),
    ]),
    el(
      'ul',
      { class: 'results__list' },
      rows.map((row) =>
        el('li', { class: 'result result--program' }, [
          el('h3', { class: 'result__name', text: rowTitle(row) }),
          el('p', { class: 'result__admin', text: row.kind === 'listing' ? 'Rental listing' : 'Program' }),
        ]),
      ),
    ),
  ]);
  if (existing) existing.replaceWith(node);
  else resultsHost.append(node);
}

function renderFooterActions() {
  resultsHost.append(
    el('div', { class: 'account-actions' }, [
      el('a', { class: 'btn btn--ghost', href: '../profile/', text: 'Edit your profile' }),
      // ?new=1, or landing on the screener would just bounce back here.
      el('a', { class: 'btn btn--ghost', href: '../?new=1', text: 'Start a fresh search' }),
    ]),
  );
}
