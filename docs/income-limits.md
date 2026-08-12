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
| `HUD-MTSP` (LIHTC, LIFT) | **Not served by HUD's public API** — `/hudapi/public/mtsp/...` returns an HTML error page, confirmed by probe. The tables exist only behind HUD's web query tool and OHCS's Power BI dashboard, neither machine-readable. |
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
