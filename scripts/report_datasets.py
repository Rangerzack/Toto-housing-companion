#!/usr/bin/env python3
"""
Exports the program-to-dataset report.

Answers "which programs test against which income dataset, and why" straight
from the database, so the report is never a stale copy of something.

    export SUPABASE_DB_URL="postgresql://..."
    python scripts/report_datasets.py                     # summary to the console
    python scripts/report_datasets.py --csv report.csv    # full detail to a file

Reads the views in supabase/migrations/0009_dataset_report.sql. Run the
migrations first if they are missing.
"""
import argparse
import csv
import os
import sys

import psycopg2


def fetch(cur, sql):
    cur.execute(sql)
    return [d[0] for d in cur.description], cur.fetchall()


def print_table(title, columns, rows, widths=None):
    print(f'\n{title}')
    print('-' * len(title))
    if not rows:
        print('  (none)')
        return
    widths = widths or [
        max(len(str(c)), *(len(str(r[i])) for r in rows)) for i, c in enumerate(columns)
    ]
    widths = [min(w, 46) for w in widths]
    print('  ' + '  '.join(str(c)[:w].ljust(w) for c, w in zip(columns, widths)))
    print('  ' + '  '.join('-' * w for w in widths))
    for row in rows:
        print('  ' + '  '.join(str(v if v is not None else '')[:w].ljust(w)
                               for v, w in zip(row, widths)))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--csv', help='write the full per-program detail here')
    parser.add_argument('--state', help='limit to one state, e.g. OR')
    args = parser.parse_args()

    db_url = os.environ.get('SUPABASE_DB_URL')
    if not db_url:
        print('Set the SUPABASE_DB_URL environment variable (see .env.example).')
        sys.exit(1)

    where = ''
    params = ''
    if args.state:
        where = f" where state_code = '{args.state.upper()}'"
        params = f' ({args.state.upper()} only)'

    conn = psycopg2.connect(db_url)
    try:
        with conn.cursor() as cur:
            cols, rows = fetch(cur, f"""
                select standard_id, basis, state_code, programs, active,
                       with_income_test, tiers_used
                from v_dataset_usage{where}
                order by programs desc, standard_id
            """)
            print_table(f'Dataset usage{params}', cols, rows)

            cols, rows = fetch(cur, f"""
                select state_code, program_id, program_name, concern
                from v_dataset_review
                where concern is not null
                {'and' + where[6:] if where else ''}
                order by state_code, program_id
            """)
            print_table('Worth a look', cols, rows)
            if not rows:
                print('  Nothing flagged — every active program matches its own wording.')

            # Programs carrying no income test. The label they hold is
            # cosmetic in that case — no tier means no comparison is made —
            # but it is worth seeing how much of the catalogue is unscreened.
            cols, rows = fetch(cur, f"""
                select state_code,
                       coalesce(standard_id, '(none)') as labelled_as,
                       count(*) as programs
                from v_program_datasets
                where is_active and income_test = 'no income test'
                {'and' + where[6:] if where else ''}
                group by 1, 2 order by 3 desc
            """)
            print_table('Active programs with NO income test applied', cols, rows)
            print('  These pass everyone on income. The standard shown is the')
            print('  loader default, not a threshold anyone is measured against.')

            if args.csv:
                cols, rows = fetch(cur, f"""
                    select * from v_program_datasets{where}
                    order by state_code, standard_id nulls last, program_id
                """)
                with open(args.csv, 'w', newline='', encoding='utf-8') as handle:
                    writer = csv.writer(handle)
                    writer.writerow(cols)
                    writer.writerows(rows)
                print(f'\nWrote {len(rows)} rows to {args.csv}')
    finally:
        conn.close()


if __name__ == '__main__':
    main()
