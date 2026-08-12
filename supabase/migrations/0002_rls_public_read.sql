-- Row Level Security for the housing tables.
--
-- Supabase exposes every table to its auto-generated REST/JS API. If RLS is
-- left off, that's an open door for anon+service keys alike; if it's turned
-- on with no policy, all access is denied by default. This migration turns
-- it on and adds a public SELECT-only policy, appropriate for reference data
-- like this housing matrix that the client app just needs to read.
--
-- Writes (INSERT/UPDATE/DELETE) are intentionally left with no policy, so
-- only requests using the service_role key (e.g. scripts/load_data.py) can
-- modify data. If you want anon/authenticated users to write too, add
-- explicit "for insert"/"for update" policies below.
--
-- Skip or edit this file if your app manages access differently.

alter table programs         enable row level security;
alter table program_counties enable row level security;
alter table forms            enable row level security;
alter table contacts         enable row level security;
alter table eligibility      enable row level security;
alter table verification     enable row level security;

-- Dropped first so this file stays re-runnable. It used to rely on
-- 0001_init.sql having just dropped the tables (which took their policies with
-- them); now that 0001 preserves data, these have to clean up after themselves.
drop policy if exists "Public read access" on programs;
drop policy if exists "Public read access" on program_counties;
drop policy if exists "Public read access" on forms;
drop policy if exists "Public read access" on contacts;
drop policy if exists "Public read access" on eligibility;
drop policy if exists "Public read access" on verification;

create policy "Public read access" on programs         for select using (true);
create policy "Public read access" on program_counties for select using (true);
create policy "Public read access" on forms             for select using (true);
create policy "Public read access" on contacts           for select using (true);
create policy "Public read access" on eligibility         for select using (true);
create policy "Public read access" on verification       for select using (true);
