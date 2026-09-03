-- User accounts: profiles, saved opportunities, recently viewed
--
-- Everything before this migration is public reference data: the program
-- matrix and its income limits, readable by anyone with the publishable key
-- (0002_rls_public_read.sql). This migration adds the first tables that hold
-- PERSONAL data, so the access rules invert: every row here is private to one
-- account, and row-level security is what enforces it. The publishable key
-- alone can read nothing in these tables — a request must carry a signed JWT
-- from Supabase Auth, and it only ever sees rows whose user_id matches.
--
-- Screening stays anonymous. Nobody has to make an account to use the
-- screener; an account only adds a saved profile, matches computed from it,
-- and a list of things worth coming back to.
--
-- Idempotent, like every migration here: safe to re-run.

begin;

-- ---------------------------------------------------------------------------
-- profiles
-- ---------------------------------------------------------------------------
-- One row per account, holding the answers the matcher needs plus the contact
-- details a caseworker would ask for. The column set is deliberately close to
-- the screener's own `answers` model (web/app.js), because the matching engine
-- is shared: web/profile.js adapts a row here into the same shape the
-- anonymous wizard produces, so both paths run through one matcher.
--
-- Only what matching or contact actually needs is collected. Notably absent:
-- date of birth (an age BAND answers every age rule in the data — 24, 60, 62
-- and 65 are the only thresholds any program uses), social security numbers,
-- immigration status, and exact addresses.
create table if not exists profiles (
    -- The account IS the profile: one row per user, enforced structurally
    -- rather than by a unique constraint on a separate surrogate key.
    user_id uuid primary key references auth.users(id) on delete cascade,

    -- --- Basic information ---------------------------------------------
    first_name        text,
    last_name         text,
    phone             text,
    -- Email lives in auth.users and is not duplicated here: two copies drift,
    -- and the authoritative one is the address the person signs in with.
    contact_preference text check (contact_preference in ('email', 'phone', 'text')),
    -- Bands, not a birth date. These boundaries come from the age rules the
    -- programs actually publish (youth up to 24; 60+, 62+, 65+ for senior
    -- programs; "non-elderly, under 62").
    age_range text check (age_range in
        ('under-25', '25-54', '55-59', '60-61', '62-64', '65-plus')),

    -- --- Household ------------------------------------------------------
    household_size  integer check (household_size between 1 and 20),
    adults_count    integer check (adults_count between 0 and 20),
    children_count  integer check (children_count between 0 and 20),
    -- Pregnancy is collected because a real gate depends on it: several
    -- programs' children_rule reads "children in the household or pregnancy".
    is_pregnant     boolean,
    dependents_count integer check (dependents_count between 0 and 20),
    household_composition text check (household_composition in
        ('single', 'couple', 'single-parent', 'two-parent', 'multigenerational',
         'roommates', 'other')),

    -- --- Housing --------------------------------------------------------
    -- Mirrors the screener's tenure vocabulary so matchesTenure() can read it.
    housing_status text check (housing_status in
        ('renting', 'homeowner', 'buying', 'unhoused', 'staying-with-others',
         'transitional', 'other')),
    at_risk_of_homelessness boolean,
    current_rent   numeric(10, 2) check (current_rent >= 0 and current_rent < 100000),
    desired_rent   numeric(10, 2) check (desired_rent >= 0 and desired_rent < 100000),
    -- Service area. state + counties are what the program matcher screens on;
    -- cities and ZIPs narrow rental listings.
    state              text check (state in ('OR', 'MN')),
    preferred_counties text[] check (coalesce(array_length(preferred_counties, 1), 0) <= 30),
    preferred_cities   text[] check (coalesce(array_length(preferred_cities, 1), 0) <= 30),
    preferred_zips     text[] check (coalesce(array_length(preferred_zips, 1), 0) <= 30),
    housing_type text check (housing_type in
        ('apartment', 'house', 'duplex', 'townhouse', 'manufactured', 'any')),
    bedrooms_needed  integer check (bedrooms_needed between 0 and 8),
    bathrooms_needed integer check (bathrooms_needed between 0 and 8),
    move_in_timeframe text check (move_in_timeframe in
        ('immediately', 'within-30-days', 'one-to-three-months',
         'three-to-six-months', 'just-looking')),

    -- --- Financial ------------------------------------------------------
    -- Annual GROSS is canonical, exactly as in the screener: it is the figure
    -- programs publish limits against. The UI takes a monthly figure too and
    -- multiplies by twelve before it lands here.
    annual_income numeric(12, 2) check (annual_income >= 0 and annual_income < 10000000),
    -- Which way the person prefers to enter and read it back.
    income_period text check (income_period in ('year', 'month')),
    income_sources text[] check (coalesce(array_length(income_sources, 1), 0) <= 20),
    employment_status text check (employment_status in
        ('employed-full-time', 'employed-part-time', 'self-employed',
         'unemployed', 'retired', 'disabled', 'student', 'other')),
    benefits text[] check (coalesce(array_length(benefits, 1), 0) <= 30),

    -- --- Eligibility circumstances --------------------------------------
    -- One column per structured gate the program matrix carries
    -- (eligibility.veteran_rule, age_rule, disability_rule, children_rule,
    -- crisis_required, first_time_buyer, utility_required). Null means "not
    -- answered", which the matcher treats as unknown — never as "no".
    is_veteran        boolean,
    has_disability    boolean,
    is_first_time_buyer boolean,
    has_utility_account boolean,
    in_crisis         boolean,

    -- --- Support needs --------------------------------------------------
    -- Free vocabulary of the help someone is looking for; drives which result
    -- groups lead the dashboard.
    support_needs text[] check (coalesce(array_length(support_needs, 1), 0) <= 20),

    -- --- Meta -----------------------------------------------------------
    -- Set once the person has finished every section. The percentage itself is
    -- computed in web/profile.js from the shared field list rather than stored,
    -- so it can never drift from the form the person actually sees.
    profile_completed boolean not null default false,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),

    -- Guards against a client stuffing the row with junk. Cheap here, and it
    -- means the API cannot be used as free storage.
    constraint profiles_name_length check (
        coalesce(length(first_name), 0) <= 120 and coalesce(length(last_name), 0) <= 120
    ),
    constraint profiles_phone_length check (coalesce(length(phone), 0) <= 40)
);

