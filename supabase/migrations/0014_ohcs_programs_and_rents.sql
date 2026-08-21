-- OHCS Income and Rent Limits workbook: the remaining program datasets, plus
-- a home for rent limits.
--
-- Source is the "Open Data Download" from the OHCS dashboard
-- (2026_Rent_and_Income_Limits.xlsx), which carries three years of every
-- program OHCS publishes limits for. Its Actual MTSP tab matches the figures
-- already loaded under HUD-MTSP to the dollar, which confirms the earlier
-- PDF transcription.

-- ---------------------------------------------------------------------------
-- New standards
-- ---------------------------------------------------------------------------
insert into income_standards
    (standard_id, name, publisher, basis, notes, source_url, proportional,
     published_when, effective_when)
values
    -- HERA is NOT a county-level dataset. Which of Actual MTSP and HERA
    -- Special applies to a LIHTC project depends on the project's
    -- placed-in-service date: pre-2009 projects use HERA, newer ones use
    -- Actual. For Jackson County it runs $2,350-$3,760 above Actual at 50-80%.
    -- The program matrix does not carry placed-in-service dates, so every
    -- program stays on HUD-MTSP and this standard exists for a caseworker
    -- looking at a specific older building.
    ('HUD-MTSP-HERA', 'MTSP HERA Special income limits',
     'U.S. Department of Housing and Urban Development', 'AMI',
     'Applies only to LIHTC projects placed in service before 2009 (Housing and Economic '
     'Recovery Act). Not selectable by county — the project''s placed-in-service date decides. '
     'No program is routed here by default.',
     'https://www.huduser.gov/portal/datasets/mtsp.html#data_2026', true,
     'Annually, around 1 May, alongside MTSP', 'Owners must implement within 45 days'),

    ('HUD-HTF', 'Housing Trust Fund income limits',
     'U.S. Department of Housing and Urban Development', 'AMI',
     'A single extremely-low-income figure per county (the greater of 30% AMI or the poverty '
     'guideline), published for the national Housing Trust Fund. Stored at tier 30.',
     'https://www.huduser.gov/portal/datasets/HTF-Income-limits.html', false,
     'Annually, with the HOME limits', 'Around 1 June'),

    ('HUD-HOME', 'HOME and CDBG income limits',
     'U.S. Department of Housing and Urban Development', 'AMI',
     'HOME Investment Partnerships and Community Development Block Grant programs. These are '
     'HUD''s adjusted HOME limits and differ from the Section 8 limits at the 30% tier.',
     'https://www.huduser.gov/portal/datasets/home-income-limits.html', false,
     'Annually, usually announced in spring', 'Around 1 June'),

    ('OHCS-MIRL', 'Moderate Income Rural Limit',
     'Oregon Housing and Community Services', 'AMI',
     'Oregon''s Moderate-Income Revolving Loan program. Tiers 50/80/100/120%. The 100% row is '
     'OHCS''s own median figure and the tiers are exact multiples of it.',
     'https://www.huduser.gov/portal/datasets/cdbg-income-limits.html', true,
     'Annually, with the HUD limits', 'Around 1 June'),

    ('OHCS-THGF', 'Tribal Housing Grant Fund income limits',
     'Oregon Housing and Community Services', 'AMI',
     'Oregon''s Tribal Housing Grant Fund. Same figures and tiers as MIRL in the 2026 workbook, '
     'kept as its own standard because it is a separately administered program that may diverge.',
     'https://www.huduser.gov/portal/datasets/cdbg-income-limits.html', true,
     'Annually, with the HUD limits', 'Effective 30 June')
on conflict (standard_id) do update
    set name = excluded.name,
        publisher = excluded.publisher,
        basis = excluded.basis,
        notes = excluded.notes,
        source_url = excluded.source_url,
        proportional = excluded.proportional,
        published_when = excluded.published_when,
        effective_when = excluded.effective_when;

-- ---------------------------------------------------------------------------
-- Rent limits
--
-- Kept apart from income_limits because the two are different shapes. Income
-- limits vary by household size; rent limits vary by bedroom count, and the
-- HOME/CDBG tab publishes several KINDS of rent for the same unit (Fair Market
-- Rent, High Rent Limit, Low Rent Limit). The rent_kind column carries that.
-- ---------------------------------------------------------------------------
create table if not exists rent_limits (
    rent_id        bigint generated always as identity primary key,
    standard_id    text not null references income_standards(standard_id) on delete cascade,
    area_id        text not null references income_areas(area_id) on delete cascade,
    tier_pct       numeric,                 -- NULL for rent kinds that are not tier-based
    rent_kind      text not null default 'max_rent',
    bedrooms       smallint not null check (bedrooms >= 0),
    amount         numeric not null check (amount >= 0),  -- monthly
    effective_date date not null,
    expires_date   date,
    source_url     text,
    notes          text,
    constraint rent_limits_date_range check (expires_date is null or expires_date > effective_date)
);

create unique index if not exists rent_limits_identity
    on rent_limits (standard_id, area_id, coalesce(tier_pct, -1), rent_kind, bedrooms, effective_date);

create index if not exists rent_limits_lookup
    on rent_limits (standard_id, area_id, bedrooms, effective_date desc);

alter table rent_limits enable row level security;
drop policy if exists "Public read access" on rent_limits;
create policy "Public read access" on rent_limits for select using (true);

create or replace view v_current_rent_limits as
select *
from rent_limits
where effective_date <= current_date
  and (expires_date is null or expires_date > current_date);
