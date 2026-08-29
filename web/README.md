# Toto Housing Companion — screener frontend

A guided screener that matches someone to housing, utility, and homebuying
programs from the Supabase database in this repo — or, for someone looking to
rent, searches available rental listings from a configurable housing data API.

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

| File         | What it does                                                  |
| ------------ | ------------------------------------------------------------- |
| `index.html` | Markup for every wizard step and the results view              |
| `styles.css` | Design system — light/dark, responsive, print styles           |
| `app.js`     | Wizard navigation, Supabase fetch, results rendering           |
| `matcher.js` | Eligibility matching engine (no DOM — testable on its own)     |
| `housing.js` | Rental-listing search: fetch, normalize, filter (no DOM)       |
| `config.js`  | Connection settings, county list, housing API endpoint         |
| `serve.ps1`  | Dependency-free local static server                            |

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

## The rental search ("Help finding a place")

Someone who answers *Finding a place to live* → *I'm looking to rent* is asked
one more question: do they want **help paying for rent** or **help finding a
place**? Paying continues into the program screener above. Finding runs the
housing search instead: it asks what size place they need, skips the
program-specific circumstance checkboxes, and shows actual rental listings for
their county — cheapest first, each flagged against the common
30%-of-gross-income affordability guideline when an income was given. The
results always offer a one-click switch to the rent-assistance programs, since
the two kinds of help usually go together.

Listings come from the API configured in `config.js`:

```js
export const HOUSING_API_URL = 'https://api.example.org/listings?state={state}&county={county}';
export const HOUSING_API_HEADERS = { 'X-Api-Key': '...' }; // if your API needs one
```

`{state}` and `{county}` are filled in from the person's answers; a URL
without placeholders is fetched as-is and filtered client-side. `housing.js`
unwraps common response envelopes (`{listings: [...]}`, `{data: {...}}`, a
bare array) and maps common field names (`rent`/`price`/`monthly_rent`,
`beds`/`bedrooms`, and so on) onto one internal shape — if your API's names
aren't recognized, add them to `FIELD_ALIASES` at the top of `housing.js`.
Until a URL is configured, the search path shows a "not connected yet" notice
and offers the program screener instead; nothing else is affected.

The same no-false-exclusion principle as the matcher applies: a listing
missing its county, size, or rent is never dropped for it — unknown rent
sorts last and reads "Not listed — ask".

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