-- ---------------------------------------------------------------------------
-- saved_opportunities / viewed_opportunities
-- ---------------------------------------------------------------------------
-- Two kinds of thing can be saved, and they are stored differently on purpose:
--
--   program  — lives in this database, so only its id is kept and the current
--              details are read live. A program that changes its phone number
--              should not show a stale one from the day it was saved.
--   listing  — comes from the Range Lab API and is not in any table here, so a
--              small snapshot (name, rent, link) is kept to render the card
--              after the listing leaves the feed. Rentals turn over fast.
create table if not exists saved_opportunities (
    id         bigint generated always as identity primary key,
    user_id    uuid not null references auth.users(id) on delete cascade,
    kind       text not null check (kind in ('program', 'listing')),
    program_id text references programs(program_id) on delete cascade,
    listing_id text,
    snapshot   jsonb,
    note       text check (coalesce(length(note), 0) <= 2000),
    created_at timestamptz not null default now(),

    constraint saved_ref_matches_kind check (
        (kind = 'program' and program_id is not null and listing_id is null) or
        (kind = 'listing' and listing_id is not null and program_id is null)
    )
);

create table if not exists viewed_opportunities (
    id         bigint generated always as identity primary key,
    user_id    uuid not null references auth.users(id) on delete cascade,
    kind       text not null check (kind in ('program', 'listing')),
    program_id text references programs(program_id) on delete cascade,
    listing_id text,
    snapshot   jsonb,
    viewed_at  timestamptz not null default now(),

    constraint viewed_ref_matches_kind check (
        (kind = 'program' and program_id is not null and listing_id is null) or
        (kind = 'listing' and listing_id is not null and program_id is null)
    )
);

-- One row per person per thing. The expression index is what makes the
-- client's upsert (on conflict) work across both kinds.
create unique index if not exists idx_saved_unique
    on saved_opportunities (user_id, kind, coalesce(program_id, listing_id));
