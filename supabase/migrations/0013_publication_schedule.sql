-- When each dataset is republished.
--
-- This was living in documentation, which meant a report could not carry it
-- and nobody querying the database could see when a figure was due to change.
-- It belongs next to the standard it describes.
alter table income_standards add column if not exists published_when text;
alter table income_standards add column if not exists effective_when text;

update income_standards set
    published_when = 'Annually, usually announced in spring',
    effective_when = 'Around 1 June'
where standard_id = 'HUD-MFI';

update income_standards set
    published_when = 'Annually, around 1 May',
    effective_when = 'Owners must implement within 45 days, by mid-June'
where standard_id = 'HUD-MTSP';

update income_standards set
    published_when = 'Each federal fiscal year, issued by HHS over the summer',
    effective_when = '1 October'
where standard_id in ('OR-SMI', 'MN-SMI');

update income_standards set
    published_when = 'Each January, in the Federal Register',
    effective_when = 'On publication'
where standard_id = 'HHS-FPG';

update income_standards set
    published_when = 'Each federal fiscal year, issued as a procedure notice (FY2026 was PN 657, 13 July 2026)',
    effective_when = 'On the date of the notice'
where standard_id in ('USDA-502-GUARANTEED', 'USDA-502-DIRECT');

-- A PHA republishes on its own timing after HUD issues new limits, which is
-- the whole reason these are tracked separately from HUD-MFI.
update income_standards set
    published_when = 'Republished by the housing authority after HUD issues new limits; timing is theirs',
    effective_when = 'As posted by the authority (currently 1 May 2026)'
where standard_id = 'HAJC-HCV';

update income_standards set
    published_when = 'Republished by the housing authority after HUD issues new limits; timing is theirs',
    effective_when = 'As posted by the authority (currently 1 April 2025 — likely stale, confirm with JHCDC)'
where standard_id = 'JHCDC-HCV';

update income_standards set
    published_when = 'Published periodically by OHCS',
    effective_when = 'Not established — no machine-readable table located'
where standard_id = 'OHCS-BOND';

-- Surface the schedule wherever the dataset is reported.
--
-- Column ORDER must match 0009 exactly, with the two new columns appended at
-- the end: "create or replace view" can add trailing columns but cannot rename
-- or reorder existing ones. Reordering here fails with "cannot change name of
-- view column", and dropping the view instead would take v_dataset_usage and
-- v_dataset_review with it, since 0009 defines those against this one.
create or replace view v_program_datasets as
select
    p.state_code,
    p.program_id,
    p.program_name,
    p.category,
    p.administrator,

    r.standard_id,
    s.name          as standard_name,
    s.basis,
    s.publisher,
    r.tier_max_pct,
    r.tier_min_pct,
    coalesce(r.area_id, 'applicant county') as area,

    case
        when r.tier_max_pct is not null then 'income test applied'
        else 'no income test'
    end as income_test,

    e.income_standard as source_text,
    e.ami_min,
    e.ami_max,

    p.is_active,
    p.inactive_reason,
    s.source_url    as dataset_source_url,

    (select string_agg(pc.county, '; ' order by pc.county)
       from program_counties pc
      where pc.program_id = p.program_id
        and pc.state_code = p.state_code) as counties,

    -- appended, per the note above
    s.published_when,
    s.effective_when
from programs p
left join program_income_rules r on r.program_id = p.program_id
left join income_standards s     on s.standard_id = r.standard_id
left join eligibility e          on e.program_id = p.program_id;
