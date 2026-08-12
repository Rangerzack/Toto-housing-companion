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

Only Jackson County 50% AMI (the one figure set published anywhere in the
program matrix) plus a USDA example row. **Everything else still needs to come
from the official tables:**

- HUD income limits — <https://www.huduser.gov/portal/datasets/il.html>
- Oregon SMI for LIHEAP/OEAP — published by OHCS, effective each October 1
- USDA 502 limits — direct and guaranteed maps under rd.usda.gov

Until those are loaded, the screener still uses the estimated AMI table in
`web/config.js`. Wiring the frontend to this database before the real figures
are in would make matching worse, not better — most lookups would return `NULL`.

## No foreign key to programs

`program_income_rules.program_id` is plain text on purpose.
`0001_init.sql` drops the program tables with `CASCADE` every time migrations
run, which would take any dependent table with it on each data reload. The
`v_orphan_income_rules` view reports rules whose program no longer resolves,
which is the check that replaces the missing constraint.
