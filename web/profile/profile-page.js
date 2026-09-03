import { requireAuth, signOut, currentUser } from '../auth.js?v=__BUILD__';
import {
  SECTIONS,
  completion,
  loadProfile,
  saveProfile,
  answersToProfile,
} from '../profile.js?v=__BUILD__';
import { $, el, renderField, renderAccountNav, setMessage, busy } from '../account-ui.js?v=__BUILD__';

// The redirect is a courtesy, not the security boundary — RLS is. See the note
// on requireAuth in auth.js.
if (!requireAuth({ loginPath: '../login/' })) {
  // Stop the module here while the browser navigates away.
  throw new Error('redirecting to sign in');
}

const ANSWERS_KEY = 'toto-answers';

const accountNav = $('#account-nav');
const message = $('#page-message');
const sectionsHost = $('#sections');
const completionHost = $('#completion');

renderAccountNav(accountNav, {
  user: currentUser(),
  base: '../',
  onSignOut: async () => {
    await signOut();
    location.replace('../');
  },
});

// `values` is the working copy every field writes into; `saved` is what the
// database last confirmed. The difference is what "unsaved" means.
let values = {};
let saved = {};
const repaintCounties = [];

start();

async function start() {
  try {
    const profile = await loadProfile();
    saved = profile || {};
    values = { ...saved };
  } catch (error) {
    setMessage(message, error.message || 'Couldn’t load your profile.');
    return;
  }

  render();
  offerScreenerImport();

  if (new URLSearchParams(location.search).get('welcome')) {
    setMessage(
      message,
      'Your account is ready. Fill in as much as you can — you can always come back and add more.',
      'good',
    );
  }
}

function isDirty() {
  return SECTIONS.some((section) => sectionDirty(section));
}

function sectionDirty(section) {
  return section.fields.some((field) => {
    const a = values[field.name];
    const b = saved[field.name];
    return JSON.stringify(a ?? null) !== JSON.stringify(b ?? null);
  });
}

// A long form on a phone is exactly where an accidental back-swipe hurts most.
window.addEventListener('beforeunload', (event) => {
  if (!isDirty()) return;
  event.preventDefault();
  // Browsers show their own wording; a non-empty returnValue is what triggers it.
  event.returnValue = '';
});

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function render() {
  renderCompletion();
  sectionsHost.replaceChildren();
  repaintCounties.length = 0;

  const state = completion(values);
  for (const section of SECTIONS) {
    const status = state.sections.find((s) => s.id === section.id);
    sectionsHost.append(renderSection(section, status));
  }
}

function renderCompletion() {
  const state = completion(values);
  completionHost.replaceChildren(
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
    state.incomplete.length
      ? el('p', { class: 'completion__missing' }, [
          'Still to fill in: ',
          ...state.incomplete.flatMap((section, index) => [
            index ? ', ' : '',
            el('a', {
              href: `#section-${section.id}`,
              text: section.title,
              onclick: (event) => {
                event.preventDefault();
                openSection(section.id);
              },
            }),
          ]),
          '.',
        ])
      : el('p', { class: 'completion__missing', text: 'Everything’s filled in. You can still change any of it whenever you like.' }),
  );
}

function renderSection(section, status) {
  const body = el('div', { class: 'psection__body' });
  const feedback = el('span', { class: 'feedback', role: 'status' });

  body.append(el('p', { class: 'psection__blurb', text: section.blurb }));

  const grid = el('div', { class: 'field-grid' });
  for (const field of section.fields) {
    grid.append(
      renderField(field, values, {
        // The county list depends on which state is chosen, so it repaints
        // when the state field changes.
        onStateChange: (repaint) => repaintCounties.push(repaint),
      }),
    );
  }
  body.append(grid);

  const saveButton = el('button', {
    type: 'button',
    class: 'btn btn--primary',
    text: 'Save this section',
    onclick: () => saveSection(section, saveButton, feedback),
  });
  body.append(el('div', { class: 'psection__save' }, [saveButton, feedback]));

  const details = el('details', { class: 'psection', id: `section-${section.id}` }, [
    el('summary', { class: 'psection__head' }, [
      el('span', { class: 'psection__title', text: section.title }),
      el('span', {
        class: `psection__status${status.complete ? ' psection__status--done' : ''}`,
        text: status.optional
          ? 'Optional'
          : status.complete
            ? 'Done'
            : `${status.done} of ${status.total}`,
      }),
      el('span', { class: 'psection__chev', 'aria-hidden': 'true', text: '▾' }),
    ]),
    body,
  ]);

  // Open the first section that still wants something, so someone landing here
  // has an obvious place to start.
  if (!status.complete && !status.optional && !sectionsHost.querySelector('details[open]')) {
    details.open = true;
  }

  // The state field lives in this section and drives the county list.
  details.addEventListener('change', (event) => {
    if (event.target.name === 'state') {
      // A new state invalidates any counties chosen under the old one.
      values.preferred_counties = null;
      for (const repaint of repaintCounties) repaint();
    }
  });

  return details;
}

