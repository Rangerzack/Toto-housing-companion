# SOP: choosing the income standard for a program

For anyone adding a program to the matrix or reviewing what the screener does
with one. It answers three questions: **which dataset applies**, **why that one
and not another**, and **where the numbers come from**.

The rule this whole document exists to protect:

> A program is tested against the standard its own published materials name.
> Never against whichever standard is convenient, and never against a default.
> When the standard or the threshold is unknown, apply **no income test** —
> a missing limit must never quietly become a wrong one.

---

## 1. The decision procedure

Work down this list. Stop at the first match. It mirrors what
`income_standard_for()` in `scripts/load_data.py` does, so a human and the
loader reach the same answer.

| # | If the program's own income language says… | Use | Area |
| - | ------------------------------------------ | --- | ---- |
| 0 | **A specific agency determines eligibility and publishes its own table** — a Section 8 voucher, NED or Homeownership Voucher | that agency's standard: `HAJC-HCV`, `JHCDC-HCV` | that agency's county |
| 1 | "state median income", "SMI", "% of the State of Oregon Median Income" | `OR-SMI` / `MN-SMI` — the state the program operates in | that state (`OR`, `MN`) |
| 2 | "federal poverty guidelines", "FPG", "FPL", "% of poverty" | `HHS-FPG` | `US-48` (or `US-AK` / `US-HI`) |
| 3 | It is a LIHTC, Tax-Exempt Bond, or LIFT project | `HUD-MTSP` (never HERA — see below) | the applicant's county |
| 4 | HOME, CDBG, or Housing Trust Fund project | `HUD-HOME` or `HUD-HTF` | the applicant's county |
| 5 | Oregon MIRL or Tribal Housing Grant Fund | `OHCS-MIRL` or `OHCS-THGF` | the applicant's county |
| 6 | "area median income", "AMI", "HUD income limits", "median family income" | `HUD-MFI` | the applicant's county |
| 7 | USDA Section 502 loan | `USDA-502-DIRECT` or `-GUARANTEED` | the applicant's county |
| 8 | "not income-tested", "no published income table", "not a fixed AMI test" | **none** | — |
| 9 | Eligibility flows from another program ("must be an approved EAP recipient") | that program's standard, noted as derivative | — |
| 10 | Anything else | **none**, and flag it for research | — |

### Why the agency's own table comes first

Section 8 eligibility is determined by the public housing authority that
administers the voucher, and each PHA publishes its own income limits for its
own jurisdiction. Those tables derive from HUD's — HAJC's matches `HUD-MFI` at
50% to the dollar today — which is exactly why leaving a voucher program on
HUD's table is easy to miss: it gives the right number until the two diverge.
They can: the effective dates already differ (HAJC 1 May 2026, HUD 1 June), and
JHCDC's posted table is dated April 2025.

This cannot be read from the income text, which says "50% AMI" and is equally
true of both. So it is recorded per program, in `PROGRAM_STANDARD_OVERRIDES`
in `scripts/load_data.py`. A voucher program with no entry falls through to
`HUD-MFI` and will quietly stop being right the moment its authority diverges.

### Why SMI is checked before FPG

Minnesota's Energy Assistance Program tests at **50% SMI**, but its write-up
also mentions "sizes 19–20 use 110% FPG" — an edge case for very large
households. Reading that as the primary standard drops the four-person limit
from **$71,998 to $33,000** and turns away families the program exists to serve.

Programs that genuinely test on poverty level never mention SMI at all. So SMI
wins when both appear. This ordering was wrong once and produced exactly that
failure before it was caught.

### Why category is not used

Category looks like a shortcut and is not one. `ACCESS-RVAR-OAR-OR-001` sits
under *Down Payment Assistance* but tests against "the State of Oregon Median
Income Limit". Classifying by category put it on county AMI, resolving its limit
to $88,313 instead of the correct $103,342 for a three-person household.

The program's own text decides. Category is a fallback only for rows with no
income language at all.

---

## 2. The standards

### `HUD-MFI` — HUD Section 8 / HOME income limits

**Used for:** rent assistance, vouchers, most down-payment assistance — anything
citing "area median income" or "HUD income limits".

**Why this one:** it is the limit HUD itself publishes per county or metro area
and the one those programs administer against.

**Source:** <https://www.huduser.gov/portal/datasets/il.html>
Pulled through HUD's API (`/hudapi/public/il/data/{fips}99999`), which needs a
free token in the `HUD_API_TOKEN` secret. Refresh with the **Fetch HUD income
limits** workflow.

