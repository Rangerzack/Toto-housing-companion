-- MTSP: the standard LIHTC and LIFT actually test against.
--
-- Neither LIHTC nor LIFT publishes its own dollar tables. Both use HUD's
-- Multifamily Tax Subsidy Project (MTSP) income limits:
--
--   LIHTC              — tiers from 20% through 80% depending on the election
--   LIFT rental        — 60% AMI
--   LIFT homeownership — 80% AMI
--
-- So they are tiers of one standard, not three sets of figures. Recording them
-- separately would mean maintaining the same numbers in three places and
-- eventually disagreeing with yourself.
--
-- MTSP is NOT interchangeable with the HUD-MFI figures loaded from the HOME
-- table. HUD calculates MTSP with hold-harmless and HERA-special provisions
-- that keep some areas above their Section 8 equivalents, so the two diverge in
-- exactly the places it matters. They are kept as separate standards for that
-- reason, and MTSP figures have to come from HUD's MTSP dataset.

insert into income_standards (standard_id, name, publisher, basis, notes, source_url) values
    ('HUD-MTSP', 'HUD Multifamily Tax Subsidy Project (MTSP) Income Limits',
     'U.S. Department of Housing and Urban Development', 'AMI',
     'The basis for LIHTC (all tiers), LIFT rental (60% AMI), and LIFT homeownership (80% AMI). '
     'Published annually around May 1. Differs from the Section 8 / HOME limits in areas subject to '
     'hold-harmless or HERA special provisions, so do not substitute HUD-MFI figures for these.',
     'https://www.huduser.gov/portal/datasets/mtsp.html')
on conflict (standard_id) do nothing;
