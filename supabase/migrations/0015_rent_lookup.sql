-- Rent lookup, matching income_limit_for().
--
-- Several effective dates coexist in rent_limits — the OHCS workbook carries
-- 2024, 2025 and 2026, and none of those rows has an expiry, so
-- v_current_rent_limits returns one row per year for every key. The income
-- side has the same shape and income_limit_for() picks the newest; rents had
-- no equivalent, so every caller would have had to re-implement that.
create or replace function rent_limit_for(
    p_standard  text,
    p_area      text,
    p_bedrooms  integer,
    p_tier      numeric default null,
    p_kind      text    default 'max_rent',
    p_on        date    default current_date
) returns numeric
language sql
stable
as $$
    select amount
    from rent_limits
    where standard_id = p_standard
      and area_id = p_area
      and bedrooms = p_bedrooms
      and rent_kind = p_kind
      and (p_tier is null or tier_pct = p_tier)
      and effective_date <= p_on
      and (expires_date is null or expires_date > p_on)
    order by effective_date desc
    limit 1;
$$;
