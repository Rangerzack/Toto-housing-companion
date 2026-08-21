-- When each dataset is republished.
--
-- This was living in documentation, which meant a report could not carry it
-- and nobody querying the database could see when a figure was due to change.
-- It belongs next to the standard it describes.
--
-- The columns themselves are created in 0009, which owns v_program_datasets
-- and therefore has to know about every column the view exposes. This file
-- only fills them in. (An earlier revision redefined the view here too, which
-- left 0009 unable to re-run — "create or replace view" cannot drop columns.)
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
