-- Reporting views: which programs test against which income dataset.
--
-- The classification is derived from each program's own income-standard prose
-- at load time, so it needs to be reviewable without reading code. These views
-- are the answer to "why is this program being measured against that table?"
-- and to "did anything get classified oddly after the last load?".

-- ---------------------------------------------------------------------------
-- One row per program, with the dataset it uses and the text that decided it.
-- ---------------------------------------------------------------------------
create or replace view v_program_datasets as
select
    p.state_code,
    p.program_id,
    p.program_name,
    p.category,
    p.administrator,

    -- What it is measured against
    r.standard_id,
    s.name          as standard_name,
    s.basis,                                   -- AMI | SMI | OTHER
    s.publisher,
    r.tier_max_pct,
    r.tier_min_pct,
    coalesce(r.area_id, 'applicant county') as area,

    -- Whether an income test actually applies. A NULL tier means no threshold
    -- was ever stated, so the screener applies no income test at all rather
    -- than inventing one.
    case
        when r.tier_max_pct is not null then 'income test applied'
        else 'no income test'
    end as income_test,

    -- The evidence. This is the column to read when a classification looks
    -- wrong: it is the program's own wording, verbatim.
    e.income_standard as source_text,
    e.ami_min,
    e.ami_max,

    p.is_active,
    p.inactive_reason,
    s.source_url    as dataset_source_url,

    (select string_agg(pc.county, '; ' order by pc.county)
       from program_counties pc
      where pc.program_id = p.program_id
        and pc.state_code = p.state_code) as counties
from programs p
left join program_income_rules r on r.program_id = p.program_id
left join income_standards s     on s.standard_id = r.standard_id
left join eligibility e          on e.program_id = p.program_id;

-- ---------------------------------------------------------------------------
-- Summary: how many programs sit on each dataset, per state.
-- ---------------------------------------------------------------------------
create or replace view v_dataset_usage as
select
    coalesce(standard_id, '(none)') as standard_id,
    coalesce(basis, '-')            as basis,
    state_code,
    count(*)                                            as programs,
    count(*) filter (where is_active)                   as active,
    count(*) filter (where income_test = 'income test applied') as with_income_test,
    string_agg(distinct tier_max_pct::text, ', '
               order by tier_max_pct::text)             as tiers_used
from v_program_datasets
group by 1, 2, 3;

-- ---------------------------------------------------------------------------
-- Review queue: classifications worth a human look.
--
-- Not errors — these are the cases where the loader had thin evidence, and
-- where a wrong answer would be invisible otherwise.
-- ---------------------------------------------------------------------------
create or replace view v_dataset_review as
select state_code, program_id, program_name, standard_id, tier_max_pct,
       source_text,
       case
           -- Says one thing, classified as another.
           when source_text ~* 'SMI|state median' and standard_id !~ 'SMI'
                then 'mentions state median income but is not on an SMI table'
           when source_text ~* 'federal poverty|poverty guideline|\mFPG\M|\mFPL\M'
                and standard_id <> 'HHS-FPG'
                then 'mentions poverty guidelines but is not on HHS-FPG'
           -- Claims a threshold nobody captured.
           when tier_max_pct is null
                and source_text ~* '\m\d{2,3}\s*%'
                then 'states a percentage but no tier was parsed'
           -- On a dataset that has no figures loaded for it yet.
           when tier_max_pct is not null and not exists (
                   select 1 from income_limits il
                    where il.standard_id = v_program_datasets.standard_id)
                then 'dataset has no limits loaded'
           else null
       end as concern
from v_program_datasets
where is_active;
