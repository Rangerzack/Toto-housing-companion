-- Removes USDA figures that were never correct.
--
-- Two rows were seeded from the loader's example CSV, taken from secondary
-- sources and flagged at the time as unverified: Jackson County guaranteed
-- limits of $119,850 (1-4 persons) and $158,250 (5-8), dated 2025-10-01.
--
-- HB-1-3555 Appendix 5 (PN 657, 07-13-2026) gives the published figures as
-- $122,800 and $162,100. The upsert key includes effective_date, so loading
-- the authoritative table added new rows rather than replacing these. Current
-- lookups already return the right numbers because the newest effective date
-- wins — but these would surface in any as-of query for an earlier date, and
-- they were not accurate for that period either. They are wrong, not
-- historical, so they go.
--
-- Scoped tightly: only the two amounts in question, only for Jackson, only on
-- that date. A re-run after they are gone deletes nothing.
delete from income_limits
where standard_id = 'USDA-502-GUARANTEED'
  and area_id = 'OR-JACKSON'
  and effective_date = date '2025-10-01'
  and amount in (119850, 158250);
