#!/usr/bin/env python3
"""
Loads published rent limits into the rent_limits table.

Same behaviour as load_income_limits.py: upserts rather than truncates, so
limits accumulate across years and a corrected file fixes figures in place.
Unknown standard_id or area_id values abort the load.

    python scripts/load_rent_limits.py data/rent_limits_ohcs_or.csv

CSV columns:

    standard_id     required   e.g. HUD-MTSP, HUD-HOME
    area_id         required   e.g. OR-JACKSON
    tier_pct        optional   50, 60, 80 — blank for kinds that are not tier-based
    rent_kind       required   max_rent | fair_market_rent | high_rent | low_rent | max_rent_75pct_0br
    bedrooms        required   0-6
    amount          required   monthly dollars
    effective_date  required   2026-05-01
    expires_date    optional
    source_url      optional
    notes           optional
"""
import csv
import os
import re
import sys

import psycopg2
from psycopg2.extras import execute_values

REQUIRED = ['standard_id', 'area_id', 'rent_kind', 'bedrooms', 'amount', 'effective_date']


def money(value):
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
                continue
            try:
                tier = blank_to_none(row.get('tier_pct'))
                rows.append((
                    row['standard_id'].strip(),
                    row['area_id'].strip(),
                    float(tier) if tier else None,
                    row['rent_kind'].strip(),
                    int(row['bedrooms']),
                    money(row['amount']),
                    row['effective_date'].strip(),
                    blank_to_none(row.get('expires_date')),
                    blank_to_none(row.get('source_url')),
                    blank_to_none(row.get('notes')),
                ))
            except (ValueError, KeyError) as error:
                raise SystemExit(f'Line {line_no}: {error}')
        return rows


def main():
    if len(sys.argv) < 2:
        print('Usage: python scripts/load_rent_limits.py <path-to-csv>')
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
                sys.exit(1)

            execute_values(cur, """
                insert into rent_limits (
                    standard_id, area_id, tier_pct, rent_kind, bedrooms, amount,
                    effective_date, expires_date, source_url, notes
                ) values %s
                on conflict (standard_id, area_id, coalesce(tier_pct, -1), rent_kind,
                             bedrooms, effective_date)
                do update set
                    amount = excluded.amount,
                    expires_date = excluded.expires_date,
                    source_url = excluded.source_url,
                    notes = excluded.notes
            """, rows)
        conn.commit()

        with conn.cursor() as cur:
            cur.execute('select count(*) from rent_limits')
            print(f'rent_limits rows: {cur.fetchone()[0]} (loaded/updated {len(rows)})')
            cur.execute("""
                select standard_id, area_id, rent_kind, count(*), max(effective_date)
                from rent_limits group by 1, 2, 3 order by 1, 2, 3
            """)
            print()
            print(f'{"standard":<16} {"area":<14} {"kind":<22} {"rows":>5}  latest')
            for s, a, k, n, d in cur.fetchall():
                print(f'{s:<16} {a:<14} {k:<22} {n:>5}  {d}')
    finally:
        conn.close()
    print('\nLoad complete.')


if __name__ == '__main__':
    main()
