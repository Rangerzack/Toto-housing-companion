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

# County names are NOT unique across states — Oregon and Minnesota both have a
# Douglas County, and both have Jackson and Lincoln. Every county therefore
# carries its state, and "statewide" expands only within the state being
# loaded. Without that scoping a statewide Minnesota program would attach
# itself to Oregon counties.
STATES = {
    'OR': {
        'counties': [
            'jackson', 'josephine', 'douglas', 'coos', 'curry', 'klamath', 'lane',
            'lincoln', 'linn', 'marion', 'clackamas', 'union',
        ],
        # Counties a "statewide" program is treated as covering — the ones this
        # screener actually serves, not every county in the state.
        'statewide': ['Jackson', 'Josephine'],
        'smi_standard': 'OR-SMI',
        'smi_area': 'OR',
    },
    'MN': {
        'counties': [
            'stearns', 'benton', 'sherburne', 'morrison', 'wright', 'todd',
            'isanti', 'kanabec', 'mille lacs', 'kandiyohi', 'douglas',
            'crow wing', 'pope', 'cass', 'chisago', 'ramsey',
        ],
        'statewide': ['Stearns', 'Benton', 'Sherburne'],
        # Several St. Cloud programs state their service area as a city rather
        # than a county ("City of St. Cloud only"). Without these they land in
        # Unspecified and show for the whole state. St. Cloud itself straddles
        # three counties, so it maps to all three.
        'cities': {
            'st. cloud': ['Stearns', 'Benton', 'Sherburne'],
            'st cloud': ['Stearns', 'Benton', 'Sherburne'],
            'waite park': ['Stearns'],
            'st. joseph': ['Stearns'],
            'st. augusta': ['Stearns'],
            'melrose': ['Stearns'],
            'sartell': ['Stearns'],
            'sauk rapids': ['Benton'],
            'foley': ['Benton'],
            'elk river': ['Sherburne'],
            'zimmerman': ['Sherburne'],
            'big lake': ['Sherburne'],
            'otsego': ['Sherburne'],
            'braham': ['Isanti'],
            'st. paul': ['Ramsey'],
        },
        'smi_standard': 'MN-SMI',
        'smi_area': 'MN',
    },
}


def parse_counties(txt, state):
    """Split the free-text county field into (county, state) pairs."""
    config = STATES[state]
    if not txt:
        return [('Unspecified', state)]

    t = txt.lower()
    found = []
    for c in config['counties']:
        if re.search(r'\b' + re.escape(c) + r'\b', t):
            found.append(c.title())

    for city, city_counties in config.get('cities', {}).items():
        if re.search(r'\b' + re.escape(city) + r'\b', t):
            for c in city_counties:
                if c not in found:
                    found.append(c)

    if 'statewide' in t:
        for c in config['statewide']:
            if c not in found:
                found.append(c)
        found.append('Statewide')

    return [(c, state) for c in (found or ['Unspecified'])]


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
SMI_PATTERN = re.compile(r'\bSMI\b|state median|state of \w+ median|oregon median|minnesota median', re.I)

# "50% State Median Income" — the tier is often only in the prose, because the
# AMI Min/Max columns read "N/A (uses State Median Income, not AMI)" for the
# Minnesota programs. Without this they would carry no income test at all.
SMI_TIER_PATTERN = re.compile(r'(\d{2,3})\s*%\s*(?:of\s*)?(?:the\s*)?(?:state median|smi)', re.I)

# A third basis. Several St. Cloud programs test at 200% of the federal poverty
# guidelines rather than against any median income.
FPG_PATTERN = re.compile(r'federal poverty|poverty guideline|\bFPG\b|\bFPL\b', re.I)
FPG_TIER_PATTERN = re.compile(
    r'(\d{2,3})\s*%\s*(?:of\s*)?(?:the\s*)?(?:federal\s*)?poverty|'
    r'(?:federal\s*)?poverty\s*(?:guidelines?|level)[^.]{0,20}?(\d{2,3})\s*%', re.I)

# FPG is national: one table for the 48 contiguous states, separate ones for
# Alaska and Hawaii. Both states loaded here are in the contiguous 48.
FPG_AREA_BY_STATE = {'AK': 'US-AK', 'HI': 'US-HI'}


# USDA publishes its own limits, and they are not HUD's. For 22 of 24 Oregon
# area/tier combinations the two agree exactly, but Grants Pass runs about 1.4%
# higher at every tier and bracket — so a USDA program measured against the HUD
# table would be wrong there and right everywhere else, which is the hardest
# kind of error to notice.
USDA_PATTERN = re.compile(r'\bUSDA\b|section 502|rural development|rural housing', re.I)


