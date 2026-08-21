-- Each public housing authority publishes its own income limits.
--
-- Section 8 eligibility is determined by the PHA administering the voucher, so
-- a voucher program follows its own authority's table rather than HUD's
-- dataset. HAJC covers Jackson County (0011); this adds Josephine.
--
-- Two things differ from HAJC and are worth knowing before reading the figures:
--
--   * JHCDC publishes MONTHLY limits. The amounts here are those figures times
--     twelve, because income_limits stores annual amounts throughout. The
--     conversion is exact against what they publish.
--
--   * Their posted table is dated 2025-04-01 and runs roughly 1.4% above HUD's
--     FY2026 limits for the Grants Pass MSA. A PHA is expected to implement
--     HUD's current limits, so this most likely means the page has not been
--     updated rather than that Josephine genuinely uses higher thresholds.
--     It is loaded as published, with its stated effective date, because that
--     is what an applicant would be told — but it is worth confirming with
--     JHCDC directly, and v_dataset_review will keep surfacing it while the
--     date stays old.
insert into income_standards
    (standard_id, name, publisher, basis, notes, source_url, proportional)
values
    ('JHCDC-HCV', 'JHCDC Housing Choice Voucher income limits',
     'Josephine Housing and Community Development Council', 'AMI',
     'Published monthly by the administering housing authority and stored here annualised '
     '(monthly x 12). Posted table is dated 2025-04-01 and sits above HUD''s FY2026 figures for '
     'Grants Pass, which probably means the page is out of date — confirm with JHCDC before '
     'relying on it for a determination.',
     'https://jhcdc.net/applicants/', false)
on conflict (standard_id) do update
    set name = excluded.name,
        publisher = excluded.publisher,
        notes = excluded.notes,
        source_url = excluded.source_url;
