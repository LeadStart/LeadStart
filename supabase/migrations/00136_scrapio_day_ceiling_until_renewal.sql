-- 00136_scrapio_day_ceiling_until_renewal.sql
--
-- A time-boxed raise of the Scrap.io 24-hour search ceiling (00135), with the
-- owner's go on 2026-10-08. The Scrap.io plan renews at 2026-10-08 21:45 UTC
-- and the owner is cancelling it, so the 5,557 credits left expire then. The
-- 24-hour ceiling (150) was used up by the cleaning bank pull that morning.
--
-- Until 2026-10-08 21:45 UTC the 24-hour ceiling is 250 (100 more paid page
-- searches). After that it is 150 again on its own: no follow-up migration is
-- needed. The 7-day (400) and 30-day (1,000) ceilings are unchanged, so the
-- raise can't add more than 100 searches. Only scrapio_search_budget()
-- changes; claim_scrapio_search() reads it.

SET search_path TO public;

CREATE OR REPLACE FUNCTION public.scrapio_search_budget(p_organization_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  c_day   CONSTANT INTEGER := CASE WHEN now() < TIMESTAMPTZ '2026-10-08 21:45:00+00' THEN 250 ELSE 150 END;
  c_week  CONSTANT INTEGER := 400;
  c_month CONSTANT INTEGER := 1000;
  v_day   INTEGER;
  v_week  INTEGER;
  v_month INTEGER;
BEGIN
  SELECT count(*) FILTER (WHERE at > now() - INTERVAL '24 hours'),
         count(*) FILTER (WHERE at > now() - INTERVAL '7 days'),
         count(*)
    INTO v_day, v_week, v_month
    FROM public.scrapio_search_log
   WHERE organization_id = p_organization_id
     AND at > now() - INTERVAL '30 days';

  RETURN jsonb_build_object(
    'day',    v_day,
    'week',   v_week,
    'month',  v_month,
    'limits', jsonb_build_object('day', c_day, 'week', c_week, 'month', c_month),
    'left',   GREATEST(0, LEAST(c_day - v_day, c_week - v_week, c_month - v_month))
  );
END;
$$;

REVOKE ALL ON FUNCTION public.scrapio_search_budget(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.scrapio_search_budget(UUID) TO service_role;
