# Income limits

Reference data for the income tests programs apply. Schema lives in
`supabase/migrations/0004_income_limits.sql`.

## Why four tables

Four things vary independently, so flattening them into one sheet forces you to
repeat and eventually contradict yourself:

| Table                 | Answers                                              |
| --------------------- | ---------------------------------------------------- |
| `income_standards`    | Who publishes this, and a percentage of *what* median |
| `income_areas`        | Which market it applies to                            |
| `income_limits`       | The dollar figures, by tier / household size / date   |
| `program_income_rules`| Which standard a given program tests against          |

The `basis` column on a standard is the one most easily lost: **60% SMI and 60%
AMI are different numbers.** Oregon's LIHEAP and utility programs test against
state median income, while housing programs test against area median income for
the county. A figure without its basis is not interpretable.

## Household sizes are ranges

HUD publishes one figure per household size, 1 through 8. USDA publishes
brackets — one figure for 1–4 person households, another for 5–8. Storing
`household_size_min` / `household_size_max` records what the publisher actually
said instead of inventing per-size precision that isn't in the source.

Query through `v_income_limits_by_size`, which expands brackets to one row per
size, so callers never need to know how a publisher grouped things.

## Looking up a limit

```sql
select income_limit_for('HUD-MFI', 'OR-JACKSON', 50, 3);
-- 44150
```

Arguments are `(standard, area, tier_pct, household_size, as_of_date, variant)`.
The last two are optional; `as_of_date` defaults to today, which means historical
rows stay queryable for reproducing a past determination.

For households larger than the published table it applies HUD's convention —
add 8% of the 4-person limit per additional person:

```sql
select income_limit_for('HUD-MFI', 'OR-JACKSON', 50, 10);
-- 72598  =  64750 + (49050 * 0.08 * 2)
```

It returns `NULL` when nothing is published for that combination. That is
deliberate: a missing limit must not silently become a wrong one. Callers should
treat `NULL` as "unknown, do not exclude anyone."

## Loading data

```bash
python scripts/load_income_limits.py data/income_limits_template.csv
```

Or run the **Load income limits** workflow in GitHub Actions.

Unlike `load_data.py`, this does **not** truncate. Limits accumulate so past
determinations stay reproducible; rows upsert on
`(standard, area, tier, size bracket, effective_date, variant)`, so re-running a
corrected file fixes a figure in place instead of duplicating it. Unknown
`standard_id` or `area_id` values abort the load rather than silently inserting
figures nobody can look up.

Column reference is in the docstring of `scripts/load_income_limits.py`.

## What is loaded today

**402 rows.**

| Standard | Coverage | Source |
| -------- | -------- | ------ |
| `HUD-MFI` | 12 Oregon counties x 30/50/60/80% x sizes 1-8, effective 2026-06-01 | HUD API, `il` dataset, FY2026 |
| `OR-SMI` | Statewide, 60% tier, sizes 1-8, FFY2026 (2025-10-01 to 2026-09-30) | HHS via the LIHEAP Clearinghouse |
| `USDA-502-GUARANTEED` | Jackson County only, 115% tier, 1-4 and 5-8 brackets | **Unverified** — secondary sources only, confirm before relying on it |

Refresh HUD figures with the **Fetch HUD income limits** workflow, which reads
the API directly:

```bash
python scripts/fetch_hud_limits.py --year 2026 --out data/hud_2026.csv
```

Run it with `--probe` to dump a single raw county response. That is the fastest
way to see HUD's actual field names when a year changes or a run misbehaves —
the tier figures are nested under `very_low` / `extremely_low` / `low`, not flat
on `data`, and the script scans for `il<tier>_p<size>` keys rather than assuming
a shape.

### The 30% tier is not 30% of median

HUD's "extremely low income" limit is the **greater of** 30% of median income or
the federal poverty guideline. For larger households the poverty floor wins, so
the figures step above a straight 30%: Jackson County's 4-person ELI is $33,000,
where 30% of median would be $29,450. The API returns the canonical
poverty-adjusted value and that is what is loaded. HUD's HOME table publishes
the unadjusted 30% row, which is why the two sources disagree from three persons
up — they are answering different questions.

The 50% and 80% figures are identical between the API and the HOME table, which
is a useful cross-check that both were read correctly.

Counties map to the HUD area that covers them: Jackson to Medford MSA,
Josephine to Grants Pass MSA, Lane to Eugene-Springfield MSA, Linn to Albany
MSA, Marion to Salem MSA, Clackamas to Portland-Vancouver-Hillsboro MSA, and the
rest are standalone county areas.