**Published:** annually, effective around 1 June.
**Loaded:** 904 rows — 28 counties across Oregon and Minnesota, tiers 30/50/60/80, sizes 1–8.

**Watch for:** the 30% tier is *not* 30% of median. HUD's "extremely low income"
figure is the **greater of** 30% AMI or the federal poverty guideline, so for
larger households the poverty floor takes over — Jackson County's four-person
ELI is $33,000 where a straight 30% would be $29,450. The API returns the
canonical poverty-adjusted number.

Tiers here are **not** proportional. HUD computes each separately with its own
caps, so 100% AMI is not twice the 50% figure, and scaling between tiers is an
estimate that must never exclude anyone.

---

### `HUD-MTSP` — Multifamily Tax Subsidy Project limits

**Used for:** LIHTC (whichever tier the project elected, 20–80%), Tax-Exempt
Bonds, **LIFT rental at 60%**, **LIFT homeownership at 80%**.

**Why this one:** none of those three programs publishes its own figures. All of
them test against MTSP, so one table answers all three.

**Why not `HUD-MFI`:** they are genuinely different tables. For Jackson County
they agree exactly at 50% and 60%, then diverge at 80%:

| Household | HUD-MFI | MTSP |
| --------- | ------- | ---- |
| 4 people | $78,500 | $78,480 |
| 6 people | $91,100 | $91,040 |
| 8 people | $103,650 | $103,600 |

HUD caps each Section 8 tier separately; every MTSP tier is a straight multiple
of the 50% figure. The gap is small in Medford and much wider in HERA-special
and hold-harmless areas. Substituting one for the other is not safe.

**Source:** <https://www.huduser.gov/portal/datasets/mtsp.html>, and for Oregon
the OHCS dashboard at
<https://www.oregon.gov/ohcs/compliance-monitoring/pages/rent-income-limits.aspx>

**Published:** annually around 1 May; owners must implement by mid-June.
**Loaded:** 80 rows — Jackson County only, ten tiers, sizes 1–8.

**How to get more counties — this one is manual.** The dashboard is a Power BI
report: it renders to canvas, exposes no data endpoint, and its export is a
report action rather than a file URL. Nothing can scrape it. Either:

1. Open the dashboard, choose the county, and use **Open Data Download** for the
   Excel export (best — covers every county at once), or
2. Select the county on the MTSP tab and print the page to PDF, as was done for
   Jackson.

A printed PDF still works even though Power BI converts text to vector outlines
and leaves nothing machine-readable — the page gets read as an image and
transcribed. Budget for that; it is not automatable.

---

### `OR-SMI` — Oregon state median income

**Used for:** LIHEAP, OEAP, Pacific Power LID, Avista discount — Oregon's
utility and energy assistance programs, all at **60% SMI**.

**Why this one:** these test against *state* median income, not the county's.
The distinction is the single most consequential one in this system. For a
two-person household, 60% of Oregon SMI is **$50,194** while Josephine County's
60% AMI is **$40,140**. Testing a utility applicant against the county figure
wrongly rejects them by more than $10,000.

**Source:** HHS estimates via the LIHEAP Clearinghouse,
<https://liheapch.acf.gov/profiles/povertytables/FY2026/orsmi.htm>
Framing confirmed at
<https://www.oregon.gov/ohcs/energy-weatherization/pages/utility-bill-payment-assistance.aspx>

**Published:** each federal fiscal year, effective 1 October.
**Loaded:** 24 rows — statewide, 60% and 100% tiers, sizes 1–12.

**Watch for:** HHS publishes sizes 1–6 only. Sizes 7+ come from their stated
family-size formula — 132% at six persons, +3% per additional person, applied to
the 4-person figure. That formula reproduces the published 1–6 figures to within
$1, which is why it is trusted beyond them. One published source rendered sizes
7–8 by extending the linear pattern instead of applying the formula, giving
$109,248 where the correct figure is $99,652. Use the formula, not a linear
extension.

---

### `MN-SMI` — Minnesota state median income

**Used for:** Minnesota Energy Assistance Program (Primary Heat, Crisis, Energy
Related Repair), HeatShare, Stearns Electric, ERMU — all at **50% SMI**.

**Why a separate standard from `OR-SMI`:** because "SMI" means a different
number in each state, and here the two nearly coincide, which makes the error
invisible:

| 4-person household | |
| ------------------ | - |
| Oregon at 60% SMI | $73,816 |
| Minnesota at 50% SMI | $73,969 |

**0.2% apart.** Minnesota's median is higher but it tests at a lower percentage.
A program pointed at the wrong state's table would look correct in every spot
check and still be wrong. This is why the standard travels with the program
rather than being inferred from anything.

