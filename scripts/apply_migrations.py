#!/usr/bin/env python3
"""Applies every .sql file in supabase/migrations/, in order, to SUPABASE_DB_URL."""
import glob
import os
import sys

import psycopg2


def main():
    db_url = os.environ.get('SUPABASE_DB_URL')
    if not db_url:
        print('Set the SUPABASE_DB_URL environment variable (see .env.example).')
        sys.exit(1)

    conn = psycopg2.connect(db_url)
    conn.autocommit = True
    try:
        with conn.cursor() as cur:
            for path in sorted(glob.glob('supabase/migrations/*.sql')):
                print(f'Applying {path}...')
                with open(path, encoding='utf-8') as f:
                    cur.execute(f.read())
    finally:
        conn.close()

    print('Migrations applied.')


if __name__ == '__main__':
    main()
