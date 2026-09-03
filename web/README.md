# Toto Housing Companion — screener frontend

A guided five-question screener that matches someone to housing, utility, and
homebuying programs from the Supabase database in this repo.

No build step, no dependencies, no framework — plain ES modules, so you can
edit a file and refresh the page.

## Running it

1. Add your Supabase **anon public** key to `config.js`:

   ```js
   export const SUPABASE_ANON_KEY = 'eyJhbGci...';
   ```

   Find it at Supabase dashboard → Project Settings → API → "anon public".
   This key is safe to commit and ship in frontend code: it only permits the
   public `SELECT` access granted by
   `supabase/migrations/0002_rls_public_read.sql`.

2. Serve the folder over http (ES modules won't load over `file://`):

   ```bash
   powershell -ExecutionPolicy Bypass -File web/serve.ps1
   ```

3. Open <http://localhost:8777>.

## Files

| File            | What it does                                                     |
| --------------- | ---------------------------------------------------------------- |
| `index.html`    | Markup for every wizard step and the results view                 |
| `styles.css`    | Design system — light/dark, responsive, print styles              |
| `app.js`        | Wizard navigation, results rendering                              |
| `matcher.js`    | Eligibility matching engine (no DOM — testable on its own)        |
| `housing.js`    | Rental-listing search: fetch, normalize, filter (no DOM)          |
| `data-api.js`   | Reads the program catalogue and income limits (shared, no DOM)    |
| `config.js`     | Connection settings, county list, housing API + city→county map   |
| `serve.ps1`     | Dependency-free local static server                               |

Accounts are optional and live in their own files, so the screener works
untouched with all of them deleted:

| File                | What it does                                                 |
| ------------------- | ------------------------------------------------------------ |
| `auth.js`           | Supabase Auth over REST: sign up/in/out, reset, sessions      |
| `profile.js`        | Profile schema, load/save, completion, profile↔answers adapter |
| `profile-match.js`  | Structured, explainable match results (no DOM)                |
| `account-ui.js`     | Shared form controls, generated from the profile schema        |
| `account.css`       | Layouts the screener didn't need (form card, sections, grid)   |
| `login/`, `signup/`, `forgot-password/` | The three auth pages                   |
| `profile/`          | Sectioned profile form with a completion meter                 |
| `dashboard/`        | Matches, saved items, recently viewed                          |

## How matching works

The source matrix stores eligibility as free-text prose written by
researchers, not as structured flags. `"None (priority only: age 60+)"` means
there is **no** age requirement; `"Not specified in program materials
reviewed"` means nobody could confirm one either way. Keyword-matching those
strings would read both as restrictions and wrongly turn people away.

So `matcher.js` only hard-excludes on fields it can trust:

- **county** — a real relational table
- **ami_min / ami_max** — real numbers
- **eligible_tenure** — small, semi-structured vocabulary

Every prose rule is a soft signal. A program is excluded on one only when the
text affirmatively states a requirement the person doesn't meet. When a rule
is ambiguous the program stays in the results with a plain-language "worth
checking" note, because a false exclusion costs someone housing help while a
false inclusion costs them a phone call.

Two details worth knowing:

- Being unhoused automatically satisfies a program's displacement requirement.
  Someone already homeless won't tick a box about *becoming* displaced, but
  programs whose rules say "already experiencing homelessness" are meant for
  them.
- Income limits get a 10% grace band. The AMI table is an estimate and real
  HUD limits vary by county, so someone just over the line still sees the
  program, flagged rather than dropped.

## The rental listings section

When "Finding a rental" is among the needs, the results page opens with an
**Available rentals** section — actual listings from Range Lab's Housing Data
API (`GET https://basecamp.rangelab.io/api/v1/properties`), narrowed to the
chosen county and bedroom count (a bedrooms question appears for this need),
sorted cheapest first, each flagged against the 30%-of-income guideline when
an income was given. Listings with photos show them; the house icon is the
placeholder.

The API's key is private, so the browser never calls it directly — it calls
the `housing-search` Supabase edge function
(`supabase/functions/housing-search/`), which holds the endpoint and key as
function secrets and follows the API's pagination (up to 500 rows). Setup,
once:

1. Deploy the function: the *Deploy Supabase edge functions* workflow (needs
   a `SUPABASE_ACCESS_TOKEN` repo secret), or locally
   `supabase functions deploy housing-search --project-ref vhhcicawkhokncnhzboe --no-verify-jwt`.
2. Set the function secrets (Supabase dashboard → Edge Functions → Secrets):
   `HOUSING_API_URL='https://basecamp.rangelab.io/api/v1/properties?state={state}&limit=100'`
   and `HOUSING_API_KEY` (the `rl_live_…` key). The key travels in an
   `X-Api-Key` header by default; `HOUSING_API_KEY_HEADER` overrides.

The API filters by city and its records carry no county, so county narrowing
happens client-side through the `CITY_COUNTIES` map in `config.js` — a city
missing from the map is shown rather than hidden; extend it as unmapped towns
appear. `housing.js` unwraps common response envelopes and field-name
variants via `FIELD_ALIASES`, and a broken listings feed degrades to a small
inline note — it never takes the program results down with it.

## Accounts

Optional throughout. Nobody has to sign in to use the screener, nothing is
saved without an account, and every account page links back to the anonymous
tool. The intro's privacy line says exactly this, and it has to stay true.

**Pages:** `/login/`, `/signup/`, `/forgot-password/` (which also handles the
"set a new password" step when someone follows the emailed link), `/profile/`,
`/dashboard/`.

**Where the security actually is.** Row-level security in
`supabase/migrations/0016_user_accounts.sql`, not the JavaScript. Every policy
on `profiles`, `saved_opportunities` and `viewed_opportunities` is scoped to
`auth.uid()`, so a request without a valid JWT reads nothing and a signed-in
person reads only their own row. The `requireAuth()` redirect on the profile
and dashboard pages is a courtesy for the person, not the boundary — deleting
it from the JavaScript gets you an empty page, not someone else's data.

**Auth is spoken directly** to Supabase's REST API in `auth.js` rather than via
the supabase-js bundle, to keep the site dependency-free. That means this app
owns session storage and token refresh; passwords go straight to Supabase over
TLS and never touch our code. The session lives in `localStorage` so signing in
survives a closed tab, which is why nothing in these pages ever renders
user-supplied text with `innerHTML`.

**One Supabase setting is required** before password resets work: add the
deployed `/forgot-password/` URL to **Authentication → URL Configuration →
Redirect URLs**, for both the production and `/staging/` paths. Without it the
emailed link lands on the site root with no token. Whether new accounts must
confirm their email is up to the project's **Confirm email** setting; the
signup page handles both.

**A signed-in visit never re-asks what the profile knows.** `init()` in
`app.js` hands off to `startFromProfile()` whenever someone is signed in: it
fetches the profile first (behind a short loading state, so the questionnaire
cannot flash up and then vanish), then branches on `matchReadiness()` —
complete profiles redirect to `/dashboard/`, partial ones open the wizard with
`stepsSatisfiedBy()` marking the answered steps so `questionSteps()` skips
them, and anything answered on the way is written back to the profile. Escape
hatches: `?new=1` for a deliberately blank questionnaire (the dashboard's
"Start a fresh search" uses it), and editing a chip on the results page turns
that question back into a live one.

**Matching a profile** reuses the screener's engine rather than duplicating it:
`profileToAnswers()` turns a profile row into the same `answers` object the
wizard builds, and `profile-match.js` wraps `evaluateProgram()` to return
`{matchType, score, matchedCriteria, missingCriteria, failedCriteria,
explanation}`. If the dashboard and the screener ever disagree about a program,
that is a bug in the adapter, not a second opinion.

## Before this goes in front of real people

- **Replace the AMI table in `config.js`.** The values are estimates derived by
  doubling the Jackson County 50%-AMI limits, the only dollar figures in the
  source matrix. Real HUD limits are not perfectly linear and differ by county.
  Official tables: <https://www.huduser.gov/portal/datasets/il.html>
- **Upload the intake forms.** Results link to a program's own site today. Once
  files are in the `intake-forms` bucket and `forms.storage_path` is filled in,
  the "Get the application form" button serves them directly.
- **Have someone who does this work review the copy**, especially the wording
  of the housing-situation options.