The HUD figures were checked three ways before loading: tiers are strictly
ordered at every household size, the 60% row is exactly 1.2x the 50% row
throughout (HUD's own arithmetic), and Jackson County's 50% figures match the
HAJC limits that arrived independently through the program matrix.

The Oregon SMI table publishes sizes 1-6; sizes 7-8 are derived with the HHS
family-size formula (132% at six persons, +3% per additional person, applied to
the 4-person figure). That formula reproduces the published 1-6 figures to
within $1, which is why it is trusted for 7-8.

### Still missing

| Standard | Blocker |
| -------- | ------- |
| `USDA-502-DIRECT` / county-specific guaranteed | USDA's limit maps return 403 to automated fetches. |
| `OHCS-BOND` | Published periodically by OHCS; no stable table URL found. |

Getting MTSP in therefore means a person exporting it once a year from the
[OHCS dashboard](https://www.oregon.gov/ohcs/compliance-monitoring/pages/rent-income-limits.aspx)
or [HUD's MTSP page](https://www.huduser.gov/portal/datasets/mtsp.html) into the
loader's CSV format. There is no automated path today.

**LIHTC and LIFT do not have their own figures** — both test against MTSP:
LIHTC across tiers from 20% to 80%, LIFT rental at 60% AMI, LIFT homeownership
at 80% AMI. Loading MTSP therefore covers all three at once. Do **not**
substitute the `HUD-MFI` figures: HUD computes MTSP with hold-harmless and
HERA-special provisions that keep some areas above their Section 8 equivalents,
so the two diverge in exactly the places where it changes an answer.

The reliable way to finish this is HUD's API, which serves both the IL and MTSP
datasets for every county and year. It needs a free token from
<https://www.huduser.gov/portal/dataset/fmr-api.html>; with one in a
`HUD_API_TOKEN` secret, a fetcher can keep every standard current automatically.

Until MTSP is loaded, `income_limit_for('HUD-MTSP', ...)` returns `NULL`, which
callers must treat as "unknown, do not exclude anyone."

## No foreign key to programs

`program_income_rules.program_id` is plain text on purpose.
`0001_init.sql` drops the program tables with `CASCADE` every time migrations
run, which would take any dependent table with it on each data reload. The
`v_orphan_income_rules` view reports rules whose program no longer resolves,
which is the check that replaces the missing constraint.

## Multiple states

County names are not unique. Oregon and Minnesota both have a Douglas County,
and their published limits differ by 27% — $41,800 against $52,950 at 50% AMI
for a household of four. Seven programs in this database list a county named
"Douglas". A name-only match would show all seven to residents of both.

So geography is always a **(county, state) pair**:

- `program_counties.state_code` records which state a county belongs to
- `programs.state_code` records which matrix a program came from
- `income_areas` is keyed by FIPS, which is unique across states
- the loader takes a state argument and replaces only that state's rows

That last point matters: `load_data.py` used to truncate every program table on
each run. With one dataset that was merely blunt; with two it would have deleted
Oregon the first time Minnesota loaded.

State also decides which median income applies. Oregon's utility programs test
against 60% of Oregon's SMI; Minnesota's Energy Assistance Program tests against
50% of Minnesota's. Those land within 0.2% of each other for a household of four
— $73,816 against $73,969 — because Minnesota's median is higher but its
threshold is lower. Two standards that nearly coincide are the easiest kind to
mix up and the hardest to notice, which is why the standard travels with the
program rather than being inferred.

### Adding another state

1. Add its counties and statewide area to `income_areas`, and its SMI standard
   to `income_standards` (a migration).
2. Add a `STATES` entry in `scripts/load_data.py` with its county list, what
   "statewide" should expand to, any city aliases, and its SMI standard.
3. Add its county FIPS codes to `COUNTY_FIPS_TO_AREA` in
   `scripts/fetch_hud_limits.py`, then run the fetch workflow.
4. Load its SMI table.
5. Add a `STATES` entry in `web/config.js`.
6. Run the load-data workflow with that state selected.

The loader warns when a county in the CSV matches nothing it knows, because the
failure is otherwise silent: unmatched counties become `Unspecified` and the
program shows for the whole state rather than erroring.

### Inactive records

The St. Cloud matrix documents entries that are not assistance anyone can apply
for — discontinued funds, referral desks, "shutoff protection (NOT a payment
program)". These load with `is_active = false` and the screener filters them
out. They stay in the database because the research is worth keeping; they never
reach results because a phone call to a referral line is not help.

## MTSP, LIHTC and LIFT

`HUD-MTSP` is loaded for Jackson County — ten tiers (20% through 80%) across
household sizes 1-8, effective 2026-05-01, from the OHCS dashboard. That single
table answers all three programs, because none of them publish their own
figures:

| Program | Tier |
| ------- | ---- |
| LIHTC | whichever tier the project elected, 20-80% |
| LIFT rental | 60% |
| LIFT homeownership | 80% |

**MTSP is not interchangeable with HUD-MFI**, and Jackson County shows why. The
two agree exactly at 50% and 60%, then diverge at 80%:

| Household | HUD-MFI | MTSP |
| --------- | ------- | ---- |
| 4 people | $78,500 | $78,480 |
| 6 people | $91,100 | $91,040 |
| 8 people | $103,650 | $103,600 |

HUD computes each Section 8 tier separately and caps it; every MTSP tier is a
straight multiple of the 50% figure. Twenty dollars is immaterial to a person,
but it is a real difference in the published tables, and in HERA-special and
hold-harmless areas the gap is far wider.

That multiple-of-the-base property is why `HUD-MTSP` is marked `proportional`:
scaling to a tier that is not stored is arithmetic rather than an estimate.

### Getting the rest of the counties

The dashboard is a Power BI report, which cannot be scraped — it renders to
canvas, exposes no data endpoint, and its export is a report action rather than
a file URL. The reliable route is a person opening the dashboard, choosing a
county, and using **Open Data Download** for the Excel export, or printing the
MTSP page to PDF as was done for Jackson.

A printed PDF works: Power BI converts text to vector outlines, so nothing can
be extracted from the file, but `scripts/` has no dependency on that — the page
was read as an image and transcribed. Rent limits are on the same page and are
not loaded, since nothing in the screener uses them yet.