# Some programs are measured against a table their administering agency
# publishes, not against the national dataset it derives from. Section 8
# eligibility is determined by the housing authority, so the Jackson County
# voucher programs follow HAJC's published limits.
#
# These cannot be inferred from the income-standard prose — it says "50% AMI",
# which is true of both HUD's table and HAJC's — so the authority is recorded
# explicitly. NED vouchers are drawn from the same waiting list and HAJC states
# they use the same limits.
PROGRAM_STANDARD_OVERRIDES = {
    'HAJC-HCV-OR-001': ('HAJC-HCV', 'OR-JACKSON'),
    'HAJC-NED-OR-001': ('HAJC-HCV', 'OR-JACKSON'),
}


def income_standard_for(income_standard_text, category, state, program_name='', program_id=''):
    """Returns (standard_id, area_id). A NULL area means the applicant's county."""
    if program_id in PROGRAM_STANDARD_OVERRIDES:
        return PROGRAM_STANDARD_OVERRIDES[program_id]

    config = STATES[state]
    text = income_standard_text or ''

    if USDA_PATTERN.search(f'{program_name} {text}'):
        return 'USDA-502-GUARANTEED', None

    # SMI is checked FIRST, and the order matters. Minnesota's Energy
    # Assistance Program tests at 50% SMI but its write-up also says "sizes
    # 19-20 use 110% FPG" — an edge case for very large households. Reading
    # that mention as the primary standard drops a four-person limit from
    # $71,998 to $33,000 and turns away families the program is built for.
    # Programs that genuinely test on poverty level do not mention SMI at all.
    if SMI_PATTERN.search(text):
        return config['smi_standard'], config['smi_area']
    if FPG_PATTERN.search(text):
        return 'HHS-FPG', FPG_AREA_BY_STATE.get(state, 'US-48')
    if (category or '').strip() == 'Utility Reduction':
        return config['smi_standard'], config['smi_area']
    return 'HUD-MFI', None


def tier_from_text(income_standard_text, standard_id):
    """
    The percentage a program tests at, when only the prose states it.

    The AMI columns read "N/A (uses State Median Income, not AMI)" for these
    programs, so without this they would carry no income test at all.
    """
    text = income_standard_text or ''
    if standard_id == 'HHS-FPG':
        match = FPG_TIER_PATTERN.search(text)
        if match:
            return float(match.group(1) or match.group(2))
        return 100.0  # a bare "poverty guidelines" reference means the guideline itself
    match = SMI_TIER_PATTERN.search(text)
    return float(match.group(1)) if match else None


# Entries that document something real but are not assistance a person can
# apply for. Showing these in results wastes a call someone may not have the
# minutes for, so they load with is_active = false and never reach the screener.
INACTIVE_PATTERNS = [
    (re.compile(r'\bdiscontinued\b', re.I), 'Discontinued'),
    # "ended" on its own, because the phrasing varies and the earlier
    # "program ended" pattern missed "Closed- Program seems to of ended".
    # Note this must NOT catch a seasonal closure: the Energy Assistance
    # programs read "CLOSED for FFY26; reopens 2026-10-01" and are very much
    # alive, which is why the test is "ended" rather than "closed".
    (re.compile(r'\bended\b|closed permanently|no longer', re.I), 'Program ended'),
    (re.compile(r'not a (funding|payment) program', re.I), 'Not a funding program'),
    (re.compile(r'does not cover utilities', re.I), 'Does not cover utilities'),
    (re.compile(r'referral and navigation|navigation and counselling', re.I),
     'Referral or navigation only'),
    (re.compile(r'system access point', re.I), 'Access point, not a program'),
]


def inactive_reason_for(*fields):
    """First reason this row is not an applyable program, or None."""
    blob = ' '.join(f for f in fields if f)
    for pattern, reason in INACTIVE_PATTERNS:
        if pattern.search(blob):
            return reason
    return None


