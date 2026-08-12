-- Income limits reference data
--
-- Holds published income limits across markets, publishers, tiers, household
-- sizes, and years, so the screener can convert "household size + income" into
-- a real eligibility test instead of an estimate.
--
-- Four things vary independently, which is why this is four tables and not one
-- wide sheet:
--
--   * WHO publishes the standard  — HUD, Oregon HCS, USDA (income_standards)
--   * WHICH market it applies to  — county, MSA, statewide  (income_areas)
--   * WHICH tier and family size  — 50% of median, 3 people  (income_limits)
--   * WHICH standard a program uses                         (program_income_rules)
--
-- Note on re-runs: 0001_init.sql drops the program tables with CASCADE every
-- time migrations are applied, so nothing here may hold a foreign key to
-- programs — it would be destroyed on each data reload. program_income_rules
-- therefore stores program_id as plain text, and v_orphan_income_rules below
-- reports any that no longer resolve. Everything in this file is written to be
-- safely re-runnable.

-- ---------------------------------------------------------------------------
-- Who publishes a set of limits, and what median it is a percentage OF.
-- ---------------------------------------------------------------------------
create table if not exists income_standards (
    standard_id text primary key,
    name        text not null,
    publisher   text,
    -- AMI = area (county/MSA) median income; SMI = state median income.
    -- A "60% SMI" utility limit and a "60% AMI" housing limit are different
    -- numbers, so the basis has to travel with the figure.
    basis       text not null check (basis in ('AMI', 'SMI', 'OTHER')),
    notes       text,
    source_url  text
);

-- ---------------------------------------------------------------------------
-- Markets. Counties are the common case; HUD publishes many limits by MSA, and
-- SMI-based programs are statewide.
-- ---------------------------------------------------------------------------
create table if not exists income_areas (
    area_id     text primary key,
    name        text not null,
    area_type   text not null check (area_type in ('county', 'msa', 'state', 'national', 'custom')),
    state_code  text,
    county_fips text,
    cbsa_code   text,
    -- e.g. a county belonging to an MSA whose limits it inherits
    parent_area_id text references income_areas(area_id),
    notes       text
);

-- ---------------------------------------------------------------------------
-- The numbers themselves.
--
-- Household size is a RANGE, not a single integer, because publishers differ:
-- HUD lists one row per size 1-8, while USDA publishes "1-4 person" and
-- "5-8 person" brackets. Storing it as published avoids inventing precision
-- that isn't in the source; v_income_limits_by_size expands ranges for lookup.
-- ---------------------------------------------------------------------------
create table if not exists income_limits (
    limit_id           bigint generated always as identity primary key,
    standard_id        text not null references income_standards(standard_id) on delete cascade,
    area_id            text not null references income_areas(area_id) on delete cascade,
    tier_pct           numeric not null check (tier_pct > 0),   -- 30, 50, 60, 80, 100, 115
    household_size_min smallint not null check (household_size_min >= 1),
    household_size_max smallint not null,
    amount             numeric not null check (amount >= 0),
    effective_date     date not null,
    expires_date       date,
    -- distinguishes limit sets that coexist for the same area and tier, e.g.
    -- 'targeted_area' for OHCS bond programs, 'guaranteed' vs 'direct' for USDA
    variant            text,
    source_url         text,
    notes              text,
    constraint income_limits_size_range check (household_size_max >= household_size_min),
    constraint income_limits_date_range check (expires_date is null or expires_date > effective_date)
);

-- One figure per standard/area/tier/size-bracket/date/variant. The coalesce
-- makes NULL variants collide as intended, which a plain UNIQUE would not.
create unique index if not exists income_limits_identity
    on income_limits (standard_id, area_id, tier_pct, household_size_min,
                      household_size_max, effective_date, coalesce(variant, ''));

create index if not exists income_limits_lookup
    on income_limits (standard_id, area_id, tier_pct, effective_date desc);

-- ---------------------------------------------------------------------------
-- Which standard each program tests against.
--
-- area_id NULL means "resolve against the applicant's own county" — the usual
-- case for a program operating across several counties.
-- ---------------------------------------------------------------------------
create table if not exists program_income_rules (
    program_id          text primary key,  -- intentionally not an FK; see header
    standard_id         text references income_standards(standard_id),
    area_id             text references income_areas(area_id),
    tier_min_pct        numeric,
    tier_max_pct        numeric,
    variant             text,
    household_size_used boolean not null default true,
    notes               text,
    constraint program_income_rules_tier_order
        check (tier_min_pct is null or tier_max_pct is null or tier_max_pct >= tier_min_pct)
);