function openSection(id) {
  const details = $(`#section-${id}`);
  if (!details) return;
  details.open = true;
  details.scrollIntoView({ behavior: 'smooth', block: 'start' });
  details.querySelector('input, select, button')?.focus({ preventScroll: true });
}

// ---------------------------------------------------------------------------
// Saving
// ---------------------------------------------------------------------------

async function saveSection(section, button, feedback) {
  const patch = {};
  for (const field of section.fields) {
    patch[field.name] = values[field.name] ?? null;
  }

  // Mark the whole profile finished once every counted field is answered, so
  // the dashboard can say so without recomputing on the server.
  const state = completion(values);
  patch.profile_completed = state.complete;

  const done = busy(button, 'Saving…');
  feedback.textContent = '';
  try {
    await saveProfile(patch);
    saved = { ...saved, ...patch };
    done();
    feedback.textContent = 'Saved.';
    feedback.className = 'feedback feedback--good';
    // The meter and the section badges both move, so repaint them — but not
    // the fields themselves, which would blow away focus mid-form.
    renderCompletion();
    refreshBadges();
    setTimeout(() => {
      feedback.textContent = '';
    }, 4000);
  } catch (error) {
    done();
    feedback.textContent = error.message;
    feedback.className = 'feedback feedback--over';
  }
}

function refreshBadges() {
  const state = completion(values);
  for (const status of state.sections) {
    const badge = $(`#section-${status.id} .psection__status`);
    if (!badge) continue;
    badge.textContent = status.optional
      ? 'Optional'
      : status.complete
        ? 'Done'
        : `${status.done} of ${status.total}`;
    badge.classList.toggle('psection__status--done', status.complete && !status.optional);
  }
}

// ---------------------------------------------------------------------------
// Bringing in what they already answered in the screener
// ---------------------------------------------------------------------------

/**
 * Someone who just used the screener anonymously and then made an account has
 * already answered half of this. Offering to carry it over beats making them
 * type it twice — but it is an offer, never automatic, because it would
 * otherwise silently overwrite a profile they had filled in by hand.
 */
function offerScreenerImport() {
  let answers = null;
  try {
    answers = JSON.parse(sessionStorage.getItem(ANSWERS_KEY) || 'null')?.answers || null;
  } catch {
    return;
  }
  if (!answers) return;

  const patch = answersToProfile(answers);
  // Only offer fields that would actually change something.
  const useful = Object.entries(patch).filter(
    ([key, value]) => JSON.stringify(value) !== JSON.stringify(values[key] ?? null),
  );
  if (!useful.length) return;

  const banner = el('div', { class: 'form-message form-message--good', role: 'status' }, [
    el('span', {
      text: `You answered ${useful.length} of these in the screener just now. Bring those answers in?`,
    }),
    el('span', { text: ' ' }),
    el('button', {
      type: 'button',
      class: 'btn btn--ghost btn--sm',
      text: 'Use them',
      onclick: async (event) => {
        const done = busy(event.target, 'Bringing them in…');
        for (const [key, value] of useful) values[key] = value;
        try {
          await saveProfile(Object.fromEntries(useful));
          saved = { ...saved, ...Object.fromEntries(useful) };
          banner.remove();
          render();
          setMessage(message, 'Brought in your screener answers. Check them over below.', 'good');
        } catch (error) {
          done();
          setMessage(message, error.message);
        }
      },
    }),
  ]);

  completionHost.after(banner);
}
