#!/usr/bin/env python3
"""
Fetches income limits from HUD's API and writes a CSV for load_income_limits.py.

Needs a free token from https://www.huduser.gov/portal/dataset/fmr-api.html in
the HUD_API_TOKEN environment variable.

    python scripts/fetch_hud_limits.py --year 2026 --out data/hud_2026.csv
    python scripts/fetch_hud_limits.py --probe            # dump one raw response

--probe prints the untouched JSON for a single county. Use it when a run fails
or when moving to a new dataset: it is faster to read HUD's actual field names
than to guess at them.

Only stdlib is used so this adds no dependency to the workflow.
"""
import argparse
import csv
import json
import os
import re
import sys
import urllib.error
import urllib.request

API_ROOT = 'https://www.huduser.gov/hudapi/public'

# The counties this project serves, mapped to the area_id used in income_areas.
COUNTY_FIPS_TO_AREA = {
    '41005': 'OR-CLACKAMAS',
    '41011': 'OR-COOS',
    '41015': 'OR-CURRY',
    '41019': 'OR-DOUGLAS',
    '41029': 'OR-JACKSON',
    '41033': 'OR-JOSEPHINE',
    '41035': 'OR-KLAMATH',
    '41039': 'OR-LANE',
    '41041': 'OR-LINCOLN',
    '41043': 'OR-LINN',
    '41047': 'OR-MARION',
    '41061': 'OR-UNION',
}

STANDARD_BY_DATASET = {'il': 'HUD-MFI', 'mtsp': 'HUD-MTSP'}


def call(path, token):
    request = urllib.request.Request(
        f'{API_ROOT}/{path}',
        headers={'Authorization': f'Bearer {token}', 'User-Agent': 'southern-oregon-housing'},
    )
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            return json.loads(response.read().decode('utf-8'))
    except urllib.error.HTTPError as error:
        body = error.read().decode('utf-8', 'replace')[:400]
        raise SystemExit(f'HUD API {error.code} on /{path}\n{body}')


def entity_id(fips):
    """HUD identifies a county as its 5-digit FIPS padded with 99999."""
    return f'{fips}99999'


TIER_KEY = re.compile(r'^il(\d+)_p(\d+)$')


def collect_tiers(node, found=None):
    """
    Walks the response for il<tier>_p<size> keys wherever they live.

    HUD groups them under 'very_low' / 'extremely_low' / 'low' rather than
    flat on 'data', and the grouping differs between datasets, so this scans
    rather than assuming a shape.
    """
    if found is None:
        found = {}
    if isinstance(node, dict):
        for key, value in node.items():
            match = TIER_KEY.match(key) if isinstance(key, str) else None
            if match and value is not None:
                tier, size = int(match.group(1)), int(match.group(2))
                found.setdefault(tier, {})[size] = int(value)
            else:
                collect_tiers(value, found)
    elif isinstance(node, list):
        for item in node:
            collect_tiers(item, found)
    return found


def tier_rows(payload, area_id, dataset, year):
    """Turns one county response into loader rows."""
    data = payload.get('data', payload)
    rows = []

    tiers = collect_tiers(data)
    found_any = False

    # Note on the 30% tier: HUD's "extremely low" figure is the GREATER of 30%
    # of median or the federal poverty guideline, so for larger households it
    # steps above a straight 30% and will not match the HOME table's 30% row.
    # The API value is the canonical one.
    for tier, by_size in sorted(tiers.items()):
        values = [by_size.get(size) for size in range(1, 9)]
        if any(v is None for v in values):
            print(f'  {area_id}: tier {tier} has gaps, skipping')
            continue
        found_any = True
        for size, amount in enumerate(values, start=1):
            rows.append({
                'standard_id': STANDARD_BY_DATASET[dataset],
                'area_id': area_id,
                'tier_pct': tier,
                'household_size_min': size,
                'household_size_max': size,
                'amount': amount,
                'effective_date': f'{year}-06-01',
                'expires_date': '',
                'variant': '',
                'source_url': 'https://www.huduser.gov/portal/datasets/il.html',
                'notes': f'HUD API {dataset.upper()} FY{year}'
                         + (' (extremely low = greater of 30% AMI or poverty guideline)'
                            if tier == 30 else ''),
            })

        # HUD defines the 60% tier as 1.2x the very-low-income figure, and the
        # published tables match that exactly. Deriving it keeps LIHTC/LIFT-style
        # 60% tests answerable without a second request.
        if tier == 50:
            for size, amount in enumerate(values, start=1):  # noqa: PLW2901
                rows.append({
                    'standard_id': STANDARD_BY_DATASET[dataset],
                    'area_id': area_id,
                    'tier_pct': 60,
                    'household_size_min': size,
                    'household_size_max': size,
                    'amount': round(amount * 1.2),
                    'effective_date': f'{year}-06-01',
                    'expires_date': '',
                    'variant': '',
                    'source_url': 'https://www.huduser.gov/portal/datasets/il.html',
                    'notes': f'Derived as 1.2x the FY{year} very-low-income figure, per HUD',
                })

    if not found_any:
        print(f'  no recognised tier fields for {area_id}; keys were: {sorted(data)[:20]}')
    return rows


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--year', default='2026')
    parser.add_argument('--dataset', default='il', choices=sorted(STANDARD_BY_DATASET))
    parser.add_argument('--out', default='data/hud_limits.csv')
    parser.add_argument('--probe', action='store_true',
                        help='print one raw county response and exit')
    args = parser.parse_args()

    token = os.environ.get('HUD_API_TOKEN')
    if not token:
        print('Set HUD_API_TOKEN (free from huduser.gov).')
        sys.exit(1)

    if args.probe:
        sample = entity_id('41029')  # Jackson County
        payload = call(f'{args.dataset}/data/{sample}?year={args.year}', token)
        print(json.dumps(payload, indent=2)[:4000])
        return

    all_rows = []
    for fips, area_id in sorted(COUNTY_FIPS_TO_AREA.items()):
        print(f'fetching {area_id} ({fips})...')
        payload = call(f'{args.dataset}/data/{entity_id(fips)}?year={args.year}', token)
        rows = tier_rows(payload, area_id, args.dataset, args.year)
        print(f'  {len(rows)} rows')
        all_rows.extend(rows)

    if not all_rows:
        print('No rows produced. Re-run with --probe to see what HUD returned.')
        sys.exit(1)

    os.makedirs(os.path.dirname(args.out) or '.', exist_ok=True)
    with open(args.out, 'w', newline='', encoding='utf-8') as handle:
        writer = csv.DictWriter(handle, fieldnames=list(all_rows[0]))
        writer.writeheader()
        writer.writerows(all_rows)

    areas = len({r['area_id'] for r in all_rows})
    print(f'\nWrote {len(all_rows)} rows across {areas} areas to {args.out}')


if __name__ == '__main__':
    main()
