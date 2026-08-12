#!/usr/bin/env python3
"""
Loads the Southern Oregon Housing Matrix CSV into Supabase (Postgres).

Run the migrations in supabase/migrations/ first (via `supabase db push`,
the Supabase CLI, or by pasting them into the SQL editor), then run this
script to populate the tables. It's safe to re-run: it truncates the
housing tables before reloading, so it always mirrors the CSV exactly.

Usage:
    export SUPABASE_DB_URL="postgresql://postgres:[PASSWORD]@db.[PROJECT-REF].supabase.co:5432/postgres"
    python scripts/load_data.py data/Southern_Oregon_Housing_Matrix_REVERIFIED.csv

Get SUPABASE_DB_URL from: Supabase dashboard -> Project Settings ->
Database -> Connection string (URI). Use the "Session pooler" or direct
connection string, not the anon/service_role API keys.
"""
import csv
import os
import re
import sys

import psycopg2
from psycopg2.extras import execute_values

COUNTY_NAMES = [
    'jackson', 'josephine', 'douglas', 'coos', 'curry', 'klamath', 'lane',
    'lincoln', 'linn', 'marion', 'clackamas', 'union',
]


def parse_counties(txt):
    """Split the free-text county field into normalized county names."""
    if not txt:
        return []
    t = txt.lower()
    found = []
    for c in COUNTY_NAMES:
        if re.search(r'\b' + c + r'\b', t):
            found.append(c.capitalize())
    if 'statewide' in t:
        for c in ['Jackson', 'Josephine']:
            if c not in found:
                found.append(c)
        found.append('Statewide')
    return found or ['Unspecified']


def num(v):
    if not v:
        return None
    m = re.search(r'\d+(?:\.\d+)?', str(v))
    return float(m.group()) if m else None


def has_form(url, notes):
    """A real form exists only if we have a direct file link, not just a program page."""
    if not url:
        return False
    u = url.lower()
    if u.endswith('.pdf') or 'form-or-home' in u:
        return True
    blob = (url + ' ' + (notes or '')).lower()
    for neg in ['no standing', 'no downloadable', 'no application', 'not available',
                'no applicant-facing', 'no separate form', 'no customer-facing', 'no form']:
        if neg in blob:
            return False
    if 'portals/applicant' in u:  # live application portal counts
        return True
    return False


def load_rows(src_path):
    with open(src_path, newline='', encoding='utf-8') as f:
        rows = list(csv.reader(f))
    hdr = rows[1]
    idx = {c: i for i, c in enumerate(hdr)}
    data = rows[2:]
    g = lambda r, c: r[idx[c]].strip() if c in idx and idx[c] < len(r) else ''
    return data, g


# Whether a program measures income against STATE median income or the county's
# AREA median. Getting this wrong is a silent, consequential error: 60% SMI for
# a two-person household is $50,194 while Josephine County's 60% AMI is $40,140,
# so testing a utility applicant against the county figure wrongly rejects them.
#
# Category alone is not enough — the RVAR/OAR homebuyer program sits under Down
# Payment Assistance but tests against "the State of Oregon Median Income Limit"
# — so the program's own income-standard text decides.
SMI_PATTERN = re.compile(r'\bSMI\b|state median|state of oregon median|oregon median', re.I)


def income_standard_for(income_standard_text, category):
    """Returns (standard_id, area_id). A NULL area means the applicant's county."""
    if SMI_PATTERN.search(income_standard_text or ''):
        return 'OR-SMI', 'OR'
    if (category or '').strip() == 'Utility Reduction':
        return 'OR-SMI', 'OR'
    return 'HUD-MFI', None