create unique index if not exists idx_viewed_unique
    on viewed_opportunities (user_id, kind, coalesce(program_id, listing_id));

create index if not exists idx_saved_user   on saved_opportunities (user_id, created_at desc);
create index if not exists idx_viewed_user  on viewed_opportunities (user_id, viewed_at desc);

-- ---------------------------------------------------------------------------
-- updated_at
-- ---------------------------------------------------------------------------
create or replace function set_updated_at()
returns trigger
language plpgsql
-- Pinned search_path: a SECURITY DEFINER-adjacent function that resolves
-- unqualified names through a caller-controlled path is a privilege-escalation
-- route, and Supabase's own security advisor flags it.
set search_path = ''
as $$
begin
    new.updated_at = now();
    return new;
end;
$$;

drop trigger if exists profiles_set_updated_at on profiles;
create trigger profiles_set_updated_at
    before update on profiles
    for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- Profile row on signup
-- ---------------------------------------------------------------------------
-- Created server-side rather than by the client, so a profile always exists
-- the moment an account does. Without this the app would have to handle "signed
-- in but no row yet" everywhere, and a failed first write would leave an
-- account with nowhere to save anything.
create or replace function handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
    insert into public.profiles (user_id)
    values (new.id)
    on conflict (user_id) do nothing;
    return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
    after insert on auth.users
    for each row execute function handle_new_user();

-- Both functions above exist only to be fired by their triggers. Postgres
-- grants EXECUTE to public by default, which in Supabase means they are also
-- reachable as REST endpoints (/rest/v1/rpc/handle_new_user) — and
-- handle_new_user is SECURITY DEFINER, so it runs as its owner. Calling it
-- outside a trigger errors on the unassigned NEW record rather than doing
-- anything useful, but an unauthenticated caller should not be able to reach a
-- definer function at all.
revoke execute on function handle_new_user() from public, anon, authenticated;
revoke execute on function set_updated_at() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
-- The whole security model for personal data is here. Every policy is scoped
-- to auth.uid(), the id inside the request's JWT, which a client cannot forge:
-- it is signed by the project's secret. So a signed-in person reads and writes
-- exactly their own row and nobody else's, and an anonymous request (the
-- publishable key with no JWT) matches nothing at all.
--
-- `with check` matters as much as `using`: without it someone could UPDATE
-- their own row and set user_id to another account, handing themselves a row
-- they then could not read but had written into.
alter table profiles             enable row level security;
alter table saved_opportunities  enable row level security;
alter table viewed_opportunities enable row level security;

drop policy if exists "Own profile read"   on profiles;
drop policy if exists "Own profile insert" on profiles;
drop policy if exists "Own profile update" on profiles;
drop policy if exists "Own profile delete" on profiles;

create policy "Own profile read"   on profiles for select using (auth.uid() = user_id);
create policy "Own profile insert" on profiles for insert with check (auth.uid() = user_id);
create policy "Own profile update" on profiles for update
    using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "Own profile delete" on profiles for delete using (auth.uid() = user_id);

drop policy if exists "Own saved read"   on saved_opportunities;
drop policy if exists "Own saved insert" on saved_opportunities;
drop policy if exists "Own saved update" on saved_opportunities;
drop policy if exists "Own saved delete" on saved_opportunities;

create policy "Own saved read"   on saved_opportunities for select using (auth.uid() = user_id);
create policy "Own saved insert" on saved_opportunities for insert with check (auth.uid() = user_id);
create policy "Own saved update" on saved_opportunities for update
    using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "Own saved delete" on saved_opportunities for delete using (auth.uid() = user_id);

drop policy if exists "Own viewed read"   on viewed_opportunities;
drop policy if exists "Own viewed insert" on viewed_opportunities;
drop policy if exists "Own viewed update" on viewed_opportunities;
drop policy if exists "Own viewed delete" on viewed_opportunities;

create policy "Own viewed read"   on viewed_opportunities for select using (auth.uid() = user_id);
create policy "Own viewed insert" on viewed_opportunities for insert with check (auth.uid() = user_id);
create policy "Own viewed update" on viewed_opportunities for update
    using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "Own viewed delete" on viewed_opportunities for delete using (auth.uid() = user_id);

commit;
