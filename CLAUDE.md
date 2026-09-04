# Toto Housing Companion

A housing-assistance screener for Southern Oregon and Central Minnesota (Annum
Housing / annumhousing.com). Live at
https://rangerzack.github.io/Toto-housing-companion/ (staging at `/staging/`).
GitHub: `Rangerzack/Toto-housing-companion`. Backend: Supabase project
`vhhcicawkhokncnhzboe` (Postgres + PostgREST, public read via the publishable
key in `web/config.js` — that key is safe to commit; the `SUPABASE_DB_URL`
repo secret must always hold a full `postgresql://` URL, never a bare
password).

The frontend is static (no build): `web/` is the site. To preview, serve the
`web/` folder with any static server (e.g. `npx serve web -l 8777`) — never
open index.html via file://, the app fetches from Supabase and uses history
navigation. `?v=__BUILD__` in the HTML is rewritten to the commit SHA at
deploy time.

## Data rules (user-established, non-negotiable)

- **One program, one dataset.** Never cross-validate one income dataset
  against another; verify against the program's own source text.
- **Each PHA publishes its own limits.** HAJC-HCV is Jackson only, JHCDC-HCV
  is Josephine; never substitute HUD-MFI for a PHA table.
- **Never hard-exclude on missing information.** Unticked box / unpublished
  limit / undocumented tenure ⇒ keep and flag. Income excludes only above
  110% of the published limit (margin justified by estimate roughness and
  per-program income windows — NOT "deductions").
- **QUALIFYING wording = any-of gates.** A rule cell starting "QUALIFYING:"
  (or containing "qualifies") is one of several routes in; matcher pools a
  program's qualifying gates and any single match satisfies the group.
- **CI output is canonical for generated files** (`web/flows/`,
  `docs/flows.json`): PowerShell 5.1 vs 7 format JSON differently, so local
  runs of `scripts/gen_flows.ps1` are preview-only — the generate-flows
  workflow commits and then dispatches deploy-pages.
- **Every market gets the same guidance treatment.** Results group by program
  type and population-targeted programs rank first via the matcher's `fit`
  boost. The code is market-agnostic; when building a new market's matrix,
  fill the population gate columns (veteran, age, disability, children,
  crisis) and record homeless-serving wherever true — the matcher reads
  tenure + crisis rule + program name for it because markets document it
  inconsistently. An empty gate column silently costs a program its boost.

## Landing page

The first screen is the **intro step of `web/index.html`**, grown into a full
landing page — not a separate document. That is deliberate: a share link
(`#a=…`) still opens straight on the results, `startFromProfile()` still runs
first for a signed-in visitor, and "Find programs for me" is the same
`data-action="next"` button the intro always had, so the wizard, its history
entries and its saved session are untouched. Everything below the hero is
lazy: the quick check mounts on idle, the map waits for an IntersectionObserver.

- **`landing.js`** orchestrates and owns the two ways in. `startWizard(answers,
  {satisfied})` in `app.js` is the only door: `satisfied` names the steps the
  handoff already answers, which `questionSteps()` then drops, reusing the
  saved-profile skip machinery rather than adding a second one.
- **`quick-check.js`** is a preview, never a second matcher. It builds the
  wizard's own `answers` shape and calls the same `screenPrograms()` with the
  same published limits. "Strong fit / Likely match / Worth a call" are read
  off the matcher's verdict and its `fit` array — never a score we invented.
  Each situation carries TWO shapes: `match` (broad, because `help` is a hard
  category gate and narrowing it on a guess hides programs) and `ask` (narrow,
  what the questionnaire is pre-ticked with). "Renting now" must never
  pre-tick "Staying in my home", which the wizard describes as facing eviction.
- **`property-map.js`** draws the map itself in inline SVG. No Leaflet, no
  Mapbox, no tiles: no API key, no third-party request on the first page
  somebody in a crisis loads, and — because the feed carries no coordinates —
  no basemap implying a street-level precision the data does not have. Pins
  are towns, they are real `<button>`s a keyboard can reach, and the page says
  out loud that a pin is the town and not the address. `drawBasemap()` is the
  single seam where a real tile layer would go.
- **`geo.js`** holds the town coordinates. `scripts/check_geo.mjs` (and the
  check-geo workflow) fails if a town is missing, outside its state, or more
  than 32 miles from its nearest county-mate — the rule is neighbourliness,
  not distance-to-centroid, because Klamath County is 100 miles long. A town
  with no coordinate is LISTED WITHOUT A PIN, never hidden.

## Results page (2026 redesign)

Built from the design canvas the user exported (`design/upgrade/`). The page
answers five questions in order and the sections ARE those answers: a
plain-language headline plus a **Your housing needs** summary card (which
replaced the answer chips; every line jumps back to its question), a **crisis
strip** shown only when the results contain a crisis-serving programme with a
real phone number, **Best next steps** (max three rich cards, each carrying
"Based on N of your answers"), **Rentals within your budget** (rent-first
cards saying how far under the cap each one is), and **More programs that may
help** as compact rows rather than a wall of cards. The detail dialog leads
with the match reason and puts a numbered *What to do next* rail beside the
facts, with the call button as step one.

Crisis is read from the PROGRAMME (`servesCrisis()`), never from what the
person ticked — someone fleeing violence at 2am has not necessarily checked a
box, and a 24/7 line they qualify for must not be hidden because of it.