-- ---------------------------------------------------------------------------
-- Lookup views
-- ---------------------------------------------------------------------------

-- Expands published brackets into one row per household size, so callers can
-- match on an exact size without knowing how the publisher grouped them.
create or replace view v_income_limits_by_size as
select l.limit_id,
       l.standard_id,
       l.area_id,
       l.tier_pct,
       size.household_size,
       l.amount,
       l.effective_date,
       l.expires_date,
       l.variant,
       l.source_url
from income_limits l
cross join lateral generate_series(l.household_size_min, l.household_size_max)
     as size(household_size);

create or replace view v_current_income_limits as
select *
from v_income_limits_by_size
where effective_date <= current_date
  and (expires_date is null or expires_date > current_date);

-- Program income rules whose program_id no longer matches a loaded program.
-- Because there is no FK (see header), this is how you catch drift after the
-- CSV is reloaded with changed IDs.
create or replace view v_orphan_income_rules as
select r.program_id, r.standard_id, r.tier_max_pct
from program_income_rules r
left join programs p on p.program_id = r.program_id
where p.program_id is null;

-- ---------------------------------------------------------------------------
-- Lookup function
-- ---------------------------------------------------------------------------
-- Returns the income limit for a household, or NULL when nothing is published
-- for that combination. Applies HUD's convention for households larger than
-- the published table: add 8% of the 4-person limit per additional person.
create or replace function income_limit_for(
    p_standard text,
    p_area     text,
    p_tier     numeric,
    p_size     integer,
    p_on       date default current_date,
    p_variant  text default null
) returns numeric
language plpgsql
stable
as $$
declare
    v_amount   numeric;
    v_max_size smallint;
    v_largest  numeric;
    v_four     numeric;
begin
    select amount into v_amount
    from v_income_limits_by_size
    where standard_id = p_standard
      and area_id = p_area
      and tier_pct = p_tier
      and household_size = p_size
      and effective_date <= p_on
      and (expires_date is null or expires_date > p_on)
      and (p_variant is null or variant is not distinct from p_variant)
    order by effective_date desc
    limit 1;

    if v_amount is not null then
        return v_amount;
    end if;

    select max(household_size) into v_max_size
    from v_income_limits_by_size
    where standard_id = p_standard
      and area_id = p_area
      and tier_pct = p_tier
      and effective_date <= p_on
      and (expires_date is null or expires_date > p_on)
      and (p_variant is null or variant is not distinct from p_variant);

    -- Nothing published, or the size is within the table and simply missing.
    if v_max_size is null or p_size <= v_max_size then
        return null;
    end if;

    select amount into v_largest
    from v_income_limits_by_size
    where standard_id = p_standard and area_id = p_area and tier_pct = p_tier
      and household_size = v_max_size
      and effective_date <= p_on
      and (expires_date is null or expires_date > p_on)
      and (p_variant is null or variant is not distinct from p_variant)
    order by effective_date desc
    limit 1;

    select amount into v_four
    from v_income_limits_by_size
    where standard_id = p_standard and area_id = p_area and tier_pct = p_tier
      and household_size = 4
      and effective_date <= p_on
      and (expires_date is null or expires_date > p_on)
      and (p_variant is null or variant is not distinct from p_variant)
    order by effective_date desc
    limit 1;

    if v_largest is null or v_four is null then
        return null;
    end if;

    return round(v_largest + v_four * 0.08 * (p_size - v_max_size));
end;
$$;

-- ---------------------------------------------------------------------------
-- Row level security — public read, writes via service_role only, matching
-- the policy set in 0002_rls_public_read.sql.
-- ---------------------------------------------------------------------------
alter table income_standards      enable row level security;
alter table income_areas          enable row level security;
alter table income_limits         enable row level security;
alter table program_income_rules  enable row level security;

drop policy if exists "Public read access" on income_standards;
drop policy if exists "Public read access" on income_areas;
drop policy if exists "Public read access" on income_limits;
drop policy if exists "Public read access" on program_income_rules;

create policy "Public read access" on income_standards     for select using (true);
create policy "Public read access" on income_areas         for select using (true);
create policy "Public read access" on income_limits        for select using (true);
create policy "Public read access" on program_income_rules for select using (true);

