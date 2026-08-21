-- The Housing Authority of Jackson County publishes its own income limits.
--
-- Section 8 eligibility is determined by the administering housing authority,
-- not by HUD's dataset directly. HAJC posts its table at
-- hajc.net/housing-programs/housing-choice-voucher/ and that is the figure an
-- applicant is actually measured against.
--
-- The numbers currently match HUD-MFI at 50% to the dollar, because a PHA
-- publishes HUD's Very Low Income limits for its jurisdiction. That is exactly
-- why leaving it pointed at HUD-MFI was easy to miss: it produces the right
-- answer until the two diverge. They can:
--
--   * effective dates differ already — HAJC posts 05/01/2026, HUD's income
--     limits dataset carries 06/01/2026
--   * a PHA can lag a HUD revision, or hold limits during a transition
--
-- Tracking the authority separately means the screener follows the agency that
-- makes the decision, and a divergence shows up as a data difference rather
-- than as a wrong answer nobody notices.
insert into income_standards
    (standard_id, name, publisher, basis, notes, source_url, proportional)
values
    ('HAJC-HCV', 'HAJC Housing Choice Voucher income limits',
     'Housing Authority of Jackson County', 'AMI',
     'Published by the administering housing authority for the Housing Choice Voucher and NED '
     'voucher programs. Matches HUD''s Very Low Income limits for the Medford MSA today, but is '
     'maintained separately because HAJC is the authority that determines eligibility and sets its '
     'own effective dates. Note the source page also carries a stale 2021 table further down under '
     'the FAQ — the current figures are the ones under "Income limits".',
     'https://hajc.net/housing-programs/housing-choice-voucher/', false)
on conflict (standard_id) do update
    set name = excluded.name,
        publisher = excluded.publisher,
        notes = excluded.notes,
        source_url = excluded.source_url;
