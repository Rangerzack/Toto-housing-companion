-- MTSP tiers are exact multiples of the 50% figure.
--
-- Verified against the OHCS dashboard's published Jackson County table: every
-- one of the ten tiers reproduces exactly from the 50% row — 20% is 0.4x,
-- 60% is 1.2x, 80% is 1.6x, and so on. So scaling to a tier that is not stored
-- is arithmetic here, not an estimate.
--
-- That is also what separates MTSP from the Section 8 limits in HUD-MFI. Those
-- compute each tier separately and cap them, which is why the two tables agree
-- at 50% and 60% for Jackson County but differ at 80%:
--
--     4-person   HUD-MFI $78,500   MTSP $78,480
--     6-person   HUD-MFI $91,100   MTSP $91,040
--     8-person   HUD-MFI $103,650  MTSP $103,600
--
-- Small in Medford, wider in HERA-special and hold-harmless areas — and the
-- reason LIHTC and LIFT must resolve against MTSP rather than borrowing the
-- Section 8 figures.
update income_standards
set proportional = true,
    notes = 'The basis for LIHTC (all tiers), LIFT rental (60% AMI), and LIFT homeownership (80% AMI). '
            'Published annually around May 1. Every tier is an exact multiple of the 50% figure. '
            'Differs from the Section 8 / HOME limits in areas subject to hold-harmless or HERA '
            'special provisions, so do not substitute HUD-MFI figures for these.'
where standard_id = 'HUD-MTSP';