Note also the tier differs: Oregon utilities test at 60%, Minnesota's at 50%.
Copying the tier across states is as wrong as copying the table.

**Source:** <https://liheapch.acf.gov/profiles/povertytables/FY2026/mnsmi.htm>
FFY2027 figures came from the program matrix's own EAP entry, which quotes the
published table.

**Published:** each federal fiscal year, effective 1 October.
**Loaded:** 48 rows — statewide, 50% and 100% tiers, sizes 1–12, for FFY2026 and FFY2027.

---

### `HHS-FPG` — federal poverty guidelines

**Used for:** Emergency General Assistance (Stearns, Benton, Sherburne) and the
four FHPAP providers — all at **200% FPG**.

**Why this one:** these programs test on poverty level, not on any median
income. Before this standard existed they carried no income test at all and
passed everyone.

**Source:** <https://aspe.hhs.gov/topics/poverty-economic-mobility/poverty-guidelines>

**Published:** each January, in the Federal Register.
**Loaded:** 36 rows — 100% tier for the 48 contiguous states, Alaska, and
Hawaii, sizes 1–12.

**Only the 100% figures are stored.** Programs cite multiples — 130%, 150%,
185%, 200% — and those multiples are exact, so any tier resolves by arithmetic.

**A useful cross-check:** the 2026 guidelines for households of 3–8 match HUD's
Jackson County ELI figures to the dollar. That is expected, since ELI is the
greater of 30% AMI or the poverty guideline and poverty wins at those sizes. Two
independent sources agreeing exactly is good evidence both were read correctly.

---

### `HAJC-HCV` / `JHCDC-HCV` — housing authority voucher limits

**Used for:** Section 8 Housing Choice Vouchers, NED vouchers, and the
Homeownership Voucher — each under the authority that administers it.

**Why this one:** the PHA makes the eligibility decision and publishes the
table an applicant is actually measured against.

| Authority | County | Source | Posted effective date |
| --------- | ------ | ------ | --------------------- |
| HAJC | Jackson | <https://hajc.net/housing-programs/housing-choice-voucher/> | 1 May 2026 |
| JHCDC | Josephine | <https://jhcdc.net/applicants/> | 1 April 2025 |

**Watch for:** JHCDC publishes **monthly** figures; they are stored annualised
(monthly × 12). Its posted table predates HUD's FY2026 limits and runs about
1.4% above them — most likely the page is stale rather than Josephine genuinely
using higher thresholds. Confirm with JHCDC before relying on it for a
determination. HAJC's page also carries a stale 2021 table under its FAQ; the
current figures are the ones under "Income limits".

**Published:** by each authority after HUD issues new limits, on its own
timing. That independence is the whole reason these are tracked separately.

---

### `HUD-MTSP-HERA` — MTSP HERA Special

**Used for:** nothing, by default — and that is deliberate.

**What it is:** the Housing and Economic Recovery Act limits, which apply only
to LIHTC projects **placed in service before 2009**. Newer projects use
`HUD-MTSP`. For Jackson County HERA runs $2,350–$3,760 above Actual at 50–80%.

**Why no program points here:** which table applies is a property of the
*building*, not the county, and the program matrix does not carry
placed-in-service dates. Routing a program here would raise its limits for
every building it does not apply to. It exists so a caseworker looking at a
specific older property can resolve the right figure.

**Source:** OHCS workbook, MTSP HERA tab;
<https://www.huduser.gov/portal/datasets/mtsp.html#data_2026>
**Published:** with MTSP, around 1 May.
**Loaded:** Jackson and Josephine, ten tiers, 2024–2026.

---

### `HUD-HTF` — Housing Trust Fund

**Used for:** National Housing Trust Fund projects.

**What it is:** a single extremely-low-income figure per county — the greater
of 30% AMI or the poverty guideline. Stored at tier 30. Jackson County 2026:
$33,000 for a four-person household.

**Source:** <https://www.huduser.gov/portal/datasets/HTF-Income-limits.html>
**Published:** annually with the HOME limits, effective around 1 June.

---

### `HUD-HOME` — HOME and CDBG

**Used for:** HOME Investment Partnerships and Community Development Block
Grant programs, at 30/50/60/80%.

**Why separate from `HUD-MFI`:** these are HUD's *adjusted HOME* limits. They
match the Section 8 figures at 50% and 80% but differ at 30%, where HOME
publishes the unadjusted figure and Section 8 applies the poverty floor.
Different programs, different tables.