def build_batches(data, g):
    programs, counties, forms, contacts, eligibility, verification = [], [], [], [], [], []
    income_rules = []
    seen_counties = set()

    for r in data:
        pid = g(r, 'Program ID')
        if not pid:
            continue

        programs.append((
            pid, g(r, 'Program Name'), g(r, 'Category'), g(r, 'Administrator'),
            g(r, 'Application Status'), g(r, 'Application Window'), g(r, 'Benefit Type'),
            g(r, 'Maximum Benefit'), g(r, 'Benefit Frequency'), g(r, 'Application Method'),
            g(r, 'Required Documents'), g(r, 'Priority Factors'),
            g(r, 'Other Hard Disqualifiers'), g(r, 'Internal Notes'), g(r, 'Source URL'),
        ))

        for c in parse_counties(g(r, 'Eligible Counties')):
            key = (pid, c)
            if key not in seen_counties:
                seen_counties.add(key)
                counties.append(key)

        url, notes = g(r, 'Application Form URL'), g(r, 'Form Notes')
        forms.append((pid, url, notes, has_form(url, notes)))

        contacts.append((
            pid, g(r, 'Phone'), g(r, 'Email'), g(r, 'Address'),
            g(r, 'Intake Hours'), g(r, 'Service Area Detail'),
        ))

        eligibility.append((
            pid, num(g(r, 'AMI Min %')), num(g(r, 'AMI Max %')), g(r, 'Income Standard'),
            g(r, 'Eligible Tenure'), g(r, 'Eligibility Summary'), g(r, 'Veteran Rule'),
            g(r, 'Age Rule'), g(r, 'Disability Rule'), g(r, 'Children / Pregnancy Rule'),
            g(r, 'Crisis / Displacement Required'), g(r, 'First-Time Homebuyer Required'),
            g(r, 'Utility Account Required'),
        ))

        verification.append((
            pid, g(r, 'Research Confidence'), g(r, 'Last Verified'), g(r, 'Research Date'),
            g(r, 'Primary Source Type'), g(r, 'Secondary Source URL'),
            g(r, 'Data Gaps / Follow-Up'), g(r, 'Reverification Notes'),
            g(r, 'Availability / Waitlist Notes'),
        ))

        standard_id, area_id = income_standard_for(g(r, 'Income Standard'), g(r, 'Category'))
        income_rules.append((
            pid, standard_id, area_id,
            num(g(r, 'AMI Min %')), num(g(r, 'AMI Max %')),
            g(r, 'Income Standard') or None,
        ))

    return programs, counties, forms, contacts, eligibility, verification, income_rules


def main():
    if len(sys.argv) < 2:
        print('Usage: python scripts/load_data.py <path-to-csv>')
        sys.exit(1)

    src_path = sys.argv[1]
    if not os.path.exists(src_path):
        print(f'CSV not found: {src_path}')
        sys.exit(1)

    db_url = os.environ.get('SUPABASE_DB_URL')
    if not db_url:
        print('Set the SUPABASE_DB_URL environment variable (see .env.example).')
        sys.exit(1)

    data, g = load_rows(src_path)
    (programs, counties, forms, contacts, eligibility, verification,
     income_rules) = build_batches(data, g)

    conn = psycopg2.connect(db_url)
    try:
        with conn.cursor() as cur:
            # Fresh load every run: clear rows but keep schema, indexes, and RLS policies intact.
            cur.execute(
                'truncate forms, program_counties, contacts, eligibility, '
                'verification, program_income_rules, programs restart identity cascade;'
            )

            execute_values(cur, """
                insert into programs (
                    program_id, program_name, category, administrator,
                    application_status, application_window, benefit_type,
                    max_benefit, benefit_frequency, application_method,
                    required_documents, priority_factors, other_disqualifiers,
                    internal_notes, source_url
                ) values %s
            """, programs)

            if counties:
                execute_values(cur, """
                    insert into program_counties (program_id, county) values %s
                    on conflict do nothing
                """, counties)

            execute_values(cur, """
                insert into forms (program_id, form_url, form_notes, has_real_form)
                values %s
            """, forms)

            execute_values(cur, """
                insert into contacts (
                    program_id, phone, email, address, intake_hours, service_area
                ) values %s
            """, contacts)

            execute_values(cur, """
                insert into eligibility (
                    program_id, ami_min, ami_max, income_standard, eligible_tenure,
                    summary, veteran_rule, age_rule, disability_rule, children_rule,
                    crisis_required, first_time_buyer, utility_required
                ) values %s
            """, eligibility)

            execute_values(cur, """
                insert into verification (
                    program_id, confidence, last_verified, research_date,
                    primary_source, secondary_url, data_gaps, reverif_notes,
                    waitlist_notes
                ) values %s
            """, verification)

            execute_values(cur, """
                insert into program_income_rules (
                    program_id, standard_id, area_id, tier_min_pct, tier_max_pct, notes
                ) values %s
            """, income_rules)

        conn.commit()

        with conn.cursor() as cur:
            def one(q):
                cur.execute(q)
                return cur.fetchone()[0]

            print('programs      :', one('select count(*) from programs'))
            print('SMI-tested    :', one(
                "select count(*) from program_income_rules where standard_id = 'OR-SMI'"))
            print('AMI-tested    :', one(
                "select count(*) from program_income_rules where standard_id = 'HUD-MFI'"))
            print('counties rows :', one('select count(*) from program_counties'))
            print('real forms    :', one('select count(*) from forms where has_real_form'))
            print('needs attn    :', one('select count(*) from v_needs_attention'))
            print()
            print('by category:')
            cur.execute("""
                select coalesce(nullif(category, ''), '(unset)'), count(*)
                from programs group by 1 order by 2 desc
            """)
            for cat, n in cur.fetchall():
                print(f'   {cat:<28} {n}')
            print()
            print('by county:')
            cur.execute('select county, count(*) from program_counties group by 1 order by 2 desc')
            for c, n in cur.fetchall():
                print(f'   {c:<14} {n}')
    finally:
        conn.close()

    print('\nLoad complete.')


if __name__ == '__main__':
    main()
