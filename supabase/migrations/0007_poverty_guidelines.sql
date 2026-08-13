-- Federal Poverty Guidelines
--
-- A third basis, alongside area median income and state median income. Seven
-- St. Cloud programs test at 200% FPG, and until now carried no income test at
-- all — they passed everyone rather than screening.
--
-- FPG is national, not local: one table covers the 48 contiguous states, with
-- separate tables for Alaska and Hawaii. That is why it lives against national
-- areas rather than a county.
--
-- Sanity check worth recording: HUD's "extremely low income" limit is the
-- greater of 30% of area median or the poverty guideline. Jackson County's 2026
-- ELI figures for households of 3 through 8 — 27,320 / 33,000 / 38,680 /
-- 44,360 / 50,040 / 55,720 — are exactly the 2026 poverty guidelines, because
-- at those sizes the poverty floor is the higher number. Two independent
-- sources agreeing to the dollar.

-- ---------------------------------------------------------------------------
-- Some standards scale exactly, and some do not.
-- ---------------------------------------------------------------------------
-- A "200% FPG" test is exactly twice the published guideline, and "60% SMI" is
-- exactly 1.2x the 50% figure, because both are defined as percentages of one
-- base. HUD's AMI tiers are NOT: each is computed separately and subject to
-- caps and hold-harmless rules, so 100% AMI is not twice the 50% figure.
--
-- The screener scales to unpublished tiers when it has to, and flags the result
-- as approximate so it never excludes anyone on an inferred number. For
-- proportional standards that caution is unnecessary — the arithmetic is exact.
alter table income_standards
    add column if not exists proportional boolean not null default false;

update income_standards set proportional = true
where standard_id in ('OR-SMI', 'MN-SMI');

insert into income_standards
    (standard_id, name, publisher, basis, notes, source_url, proportional)
values
    ('HHS-FPG', 'HHS Poverty Guidelines', 'U.S. Department of Health and Human Services', 'OTHER',
     'National table published each January. Programs cite multiples of it — 130%, 150%, 185%, 200% — '
     'and those multiples are exact, so only the 100% figures are stored.',
     'https://aspe.hhs.gov/topics/poverty-economic-mobility/poverty-guidelines', true)
on conflict (standard_id) do update
    set proportional = excluded.proportional,
        notes = excluded.notes,
        source_url = excluded.source_url;

insert into income_areas (area_id, name, area_type, state_code) values
    ('US-48', '48 contiguous states and DC', 'national', null),
    ('US-AK', 'Alaska',                      'state',    'AK'),
    ('US-HI', 'Hawaii',                      'state',    'HI')
on conflict (area_id) do nothing;
