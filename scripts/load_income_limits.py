#!/usr/bin/env python3
"""
Loads published income limits into the income_limits table.

Unlike load_data.py, this does NOT truncate: income limits accumulate over
time, and older rows stay so past determinations remain reproducible. Rows are
upserted on (standard_id, area_id, tier_pct, household size bracket,
effective_date, variant), so re-running with a corrected file fixes the figure
in place rather than duplicating it.

Usage:
    export SUPABASE_DB_URL="postgresql://..."
    python scripts/load_income_limits.py data/income_limits_template.csv

CSV columns (see data/income_limits_template.csv):

    standard_id         required   e.g. HUD-MFI, OR-SMI, USDA-502-DIRECT
    area_id             required   e.g. OR-JACKSON, OR
    tier_pct            required   30, 50, 60, 80, 100, 115
    household_size_min  required   1
    household_size_max  required   1  (use 1 and 4 for a "1-4 person" bracket)
    amount              required   34350   ($ signs and commas are fine)
    effective_date      required   2026-05-01
    expires_date        optional
    variant             optional   targeted_area, guaranteed, direct
    source_url          optional
    notes               optional
"""
import csv
import os
import re
import sys

import psycopg2
from psycopg2.extras import execute_values

REQUIRED = [
    'standard_id',
    'area_id',
    'tier_pct',
    'household_size_min',
    'household_size_max',
    'amount',
    'effective_date',
]


def money(value):
    """'$34,350' and '34350.00' both mean the same thing."""
    cleaned = re.sub(r'[^\d.]', '', str(value or ''))
    if not cleaned:
        raise ValueError('missing amount')
    return float(cleaned)


def blank_to_none(value):
    value = (value or '').strip()
    return value or None


def read_rows(path):
    with open(path, newline='', encoding='utf-8-sig') as handle:
        reader = csv.DictReader(handle)

        missing = [c for c in REQUIRED if c not in (reader.fieldnames or [])]
        if missing:
            raise SystemExit(f'CSV is missing required column(s): {", ".join(missing)}')

        rows = []
        for line_no, row in enumerate(reader, start=2):
            if not (row.get('standard_id') or '').strip():
                continue  # skip blank padding lines
            try:
                size_min = int(row['household_size_min'])
                size_max = int(row['household_size_max'])
                if size_max < size_min:
                    raise ValueError('household_size_max is below household_size_min')
                rows.append((
                    row['standard_id'].strip(),
                    row['area_id'].strip(),
                    float(row['tier_pct']),
                    size_min,
                    size_max,
                    money(row['amount']),
                    row['effective_date'].strip(),
                    blank_to_none(row.get('expires_date')),
                    blank_to_none(row.get('variant')),
                    blank_to_none(row.get('source_url')),
                    blank_to_none(row.get('notes')),
                ))
            except (ValueError, KeyError) as error:
                raise SystemExit(f'Line {line_no}: {error}')
        return rows


def main():
    if len(sys.argv) < 2:
        print('Usage: python scripts/load_income_limits.py <path-to-csv>')
        sys.exit(1)

    src_path = sys.argv[1]
    if not os.path.exists(src_path):
        print(f'CSV not found: {src_path}')
        sys.exit(1)

    db_url = os.environ.get('SUPABASE_DB_URL')
    if not db_url:
        print('Set the SUPABASE_DB_URL environment variable (see .env.example).')
        sys.exit(1)

    rows = read_rows(src_path)
    if not rows:
        print('No rows found in the CSV.')
        sys.exit(1)

    conn = psycopg2.connect(db_url)
    try:
        with conn.cursor() as cur:
            # Fails loudly on an unknown standard or area rather than silently
            # loading figures nobody can look up.
            cur.execute('select standard_id from income_standards')
            known_standards = {r[0] for r in cur.fetchall()}
            cur.execute('select area_id from income_areas')
            known_areas = {r[0] for r in cur.fetchall()}

            bad_standards = sorted({r[0] for r in rows} - known_standards)
            bad_areas = sorted({r[1] for r in rows} - known_areas)
            if bad_standards or bad_areas:
                if bad_standards:
                    print(f'Unknown standard_id(s): {", ".join(bad_standards)}')
                if bad_areas:
                    print(f'Unknown area_id(s): {", ".join(bad_areas)}')
                print('Add them to income_standards / income_areas first.')
                sys.exit(1)

            execute_values(cur, """
                insert into income_limits (
                    standard_id, area_id, tier_pct, household_size_min,
                    household_size_max, amount, effective_date, expires_date,
                    variant, source_url, notes
                ) values %s
                on conflict (standard_id, area_id, tier_pct, household_size_min,
                             household_size_max, effective_date, coalesce(variant, ''))
                do update set
                    amount = excluded.amount,
                    expires_date = excluded.expires_date,
                    source_url = excluded.source_url,
                    notes = excluded.notes
            """, rows)

        conn.commit()

        with conn.cursor() as cur:
            cur.execute('select count(*) from income_limits')
            print(f'income_limits rows: {cur.fetchone()[0]} (loaded/updated {len(rows)})')

            cur.execute("""
                select standard_id, area_id, tier_pct, count(*), max(effective_date)
                from income_limits
                group by 1, 2, 3
                order by 1, 2, 3
            """)
            print()
            print(f'{"standard":<22} {"area":<14} {"tier":>5} {"rows":>5}  latest')
            for standard, area, tier, count, latest in cur.fetchall():
                print(f'{standard:<22} {area:<14} {tier:>5} {count:>5}  {latest}')
    finally:
        conn.close()

    print('\nLoad complete.')


if __name__ == '__main__':
    main()
