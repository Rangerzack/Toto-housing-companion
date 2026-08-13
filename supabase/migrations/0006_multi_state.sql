-- Multi-state support
--
-- County names are not unique across states. Oregon and Minnesota both have a
-- Douglas County, and both have Jackson and Lincoln. program_counties.county
-- was a bare name and the screener matched on it alone, so loading a second
-- state would surface Minnesota programs to Oregon residents of the same-named
-- county. Every county now carries the state it belongs to.
--
-- Also adds an active flag. The St. Cloud matrix documents entries that are not
-- assistance a person can apply for — discontinued funds, referral desks,
-- "shutoff protection (NOT a payment program)". They are worth keeping as
-- records but must never appear in results.

alter table program_counties add column if not exists state_code text;
alter table programs add column if not exists is_active boolean not null default true;
alter table programs add column if not exists inactive_reason text;

-- Which state's matrix a program came from. load_data.py used to truncate every
-- program table on each run, which was fine with one dataset but would delete
-- Oregon the moment Minnesota loaded. The loader now clears only the state it
-- is loading, and needs this column to know which rows those are.
alter table programs add column if not exists state_code text;

-- Everything loaded before this migration is Oregon.
update program_counties set state_code = 'OR' where state_code is null;
update programs set state_code = 'OR' where state_code is null;

create index if not exists idx_pc_state on program_counties(state_code, county);
create index if not exists idx_prog_active on programs(is_active);

-- ---------------------------------------------------------------------------
-- Minnesota reference data
-- ---------------------------------------------------------------------------
insert into income_standards (standard_id, name, publisher, basis, notes, source_url) values
    ('MN-SMI', 'Minnesota State Median Income', 'U.S. Department of Health and Human Services', 'SMI',
     'Basis for the Minnesota Energy Assistance Program (EAP) and the utility affordability programs that key off it. '
     'Distinct from OR-SMI: a "60% SMI" test means a different dollar figure in each state, so the standard must travel '
     'with the program.',
     'https://liheapch.acf.gov/profiles/povertytables/FY2026/mnsmi.htm')
on conflict (standard_id) do nothing;

insert into income_areas (area_id, name, area_type, state_code, county_fips) values
    ('MN',              'Minnesota',              'state',  'MN', null),
    ('MN-STEARNS',      'Stearns County, MN',     'county', 'MN', '27145'),
    ('MN-BENTON',       'Benton County, MN',      'county', 'MN', '27009'),
    ('MN-SHERBURNE',    'Sherburne County, MN',   'county', 'MN', '27141'),
    ('MN-MORRISON',     'Morrison County, MN',    'county', 'MN', '27097'),
    ('MN-WRIGHT',       'Wright County, MN',      'county', 'MN', '27171'),
    ('MN-TODD',         'Todd County, MN',        'county', 'MN', '27153'),
    ('MN-ISANTI',       'Isanti County, MN',      'county', 'MN', '27059'),
    ('MN-KANABEC',      'Kanabec County, MN',     'county', 'MN', '27065'),
    ('MN-MILLE-LACS',   'Mille Lacs County, MN',  'county', 'MN', '27095'),
    ('MN-KANDIYOHI',    'Kandiyohi County, MN',   'county', 'MN', '27067'),
    ('MN-DOUGLAS',      'Douglas County, MN',     'county', 'MN', '27041'),
    ('MN-CROW-WING',    'Crow Wing County, MN',   'county', 'MN', '27035'),
    ('MN-POPE',         'Pope County, MN',        'county', 'MN', '27121'),
    ('MN-CASS',         'Cass County, MN',        'county', 'MN', '27021'),
    ('MN-CHISAGO',      'Chisago County, MN',     'county', 'MN', '27025'),
    ('MN-RAMSEY',       'Ramsey County, MN',      'county', 'MN', '27123')
on conflict (area_id) do nothing;

-- Reports counties that arrived without a state, which would match across state
-- lines. Should always be empty.
create or replace view v_counties_missing_state as
select program_id, county
from program_counties
where state_code is null;
