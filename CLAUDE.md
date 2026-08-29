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

## Screener flow (as shipped)

Q3 is multi-select (`answers.help` array: rental | staying | buying |
utility); rent-or-own is asked only when staying is picked, other needs imply
tenure. A not-stably-housed checkbox on the circumstances step widens tenure
matching and implies the crisis box. Results: compact uniform cards (never
truncate, benefit always visible), 4 per category section behind Show-more,
details in a native `<dialog>` (facts left, action rail right) — cards never
expand in place. Share links encode answers in the `#a=` hash.

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
