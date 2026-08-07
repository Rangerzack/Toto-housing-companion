-- Southern Oregon Housing Matrix — core schema
-- Postgres/Supabase port of the original SQLite schema.
-- Normalized so the data can be queried by category, county, form
-- availability, and verification status.

begin;

drop view if exists v_needs_attention;
drop view if exists v_program_overview;

drop table if exists program_counties cascade;
drop table if exists forms cascade;
drop table if exists contacts cascade;
drop table if exists eligibility cascade;
drop table if exists verification cascade;
drop table if exists programs cascade;

create table programs (
    program_id           text primary key,
    program_name         text not null,
    category              text,
    administrator         text,
    application_status    text,
    application_window    text,
    benefit_type          text,
    max_benefit           text,
    benefit_frequency     text,
    application_method    text,
    required_documents    text,
    priority_factors      text,
    other_disqualifiers   text,
    internal_notes        text,
    source_url            text
);

create table program_counties (
    program_id text not null references programs(program_id) on delete cascade,
    county     text not null,
    primary key (program_id, county)
);

create table forms (
    form_id       bigint generated always as identity primary key,
    program_id    text not null references programs(program_id) on delete cascade,
    form_url      text,
    form_notes    text,
    has_real_form boolean not null default false  -- true = downloadable/official form exists
);

create table contacts (
    program_id   text primary key references programs(program_id) on delete cascade,
    phone        text,
    email        text,
    address      text,
    intake_hours text,
    service_area text
);

create table eligibility (
    program_id        text primary key references programs(program_id) on delete cascade,
    ami_min           numeric,
    ami_max           numeric,
    income_standard   text,
    eligible_tenure   text,
    summary           text,
    veteran_rule      text,
    age_rule          text,
    disability_rule   text,
    children_rule     text,
    crisis_required   text,
    first_time_buyer  text,
    utility_required  text
);

create table verification (
    program_id     text primary key references programs(program_id) on delete cascade,
    confidence     text,
    last_verified  text,
    research_date  text,
    primary_source text,
    secondary_url  text,
    data_gaps      text,
    reverif_notes  text,
    waitlist_notes text
);

create index idx_pc_county  on program_counties(county);
create index idx_prog_cat   on programs(category);
create index idx_forms_real on forms(has_real_form);
create index idx_ver_conf   on verification(confidence);

create view v_program_overview as
select p.program_id, p.program_name, p.category, p.administrator,
       p.application_status,
       (select string_agg(pc.county, '; ') from program_counties pc
         where pc.program_id = p.program_id) as counties,
       e.ami_max, e.summary as eligibility_summary,
       ct.phone, ct.intake_hours,
       f.form_url, f.has_real_form,
       v.confidence, v.last_verified
from programs p
left join eligibility  e  on e.program_id  = p.program_id
left join contacts     ct on ct.program_id = p.program_id
left join forms        f  on f.program_id  = p.program_id
left join verification v  on v.program_id  = p.program_id;

create view v_needs_attention as
select p.program_id, p.program_name, v.confidence, v.data_gaps, v.last_verified
from programs p
join verification v on v.program_id = p.program_id
where v.confidence like 'Low%' or coalesce(v.data_gaps, '') <> ''
order by v.confidence;

commit;