**Source:** <https://www.huduser.gov/portal/datasets/home-income-limits.html>
**Published:** annually, effective around 1 June.

---

### `OHCS-MIRL` / `OHCS-THGF` — Moderate Income Rural Limit, Tribal Housing Grant Fund

**Used for:** Oregon's Moderate-Income Revolving Loan program and Tribal
Housing Grant Fund, at 50/80/100/120%.

**Why two standards for identical 2026 figures:** they are separately
administered programs published on separate tabs with separate effective dates
(MIRL 1 June, THGF 30 June). They happen to agree today; keeping them apart
means a future divergence shows up as data rather than as a wrong answer.

Both are proportional — the 100% row is OHCS's median figure and every tier is
an exact multiple of it.

**Source:** <https://www.huduser.gov/portal/datasets/cdbg-income-limits.html>

---

### `USDA-502-DIRECT` / `USDA-502-GUARANTEED`

**Used for:** USDA Section 502 rural home loans. Guaranteed tests at 115% of
area median; Direct uses low and very-low income tiers.

**Source:** HB-1-3555 Appendix 5, issued as a procedure notice each federal
fiscal year (FY2026: PN 657, 13 July 2026);
<https://www.rd.usda.gov/resources/directives/handbooks>

**Loaded:** `USDA-502-GUARANTEED` for all 28 counties across Oregon and
Minnesota — three tiers (very low 50%, low 80%, moderate 115%), FY2026.
`USDA-502-DIRECT` is declared but empty; the Direct appendix (HB-1-3550) has
not been supplied.

**Why not borrow HUD's table:** for 22 of 24 Oregon area/tier combinations the
two agree to the dollar. Grants Pass is the exception, running about 1.4%
higher at every tier and bracket — a real difference in the published figures.
A USDA program measured against HUD would be right in eleven counties and
wrong in Josephine, which is the hardest kind of error to notice.

**Watch for:** USDA publishes in **brackets** — one figure for 1–4 person
households, another for 5–8 — not per size. The schema stores that as published
via `household_size_min` / `household_size_max`, and
`v_income_limits_by_size` expands it. Also: USDA labels moderate income "115%"
but defines it as the greater of three formulas, so the figure is not a
straight percentage of area median and the standard is not marked proportional.

An earlier load carried two Jackson County rows from secondary sources that
were wrong ($119,850 against the published $122,800). They were removed in
migration 0010 rather than left as history, because they were never accurate
for any period.

---

### `OHCS-BOND`

**Used for:** OHCS Flex Lending (FirstHome / NextStep) and the Mortgage Credit
Certificate program.

**Status: declared but empty.** Both programs currently carry no income test.
OHCS publishes these limits by county, household size, and whether the property
is in a HUD-designated targeted area, but no stable machine-readable table has
been found. This is a known gap, not an oversight.

---

## 2b. Rent limits

Rent limits live in their own table, `rent_limits`, because they are a
different shape: they vary by **bedroom count** rather than household size, and
HOME/CDBG publishes three *kinds* of rent for the same unit — Fair Market Rent,
High Rent Limit, Low Rent Limit — which `income_limits` has no column for.

```sql
select rent_limit_for('HUD-MTSP', 'OR-JACKSON', 2, 60);
-- 1324   (2-bedroom, 60% tier, monthly)

select rent_limit_for('HUD-HOME', 'OR-JACKSON', 2, null, 'high_rent');
-- 1413
```

Arguments: `(standard, area, bedrooms, tier, kind, as_of_date)`. Tier is NULL
for kinds that are not tier-based. Newest effective date wins, as with income.

Nothing in the screener reads rents yet. They are loaded so the data is in
place for program-side work — maximum rent a voucher covers, whether a listed
unit falls under a project's rent cap — rather than for applicant screening.

Load with the income-limits workflow by filling in `rent_csv_path`, or:

```bash
python scripts/load_rent_limits.py data/rent_limits_ohcs_or.csv
```

---

## 3. Adding or updating a limit table

1. Get the figures from the publisher above. Never from a summary, a search
   result, or a secondary site — those have been wrong twice in this project.
2. Put them in the loader's CSV format (columns documented in
   `scripts/load_income_limits.py`).
3. Run the **Load income limits** workflow, or:
   ```bash
   python scripts/load_income_limits.py data/your_file.csv
   ```
4. The loader upserts rather than truncating, so limits accumulate and past
   determinations stay reproducible. An unknown `standard_id` or `area_id`
   aborts the load rather than inserting figures nobody can look up.

### Validate before trusting

