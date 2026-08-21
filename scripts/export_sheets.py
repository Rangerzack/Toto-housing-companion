#!/usr/bin/env python3
"""
Pushes the current datasets to a Google Sheet, one tab per view.

Runs at the end of every data-load workflow so the sheet never drifts from the
database. Each tab is fully replaced — it is a mirror, not a log.

Needs:
    SUPABASE_DB_URL       read access to the database
    GOOGLE_SHEET_ID       the sheet to write into (from its URL)
    GOOGLE_SA_JSON        a service-account key, as JSON text; the sheet must
                          be shared with that account's email as Editor

    python scripts/export_sheets.py
    python scripts/export_sheets.py --csv-dir out/    # write CSVs instead, no Google needed
"""
import argparse
import csv
import json
import os
import sys
from datetime import date, datetime, timezone
from decimal import Decimal

import psycopg2

# Tab name -> query. Column names become the header row.
TABS = {
    'Programs & datasets': """
        select state_code, program_id, program_name, category, administrator,
               standard_id, standard_name, basis, publisher, tier_max_pct,
               area, income_test, counties, dataset_source_url,
               published_when, effective_when, is_active, inactive_reason,
               source_text
        from v_program_datasets
        order by state_code, standard_id nulls last, program_id
    """,
    'Income limits': """
        select l.standard_id, s.name as standard_name, l.area_id, a.name as area_name,
               l.tier_pct, l.household_size, l.amount, l.effective_date,
               l.expires_date, l.variant, l.source_url
        from v_income_limits_by_size l
        join income_standards s on s.standard_id = l.standard_id
        join income_areas a on a.area_id = l.area_id
        order by l.standard_id, l.area_id, l.tier_pct, l.household_size, l.effective_date
    """,
    'Rent limits': """
        select r.standard_id, s.name as standard_name, r.area_id, a.name as area_name,
               r.tier_pct, r.rent_kind, r.bedrooms, r.amount, r.effective_date,
               r.expires_date, r.source_url
        from rent_limits r
        join income_standards s on s.standard_id = r.standard_id
        join income_areas a on a.area_id = r.area_id
        order by r.standard_id, r.area_id, r.rent_kind, r.tier_pct, r.bedrooms, r.effective_date
    """,
    'Standards': """
        select standard_id, name, publisher, basis, proportional,
               published_when, effective_when, source_url, notes
        from income_standards
        order by standard_id
    """,
    'Areas': """
        select area_id, name, area_type, state_code, county_fips
        from income_areas
        order by state_code nulls first, area_id
    """,
    'Dataset usage': """
        select standard_id, basis, state_code, programs, active,
               with_income_test, tiers_used
        from v_dataset_usage
        order by programs desc, standard_id
    """,
}


def cell(value):
    """Sheets wants JSON-native types; Postgres hands back a few that are not."""
    if value is None:
        return ''
    if isinstance(value, Decimal):
        return float(value) if value % 1 else int(value)
    if isinstance(value, (date, datetime)):
        return value.isoformat()
    return value


def fetch_all(db_url):
    conn = psycopg2.connect(db_url)
    try:
        tables = {}
        with conn.cursor() as cur:
            for name, sql in TABS.items():
                cur.execute(sql)
                header = [d[0] for d in cur.description]
                rows = [[cell(v) for v in row] for row in cur.fetchall()]
                tables[name] = [header] + rows
                print(f'  {name:<22} {len(rows):>5} rows')
        return tables
    finally:
        conn.close()


def write_csvs(tables, out_dir):
    os.makedirs(out_dir, exist_ok=True)
    for name, grid in tables.items():
        path = os.path.join(out_dir, name.replace(' & ', '_').replace(' ', '_').lower() + '.csv')
        with open(path, 'w', newline='', encoding='utf-8') as handle:
            csv.writer(handle).writerows(grid)
    print(f'wrote {len(tables)} CSVs to {out_dir}')


def write_sheet(tables, sheet_id, sa_json):
    # Imported here so the CSV path needs no Google libraries at all.
    import gspread
    from google.oauth2.service_account import Credentials

    creds = Credentials.from_service_account_info(
        json.loads(sa_json),
        scopes=['https://www.googleapis.com/auth/spreadsheets'],
    )
    book = gspread.authorize(creds).open_by_key(sheet_id)
    existing = {ws.title: ws for ws in book.worksheets()}

    stamp = datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')

    for name, grid in tables.items():
        rows, cols = len(grid), len(grid[0])
        ws = existing.get(name)
        if ws is None:
            ws = book.add_worksheet(title=name, rows=rows + 1, cols=cols)
        else:
            ws.clear()
            ws.resize(rows=max(rows + 1, 1), cols=cols)
        ws.update(grid, 'A1', value_input_option='RAW')
        ws.freeze(rows=1)
        print(f'  updated tab: {name}')

    # A small "About" tab so anyone opening the sheet knows what they are
    # looking at and how fresh it is.
    about = [
        ['Toto Housing Companion — income and rent limits'],
        [''],
        ['Last refreshed', stamp],
        ['Source', 'Mirrored automatically from the project database after each data load.'],
        ['Do not edit', 'Every tab is replaced on the next refresh. Edits here will be lost.'],
        [''],
        ['Tab', 'What it holds'],
        ['Programs & datasets', 'Every program, the income dataset it is tested against, and why'],
        ['Income limits', 'Every published income figure, expanded to one row per household size'],
        ['Rent limits', 'Every published rent figure, by bedroom count'],
        ['Standards', 'The datasets themselves: publisher, source URL, when they republish'],
        ['Areas', 'Counties and states the limits are keyed to'],
        ['Dataset usage', 'How many programs sit on each dataset'],
        [''],
        ['Method and rationale', 'docs/SOP-income-standards.md in the repository'],
    ]
    ws = existing.get('About') or book.add_worksheet(title='About', rows=30, cols=2)
    ws.clear()
    ws.update(about, 'A1', value_input_option='RAW')

    # Put About first so it is what opens.
    book.reorder_worksheets([ws] + [w for w in book.worksheets() if w.title != 'About'])
    print(f'sheet refreshed at {stamp}')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--csv-dir', help='write CSVs here instead of pushing to Google')
    args = parser.parse_args()

    db_url = os.environ.get('SUPABASE_DB_URL')
    if not db_url:
        print('Set SUPABASE_DB_URL.')
        sys.exit(1)

    print('querying...')
    tables = fetch_all(db_url)

    if args.csv_dir:
        write_csvs(tables, args.csv_dir)
        return

    sheet_id = os.environ.get('GOOGLE_SHEET_ID')
    sa_json = os.environ.get('GOOGLE_SA_JSON')
    if not sheet_id or not sa_json:
        print('Set GOOGLE_SHEET_ID and GOOGLE_SA_JSON, or pass --csv-dir.')
        sys.exit(1)
    write_sheet(tables, sheet_id, sa_json)


if __name__ == '__main__':
    main()
