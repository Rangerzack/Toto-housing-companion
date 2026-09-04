// ---------------------------------------------------------------------------
// Landing page
// ---------------------------------------------------------------------------
// The first screen anybody sees. It has to do two jobs at once: get somebody
// in a hurry into the questionnaire in one tap, and let somebody who is not
// ready for a form see that this tool actually knows something — real rentals
// on a map, real programs from four answers.
//
// It is the intro STEP of the screener, not a separate page. That matters:
//   - a shared results link (#a=...) still opens straight on the results,
//   - a signed-in person still goes to their dashboard before any of this
//     renders (app.js's startFromProfile runs first),
//   - "Get started" is the same button it always was, so the wizard, the
//     history entries and the saved session are untouched.
//
// Everything below the hero is LAZY. The map and the quick check cost nothing
// until somebody scrolls near them, because the person this site is for may
// be on a phone on a bad connection, and the hero alone is enough to act on.

import { el, $ } from './account-ui.js?v=__BUILD__';
import { isSignedIn } from './auth.js?v=__BUILD__';
import { STATES, CITY_COUNTIES, HOUSING_API_URL, HOUSING_API_HEADERS } from './config.js?v=__BUILD__';
import { fetchListings } from './housing.js?v=__BUILD__';
import { renderExplorer } from './property-map.js?v=__BUILD__';
import { renderQuickCheck, quickAnswers } from './quick-check.js?v=__BUILD__';
import { screenPrograms } from './matcher.js?v=__BUILD__';
import { fetchLimitRows, lookupLimit } from './data-api.js?v=__BUILD__';
import { strengthOf } from './quick-check.js?v=__BUILD__';

// The questionnaire steps the quick check has already answered. Named here
// rather than inline so the widget and the handoff can never drift apart.
const QUICK_CHECK_STEPS = ['state', 'county', 'household', 'income'];

/** (city, state) -> county names, or null when the town is not in the map. */
export function countiesForCity(city, state) {
  const table = CITY_COUNTIES[String(state ?? '').toUpperCase()];
  if (!table) return null;
  return table[String(city ?? '').trim().toLowerCase()] || null;
}

/**
 * Which places to load rentals for.
 *
 * The listings endpoint is per state+county, and the landing page has no
 * county yet — nobody has told us where they are. Loading all 28 would be 28
 * requests on first paint, so the map opens on the counties the project
 * actually serves first (Southern Oregon and Central Minnesota, the two
 * markets named in the README) and says so. Picking a county in the quick
 * check widens it to that county too.
 */
export const OPENING_COUNTIES = [
  { state: 'OR', county: 'Jackson' },
  { state: 'OR', county: 'Josephine' },
  { state: 'MN', county: 'Stearns' },
  { state: 'MN', county: 'Benton' },
];

/**
 * Loads listings for several counties at once.
 *
 * A county that fails is skipped rather than failing the map: a broken feed
 * for one place must not blank out the others, the same way a broken listings
 * feed never blocks program results on the results page.
 */