These checks have each caught a real error:

- **Tier ordering.** 30% < 50% < 60% < 80% at every household size.
- **Known relationships.** HUD's 60% row is exactly 1.2× its 50% row. MTSP tiers
  are exact multiples of its 50% row. If a relationship that should hold does
  not, the parse is wrong.
- **Cross-source agreement.** If two independent sources cover the same figure,
  compare them. Jackson County's 50% row appears in HUD's API, the HOME table,
  the MTSP dashboard, and the HAJC program listing — all four agree.
- **Sanity against a neighbour.** A county's limits should be in the same
  neighbourhood as adjacent counties.

A parsing bug in this project silently filled every 80% row with 50% figures,
because the pattern `LOW INCOME` also matches inside `VERY LOW INCOME`. Spot
checks passed; the tier-ordering check is what exposed it.

---

## 4. Refresh calendar

| When | Standard | Effective | Action |
| ---- | -------- | --------- | ------ |
| January | `HHS-FPG` | on publication | Reload the national table |
| ~1 May | `HUD-MTSP`, `HUD-MTSP-HERA` | mid-June | Export the OHCS workbook, rebuild the OHCS CSVs |
| Spring | `HUD-MFI` | ~1 June | Run the fetch workflow with the new year |
| Spring | `HUD-HOME`, `HUD-HTF`, `OHCS-MIRL` | ~1 June | Same OHCS workbook export |
| Spring | `OHCS-THGF` | 30 June | Same OHCS workbook export |
| After HUD | `HAJC-HCV`, `JHCDC-HCV` | each PHA's own date | Check both PHA pages, reload |
| ~July | `USDA-502-GUARANTEED` | date of the notice | New HB-1-3555 Appendix 5, re-parse |
| Summer | `OR-SMI`, `MN-SMI` | 1 October | Reload both state tables |

Only `HUD-MFI` is automated. Everything else needs a person — though the five
OHCS-workbook standards come from one export, so that is a single annual task
rather than five.

This schedule also lives in the database, on `income_standards.published_when`
and `effective_when`, and surfaces in every dataset report.

### What is loaded right now

| Standard | Income rows | Areas | Rent rows | Years |
| -------- | ----------: | ----: | --------: | ----- |
| `HUD-MFI` | 904 | 28 | — | 2026 |
| `HUD-MTSP` | 400 | 2 | 420 | 2024–2026 |
| `HUD-MTSP-HERA` | 400 | 2 | 350 | 2024–2026 |
| `HUD-HOME` | 192 | 2 | 126 | 2024–2026 |
| `HUD-HTF` | 48 | 2 | 42 | 2024–2026 |
| `OHCS-MIRL` | 192 | 2 | 144 | 2024–2026 |
| `OHCS-THGF` | 64 | 2 | 48 | 2026 |
| `USDA-502-GUARANTEED` | 168 | 28 | — | FY2026 |
| `OR-SMI` | 24 | 1 | — | FFY2026 |
| `MN-SMI` | 48 | 1 | — | FFY2026–27 |
| `HHS-FPG` | 36 | 3 | — | 2026 |
| `HAJC-HCV` | 8 | 1 | — | 2026 |
| `JHCDC-HCV` | 8 | 1 | — | 2025 |
| `USDA-502-DIRECT` | 0 | — | — | not supplied |
| `OHCS-BOND` | 0 | — | — | no table located |

**2,492 income rows, 1,130 rent rows.** The multi-area standards (HUD-MFI,
USDA) cover both states; the OHCS-workbook standards cover Jackson and
Josephine only, by request — the workbook holds every Oregon county and the
rest are a one-line change to the builder.

---

## 5. What the screener does with all this

- The standard and tier live in `program_income_rules`, derived from each
  program's own text at load time. They are **data, not logic** — inspectable
  and correctable without touching code.
- A missing tier means **no income test**, not a default.
- A missing limit returns `NULL`, and the program stays in results with a
  "worth checking" note rather than being dropped.
- Being over a limit on **gross** income flags rather than excludes — the
  figure typed in is an estimate, and programs measure income their own way
  (Minnesota's EAP counts only the most recent month of gross income; HUD
  programs apply deductions when setting the rent share). Only incomes more
  than 10% over the limit are filtered.
- Scaling to an unstored tier is exact for proportional standards
  (`HHS-FPG`, `HUD-MTSP`, `OR-SMI`, `MN-SMI`) and an estimate for the rest —
  and an estimate never excludes anyone.

Every active program and the dataset it uses is listed in
[program_income_datasets.csv](program_income_datasets.csv).