The palette moved to a warm ground (`--paper #f3efe8`) with white cards and a
slightly deeper accent (`#c8294f`, which raises white-on-accent from 4.91:1 to
5.40:1); dark mode is warm near-black with the accent lifted to `#ee5c7b` and
`--on-primary` flipped to near-black, since white on it reaches only 3.25:1.

## Screener flow (as shipped)

Q3 is multi-select (`answers.help` array: rental | staying | buying |
utility); rent-or-own is asked only when staying is picked, other needs imply
tenure. A not-stably-housed checkbox on the circumstances step widens tenure
matching and implies the crisis box. Results: compact uniform cards (never
truncate, benefit always visible), 4 per category section behind Show-more,
details in a native `<dialog>` (facts left, action rail right) — cards never
expand in place. Share links encode answers in the `#a=` hash (7 or 8
parts; the 8th is bedrooms, absent on legacy links).

## Rental listings (Range Lab API)

Picking "Finding a rental" adds a bedrooms question and opens the results
with an **Available rentals** section: live listings from Range Lab's
Housing Data API, fetched through the `housing-search` Supabase edge
function (`supabase/functions/housing-search/`) so the private `rl_live_…`
key never ships to the browser. The function holds `HOUSING_API_URL` and
`HOUSING_API_KEY` as Supabase secrets and follows `{data, meta.total}`
pagination to 500 rows; the deploy-functions workflow ships it (needs the
`SUPABASE_ACCESS_TOKEN` repo secret). `web/housing.js` (no DOM, testable
alone) normalizes and screens listings; the API has no county field, so
`CITY_COUNTIES` in `web/config.js` maps cities to counties — unmapped
cities are shown, never hidden, per the no-hard-exclusion rule. A broken
listings feed degrades to an inline note; it never blocks program results.

## Accounts (optional)

Signing in is never required: the screener works anonymously and saves nothing
without an account, and the intro's privacy line must keep saying so. Accounts
add a saved profile, matches computed from it, and saved/recently-viewed items.
Pages are `/login/`, `/signup/`, `/forgot-password/` (also the set-a-new-password
step), `/profile/`, `/dashboard/`.

- **Security lives in RLS** (`0016_user_accounts.sql`), not the JavaScript:
  every policy on `profiles`, `saved_opportunities`, `viewed_opportunities` is
  scoped to `auth.uid()`. `requireAuth()` is a courtesy redirect, not a gate.
- **`auth.js` speaks to Supabase Auth over REST** rather than shipping
  supabase-js, keeping the site dependency-free; it owns session storage and
  token refresh. Because the session is in `localStorage`, nothing on these
  pages may ever use `innerHTML` with user- or server-supplied text.
- **A saved profile replaces the questionnaire, it does not sit beside it.**
  `app.js` reads the profile BEFORE rendering anything (`startFromProfile()`),
  showing `#profile-boot` meanwhile so the wizard never flashes up: complete
  goes straight to `/dashboard/`, partial opens the wizard prefilled with only
  the missing steps (`stepsSatisfiedBy()` drops the rest via `questionSteps()`)
  and writes the new answers back, empty falls through to the ordinary
  questions. `?new=1` forces a blank questionnaire; a share hash or an
  in-tab session still wins over the profile. Never re-ask a saved answer.
- **One profile, one matcher.** `profileToAnswers()` converts a profile row
  into the wizard's `answers` shape so `matcher.js` serves both paths;
  `profile-match.js` only formats the verdict into
  `{matchType, score, matchedCriteria, missingCriteria, failedCriteria,
  explanation}`. Never build a second matching path.
- **The profile asks only what changes matching.** Age is a band (the only
  thresholds any program uses are 24/60/62/65), and the sensitive circumstance
  flags are excluded from the completion score so nobody is pressured into
  disclosing a disability or a crisis to reach 100%.
- **Requires one Supabase setting:** the deployed `/forgot-password/` URL must
  be in Authentication → URL Configuration → Redirect URLs (production and
  `/staging/`), or reset links arrive tokenless.

## Data loading

`scripts/load_data.py` runs in the load-data workflow (inputs: csv_path,
state). Matrices live in `data/`. The MN matrix's upstream is the user's
Google Sheet MASTER (Drive fileId `1SjK1rQfjF6U8rNepbwjATkq4jZgGLfBxpsiUyRAghA0`,
tab "Researched Programs", headers on row 2, export arrives base64); 13
repo-side cell fixes must be re-applied after every fresh export until the
user pastes them into the sheet. Directory rows are held inactive via
INACTIVE_PATTERNS ("not an assistance programme", "organisation profile").

## Design canvas

The editable design canvas is a Claude artifact:
https://claude.ai/code/artifact/1eb6ec62-f46a-46d1-a0a8-ebefb32c57ed
Artboard sources are in `design/canvas/` — edit those, then re-seed and
republish with the `/design` skill (keep contract 0.1.31 and the 🖌️ favicon;
republish to the same artifact URL). Keep the canvas in sync with what ships.

## Open items

JHCDC call about its 2025 table (issue #2); paste the 13 MN cell fixes into
the MASTER sheet; tenure research for 6 OR programs; agency intake-script
outreach; MN rental programs to come later by design.