def build_batches(data, g, state):
    programs, counties, forms, contacts, eligibility, verification = [], [], [], [], [], []
    income_rules = []
    seen_counties = set()

    for r in data:
        pid = g(r, 'Program ID')
        if not pid:
            continue

        inactive = inactive_reason_for(
            g(r, 'Category'), g(r, 'Application Status'), g(r, 'Program Name'))

        programs.append((
            pid, g(r, 'Program Name'), g(r, 'Category'), g(r, 'Administrator'),
            g(r, 'Application Status'), g(r, 'Application Window'), g(r, 'Benefit Type'),
            g(r, 'Maximum Benefit'), g(r, 'Benefit Frequency'), g(r, 'Application Method'),
            g(r, 'Required Documents'), g(r, 'Priority Factors'),
            g(r, 'Other Hard Disqualifiers'), g(r, 'Internal Notes'), g(r, 'Source URL'),
            inactive is None, inactive,
        ))

        for county, state_code in parse_counties(g(r, 'Eligible Counties'), state):
            key = (pid, county, state_code)
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

        standard_id, area_id = income_standard_for(
            g(r, 'Income Standard'), g(r, 'Category'), state,
            g(r, 'Program Name'), pid)
        tier_max = num(g(r, 'AMI Max %'))
        if tier_max is None and standard_id != 'HUD-MFI':
            tier_max = tier_from_text(g(r, 'Income Standard'), standard_id)
        income_rules.append((
            pid, standard_id, area_id,
            num(g(r, 'AMI Min %')), tier_max,
            g(r, 'Income Standard') or None,
        ))

    return programs, counties, forms, contacts, eligibility, verification, income_rules


def main():
    if len(sys.argv) < 2:
        print('Usage: python scripts/load_data.py <path-to-csv> [state]')
        print(f'       state defaults to OR; known: {", ".join(sorted(STATES))}')
        sys.exit(1)

    src_path = sys.argv[1]
    if not os.path.exists(src_path):
        print(f'CSV not found: {src_path}')
        sys.exit(1)

    state = (sys.argv[2] if len(sys.argv) > 2 else 'OR').upper()
    if state not in STATES:
        print(f'Unknown state "{state}". Known: {", ".join(sorted(STATES))}')
        print('Add it to STATES with its counties and SMI standard first.')
        sys.exit(1)

    db_url = os.environ.get('SUPABASE_DB_URL')
    if not db_url:
        print('Set the SUPABASE_DB_URL environment variable (see .env.example).')
        sys.exit(1)

    data, g = load_rows(src_path)
    (programs, counties, forms, contacts, eligibility, verification,
     income_rules) = build_batches(data, g, state)

    unspecified = sum(1 for _, county, _ in counties if county == 'Unspecified')
    if unspecified:
        print(f'WARNING: {unspecified} county entries did not match any known {state} '
              f'county and will show for every county in the state.')

    conn = psycopg2.connect(db_url)
    try:
        with conn.cursor() as cur:
            # Clear only this state. A truncate here would delete every other
            # state's programs, which is exactly what would happen the first
            # time a second matrix was loaded.
            cur.execute('delete from program_income_rules where program_id in '
                        '(select program_id from programs where state_code = %s)', (state,))
            cur.execute('delete from programs where state_code = %s', (state,))

            execute_values(cur, """
                insert into programs (
                    program_id, program_name, category, administrator,
                    application_status, application_window, benefit_type,
                    max_benefit, benefit_frequency, application_method,
                    required_documents, priority_factors, other_disqualifiers,
                    internal_notes, source_url, is_active, inactive_reason,
                    state_code
                ) values %s
            """, [row + (state,) for row in programs])

            if counties:
                execute_values(cur, """
                    insert into program_counties (program_id, county, state_code)
                    values %s
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

            print(f'loaded {state}   :', one(
                f"select count(*) from programs where state_code = '{state}'"))
            print('  active      :', one(
                f"select count(*) from programs where state_code = '{state}' and is_active"))
            print('  inactive    :', one(
                f"select count(*) from programs where state_code = '{state}' and not is_active"))
            print('all states    :', one('select count(*) from programs'))
            print('counties rows :', one('select count(*) from program_counties'))
            print('real forms    :', one('select count(*) from forms where has_real_form'))
            print('no state set  :', one('select count(*) from v_counties_missing_state'))
            print()
            print('programs by state:')
            cur.execute("""
                select coalesce(state_code, '(unset)'), count(*)
                from programs group by 1 order by 1
            """)
            for code, n in cur.fetchall():
                print(f'   {code:<6} {n}')
            print()
            print('income standard used:')
            cur.execute('select standard_id, count(*) from program_income_rules '
                        'group by 1 order by 2 desc')
            for standard, n in cur.fetchall():
                print(f'   {standard:<12} {n}')
            print()
            print(f'{state} programs held back as inactive:')
            cur.execute("select program_name, inactive_reason from programs "
                        "where state_code = %s and not is_active order by 1", (state,))
            for name, reason in cur.fetchall():
                print(f'   [{reason}] {name[:58]}')
            print()
            print(f'{state} counties:')
            cur.execute('select county, count(*) from program_counties '
                        'where state_code = %s group by 1 order by 2 desc', (state,))
            for c, n in cur.fetchall():
                print(f'   {c:<14} {n}')
    finally:
        conn.close()

    print('\nLoad complete.')


if __name__ == '__main__':
    main()