export async function loadOpeningListings(places = OPENING_COUNTIES, fetcher = fetchListings) {
  const settled = await Promise.allSettled(
    places.map(({ state, county }) =>
      fetcher({ url: HOUSING_API_URL, headers: HOUSING_API_HEADERS, state, county }),
    ),
  );

  const seen = new Set();
  const listings = [];
  let failures = 0;
  for (const result of settled) {
    if (result.status !== 'fulfilled') { failures++; continue; }
    for (const listing of result.value) {
      // The same building can come back from two adjacent counties.
      const key = listing.id ?? `${listing.name}|${listing.address}|${listing.city}`;
      if (seen.has(key)) continue;
      seen.add(key);
      listings.push(listing);
    }
  }
  return { listings, failures, attempted: places.length };
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

/**
 * Wires the landing page up.
 *
 * @param {object}   deps
 * @param {Function} deps.getCatalogue  async () -> {programs, proportionalStandards}
 * @param {Function} deps.startWizard   (answers|null) -> begin the questionnaire,
 *                                      prefilled with `answers` when given
 */
export function initLanding({ getCatalogue, startWizard }) {
  const root = document.querySelector('.step--intro');
  if (!root) return;

  renderNav();

  // --- Hero CTAs -----------------------------------------------------------
  $('#hero-browse')?.addEventListener('click', (event) => {
    event.preventDefault();
    document.getElementById('properties')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    // Somebody who came for the map should not have to wait for a scroll
    // observer to notice; load it the moment they ask.
    mountExplorer();
  });

  // --- Live program count in the trust section -----------------------------
  const stat = $('#trust-stat');
  if (stat) {
    getCatalogue()
      .then(({ programs }) => {
        if (!programs?.length) return;
        const counties = new Set();
        for (const program of programs) {
          for (const row of program.program_counties || []) counties.add(`${row.state_code}|${row.county}`);
        }
        stat.replaceChildren(
          el('strong', { text: String(programs.length) }),
          el('span', { text: ` housing and utility programs researched across ${counties.size} counties in Oregon and Minnesota.` }),
        );
      })
      .catch(() => {
        // The count is decoration; its absence must not leave a broken
        // sentence on the page.
        stat.hidden = true;
      });
  }

  // --- Lazy sections -------------------------------------------------------
  let explorerStarted = false;
  let quickStarted = false;

  function mountExplorer() {
    if (explorerStarted) return;
    explorerStarted = true;

    const host = $('#explorer-host');
    const note = $('#explorer-note');
    if (!host) return;
    host.replaceChildren(el('p', { class: 'explorer__loading', text: 'Loading rentals…' }));

    loadOpeningListings()
      .then(({ listings, failures, attempted }) => {
        if (!listings.length) {
          host.replaceChildren(
            el('p', { class: 'explorer__loading', text: 'No rentals are loading from the housing feed just now. The programs above are unaffected — and the questionnaire will still search rentals for your own county.' }),
          );
          return;
        }
        if (note) {
          note.textContent =
            failures && failures < attempted
              ? `Showing rentals from the areas we could reach. Some feeds did not answer just now.`
              : 'Rentals currently listed across Southern Oregon and Central Minnesota. Answer the questions to search your own county.';
          note.hidden = false;
        }
        renderExplorer({
          host,
          listings,
          countiesForCity,
          programsFor: programsForListing,
          // Only the place is settled by clicking a property. Its rent and
          // bedroom count prefill the preferences step but do NOT skip it:
          // the rent of the home they looked at is a starting point for their
          // budget, not a decision they have made about it.
          onCheckFit: (listing) => startWizard(answersForListing(listing), { satisfied: ['state', 'county'] }),
        });
      })
      .catch(() => {
        host.replaceChildren(
          el('p', { class: 'explorer__loading', text: 'The rentals map could not load. Everything else on this page still works.' }),
        );
      });
  }

  function mountQuickCheck() {
    if (quickStarted) return;
    quickStarted = true;
    const host = $('#quickcheck-host');
    if (!host) return;
    renderQuickCheck({
      host,
      getPrograms: getCatalogue,
      // The four things the widget asked are settled, so the wizard does not
      // ask them again — it opens on "what do you need help with". The
      // situation answer only PREFILLS its step rather than skipping it,
      // because "renting now" is a fact about today and "what do you need"
      // is a different question we should still put to them.
      onSeeAll: (answers) => startWizard(answers, { satisfied: QUICK_CHECK_STEPS }),
      onOpen: (row, answers) =>
        startWizard(answers, { satisfied: QUICK_CHECK_STEPS, openProgram: row.program.program_id }),
    });
  }

  // The quick check is cheap (no network until somebody presses the button),
  // so it is mounted as soon as the browser is idle rather than on scroll.
  const idle = window.requestIdleCallback || ((fn) => setTimeout(fn, 200));
  idle(mountQuickCheck);

  // The map costs a listings fetch, so it waits until it is nearly on screen.
  const explorerSection = document.getElementById('properties');
  if (explorerSection && 'IntersectionObserver' in window) {
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        observer.disconnect();
        mountExplorer();
      }
    }, { rootMargin: '300px' });
    observer.observe(explorerSection);
  } else {
    // No observer (very old browser): load it rather than leave a hole.
    idle(mountExplorer);
  }

  // --- "Check my fit" ------------------------------------------------------

  /**
   * Turns a property into questionnaire answers.
   *
   * Its rent becomes the person's maximum and its county becomes their area,
   * so the wizard opens already knowing what they were looking at. Everything
   * about THEM — household, income, situation — is still asked, because a
   * building cannot tell us any of that.
   */
  function answersForListing(listing) {
    const counties = listing.county ? [listing.county] : countiesForCity(listing.city, listing.state) || [];
    const state = String(listing.state || '').toUpperCase();
    const config = STATES.find((s) => s.code === state);
    const rows = counties.map((name) => config?.counties.find((c) => c.name === name)).filter(Boolean);

    return {
      state: config ? state : null,
      counties: rows.map((c) => c.name),
      areaIds: rows.map((c) => c.areaId),
      county: rows[0]?.name ?? null,
      areaId: rows[0]?.areaId ?? null,
      statewideAreaId: config?.statewideAreaId ?? null,
      help: ['rental'],
      situation: null,
      bedrooms: listing.bedrooms != null ? String(Math.min(4, listing.bedrooms)) : null,
      bathrooms: null,
      // The rent of the place they were just looking at is a ceiling they have
      // already accepted, so it seeds the budget.
      maxRent: listing.rent ?? null,
      householdSize: 1,
      income: null,
      incomePeriod: 'year',
      circumstances: {},
    };
  }

  /**
   * The programs that could help with THIS property's rent, in ITS county.
   *
   * Same matcher as everywhere else, run on a household we know nothing about
   * yet — which is exactly why the dialog labels it as being about the place
   * rather than about the person.
   */
  async function programsForListing(listing) {
    const answers = answersForListing(listing);
    if (!answers.county) return [];
    const { programs, proportionalStandards } = await getCatalogue();

    let limits = new Map();
    try {
      limits = await fetchLimitRows(answers.areaIds, answers.statewideAreaId);
    } catch {
      /* without limits the income tests become open questions, not exclusions */
    }
    const lookup = (standardId, tierPct, size) => lookupLimit(limits, standardId, tierPct, size);
    return screenPrograms(programs, answers, lookup, proportionalStandards)
      .map((row) => ({ ...row, label: strengthOf(row).label }));
  }
}

/**
 * Fills in the header nav.
 *
 * "My plan" only appears once there is a plan to see, and the account link is
 * the real Supabase session state — the same isSignedIn() the rest of the app
 * uses, so the header can never claim somebody is signed out when they are
 * not. Signing in stays optional everywhere: nothing on this page requires it.
 */
function renderNav() {
  const host = document.getElementById('site-nav');
  if (!host) return;

  const links = [
    el('a', { class: 'sitenav__link', href: '#top', text: 'Find programs',
      onclick: (e) => { e.preventDefault(); document.querySelector('.step--intro')?.scrollIntoView({ behavior: 'smooth' }); } }),
    el('a', { class: 'sitenav__link', href: '#properties', text: 'Browse properties' }),
    el('a', { class: 'sitenav__link', href: '#how-it-works', text: 'How it works' }),
  ];
  if (isSignedIn()) {
    links.push(el('a', { class: 'sitenav__link', href: 'dashboard/', text: 'My plan' }));
  }
  host.replaceChildren(...links);
}