-- ---------------------------------------------------------------------------
-- Seed: the standards and markets the current program set references.
-- ---------------------------------------------------------------------------
insert into income_standards (standard_id, name, publisher, basis, notes, source_url) values
    ('HUD-MFI', 'HUD Multifamily Tax Subsidy / Section 8 Income Limits', 'U.S. Department of Housing and Urban Development', 'AMI',
     'Published annually by county or MSA. Tiers are computed separately by HUD and are not simple multiples of one another.',
     'https://www.huduser.gov/portal/datasets/il.html'),
    ('OR-SMI', 'Oregon State Median Income', 'Oregon Housing and Community Services', 'SMI',
     'Basis for LIHEAP, OEAP, and utility discount programs. Statewide, typically effective October 1.',
     'https://www.oregon.gov/ohcs/energy-weatherization/Pages/index.aspx'),
    ('USDA-502-DIRECT', 'USDA Section 502 Direct Loan Limits', 'USDA Rural Development', 'AMI',
     'Published in 1-4 and 5-8 person brackets rather than per household size.',
     'https://www.rd.usda.gov/files/RD-DirectLimitMap.pdf'),
    ('USDA-502-GUARANTEED', 'USDA Section 502 Guaranteed Loan Limits', 'USDA Rural Development', 'AMI',
     'Moderate income, up to 115% of area median. Published in 1-4 and 5-8 person brackets.',
     'https://www.rd.usda.gov/files/RD-GRHLimitMap.pdf'),
    ('OHCS-BOND', 'OHCS Flex Lending / Bond Program Income Limits', 'Oregon Housing and Community Services', 'AMI',
     'Varies by county, household size, and whether the property is in a HUD-designated targeted area (variant = targeted_area).',
     'https://www.oregon.gov/ohcs/homeownership/Pages/index.aspx')
on conflict (standard_id) do nothing;

insert into income_areas (area_id, name, area_type, state_code, county_fips) values
    ('OR',       'Oregon',            'state',  'OR', null),
    ('OR-CLACKAMAS', 'Clackamas County, OR', 'county', 'OR', '41005'),
    ('OR-COOS',      'Coos County, OR',      'county', 'OR', '41011'),
    ('OR-CURRY',     'Curry County, OR',     'county', 'OR', '41015'),
    ('OR-DOUGLAS',   'Douglas County, OR',   'county', 'OR', '41019'),
    ('OR-JACKSON',   'Jackson County, OR',   'county', 'OR', '41029'),
    ('OR-JOSEPHINE', 'Josephine County, OR', 'county', 'OR', '41033'),
    ('OR-KLAMATH',   'Klamath County, OR',   'county', 'OR', '41035'),
    ('OR-LANE',      'Lane County, OR',      'county', 'OR', '41039'),
    ('OR-LINCOLN',   'Lincoln County, OR',   'county', 'OR', '41041'),
    ('OR-LINN',      'Linn County, OR',      'county', 'OR', '41043'),
    ('OR-MARION',    'Marion County, OR',    'county', 'OR', '41047'),
    ('OR-UNION',     'Union County, OR',     'county', 'OR', '41061')
on conflict (area_id) do nothing;

-- The only income figures published anywhere in the source matrix: Jackson
-- County 50% AMI (Very Low Income) limits carried in the Housing Choice
-- Voucher program's "Income Standard" note. Everything else has to be loaded
-- from the official tables — see scripts/load_income_limits.py.
insert into income_limits
    (standard_id, area_id, tier_pct, household_size_min, household_size_max,
     amount, effective_date, source_url, notes)
values
    ('HUD-MFI', 'OR-JACKSON', 50, 1, 1, 34350, date '2026-05-01', null, 'From HAJC Housing Choice Voucher program listing'),
    ('HUD-MFI', 'OR-JACKSON', 50, 2, 2, 39250, date '2026-05-01', null, 'From HAJC Housing Choice Voucher program listing'),
    ('HUD-MFI', 'OR-JACKSON', 50, 3, 3, 44150, date '2026-05-01', null, 'From HAJC Housing Choice Voucher program listing'),
    ('HUD-MFI', 'OR-JACKSON', 50, 4, 4, 49050, date '2026-05-01', null, 'From HAJC Housing Choice Voucher program listing'),
    ('HUD-MFI', 'OR-JACKSON', 50, 5, 5, 53000, date '2026-05-01', null, 'From HAJC Housing Choice Voucher program listing'),
    ('HUD-MFI', 'OR-JACKSON', 50, 6, 6, 56900, date '2026-05-01', null, 'From HAJC Housing Choice Voucher program listing'),
    ('HUD-MFI', 'OR-JACKSON', 50, 7, 7, 60850, date '2026-05-01', null, 'From HAJC Housing Choice Voucher program listing'),
    ('HUD-MFI', 'OR-JACKSON', 50, 8, 8, 64750, date '2026-05-01', null, 'From HAJC Housing Choice Voucher program listing')
on conflict do nothing;
