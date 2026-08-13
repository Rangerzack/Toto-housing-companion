#!/usr/bin/env python3
"""
Rewrites the St. Cloud export into the canonical matrix layout.

The export's header row does not describe its own data. Three columns carry
values but were never named in the header:

  * index 4   the administrator's city ("Waite Park, MN")
  * index 52  a note on source independence, after Secondary Source URL
  * 60 and 61 an extra source URL and its description

So the data runs +1 out of step with the header from Eligible Counties, then
+2 from Research Confidence, and Reverification Notes ends up at index 62.
Loaded as-is, research dates land in form-URL fields and confidence values in
count fields.

This maps the data back onto the canonical column names and writes a file
load_data.py can read. Verified against the export: Email, Research
Confidence, and Research Date are type-plausible on 41 of 41 rows.

    python scripts/normalize_stcloud.py raw.csv data/st_cloud_matrix.csv
"""
import csv
import sys

# The canonical layout, matching the Southern Oregon matrix.
CANONICAL = [
    'Program ID', 'Program Name', 'Category', 'Administrator', 'Eligible Counties',
    'Eligible ZIP Codes', 'Application Status', 'Application Window', 'AMI Min %',
    'AMI Max %', 'Income Standard', 'Household Size Used?', 'Household Composition Rule',
    'Asset Limit', 'Eligible Tenure', 'Primary Residence Required',
    'Utility Account Required', 'Rent/Mortgage Arrears Required', 'Property Type Rule',
    'First-Time Homebuyer Required', 'Employment / Occupation Rule', 'Age Rule',
    'Disability Rule', 'Veteran Rule', 'Children / Pregnancy Rule', 'Credit Score Min',
    'DTI Max %', 'Home Price / Rent Cap', 'Citizenship / Immigration Rule',
    'Crisis / Displacement Required', 'Other Hard Disqualifiers', 'Benefit Type',
    'Maximum Benefit', 'Benefit Frequency', 'Priority Factors', 'Required Documents',
    'Application Method', 'Source URL', 'Last Verified', 'Verification Status',
    'Internal Notes', 'Phone', 'Email', 'Address', 'Online schedule link',
    'Intake Hours', 'Service Area Detail', 'Eligibility Summary',
    'Availability / Waitlist Notes', 'Primary Source Type', 'Secondary Source URL',
    'Research Confidence', 'Partner Listing Count', 'Partner Listing IDs',
    'Data Gaps / Follow-Up', 'Research Date', 'Application Form URL', 'Form Notes',
    'Reverification Notes',
]


def source_index(canonical_index):
    """Where a canonical column's value actually sits in the export."""
    if canonical_index <= 3:            # Program ID .. Administrator
        return canonical_index
    if canonical_index <= 50:           # Eligible Counties .. Secondary Source URL
        return canonical_index + 1
    if canonical_index <= 57:           # Research Confidence .. Form Notes
        return canonical_index + 2
    return 62                           # Reverification Notes


def main():
    if len(sys.argv) < 3:
        print('Usage: python scripts/normalize_stcloud.py <raw.csv> <out.csv>')
        sys.exit(1)

    with open(sys.argv[1], newline='', encoding='utf-8-sig') as handle:
        rows = list(csv.reader(handle))

    if len(rows) < 3:
        print('Expected a group header, a column header, and at least one program row.')
        sys.exit(1)

    header = rows[1]
    if header[:4] != CANONICAL[:4]:
        print(f'Unexpected leading columns: {header[:4]}')
        print('This file may not be the St. Cloud export; check before loading.')
        sys.exit(1)

    out = []
    for row in rows[2:]:
        if not (row and row[0].strip()):
            continue
        out.append([
            row[source_index(i)].strip() if source_index(i) < len(row) else ''
            for i in range(len(CANONICAL))
        ])

    with open(sys.argv[2], 'w', newline='', encoding='utf-8') as handle:
        writer = csv.writer(handle)
        # load_data.py reads rows[1] as the header, so keep the two-row shape.
        writer.writerow([''] * len(CANONICAL))
        writer.writerow(CANONICAL)
        writer.writerows(out)

    print(f'Wrote {len(out)} programs to {sys.argv[2]}')

    # Cheap type checks. These caught the misalignment in the first place, so
    # they run every time rather than living in a one-off script.
    def column(name):
        return [r[CANONICAL.index(name)] for r in out]

    checks = [
        ('Email', lambda v: '@' in v or not v or 'n/a' in v.lower() or 'not published' in v.lower()),
        ('Research Date', lambda v: not v or v[:4].isdigit()),
        ('Research Confidence', lambda v: not v or v.split()[0].rstrip('.').lower()
         in {'high', 'medium', 'moderate', 'low'}),
    ]
    for name, ok in checks:
        bad = [v for v in column(name) if not ok(v)]
        status = 'ok' if not bad else f'{len(bad)} suspicious'
        print(f'  {name:<20} {len(out) - len(bad)}/{len(out)} plausible  {status}')
        for value in bad[:3]:
            print(f'      {value[:70]}')


if __name__ == '__main__':
    main()
