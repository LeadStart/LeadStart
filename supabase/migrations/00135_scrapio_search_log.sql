-- 00135_scrapio_search_log.sql
--
-- A hard ceiling on Scrap.io searches. On 2026-09-26 throwaway count scripts
-- swept whole states (~1,800 searches in three days) and tripped Scrap.io's
-- fair-use quota: HTTP 403 search-fair-use-count-error, every search refused
-- until Scrap.io support unlocked the account. Owner, 2026-09-29: "ENSURE THOSE
-- CRAZY # of searches NEVER HAPPENS AGAIN."
--
-- Every /gmap/* call (paid pages, free skip_data counts, location/type lookups)
-- first claims a slot through claim_scrapio_search(). It logs the search and
-- refuses once the organization would pass any ceiling:
--   150 in 24 hours · 400 in 7 days · 1,000 in 30 days.
-- A normal batch is ~30 counts + ~40-60 pull pages; a month of export credits
-- buys ~200 pages. The two callers: src/lib/scrapio/client.ts (the app) and
-- .claude/skills/tube-pipeline/scripts/scrapio.mjs (the TuBe pipeline skill).
-- The ceilings live only in scrapio_search_budget() below: raising one takes a
-- new migration, on purpose, with the owner's go.
--
-- Server-only, like rate_limits (00105): RLS on with no policy, table grants
-- revoked; only the service role and the SECURITY DEFINER functions touch it.
-- Idempotent; safe to re-run.

SET search_path TO public;

CREATE TABLE IF NOT EXISTS public.scrapio_search_log (
  id              BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id UUID        NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  endpoint        TEXT        NOT NULL,
  source          TEXT        NOT NULL,
  detail          JSONB
);

CREATE INDEX IF NOT EXISTS scrapio_search_log_org_at_idx
  ON public.scrapio_search_log (organization_id, at DESC);

ALTER TABLE public.scrapio_search_log ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.scrapio_search_log FROM anon, authenticated;

COMMENT ON TABLE public.scrapio_search_log IS
  'One row per Scrap.io /gmap/* search, written by claim_scrapio_search() before the search is sent. Backs the hard search ceilings (migration 00135).';

-- Searches used in each window, the ceilings, and how many more fit now.
CREATE OR REPLACE FUNCTION public.scrapio_search_budget(p_organization_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  c_day   CONSTANT INTEGER := 150;
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

-- Claim one search: log it and return ok=true, or return ok=false (nothing
-- logged) when it would pass a ceiling. The caller sends the search only on
-- ok=true. The advisory lock serialises claims per organization, so two
-- callers can't both slip under a ceiling.
CREATE OR REPLACE FUNCTION public.claim_scrapio_search(
  p_organization_id UUID,
  p_endpoint        TEXT,
  p_source          TEXT,
  p_detail          JSONB DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_budget JSONB;
BEGIN
  IF p_organization_id IS NULL OR coalesce(p_endpoint, '') = '' OR coalesce(p_source, '') = '' THEN
    RAISE EXCEPTION 'claim_scrapio_search: organization, endpoint and source are required';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('scrapio_search_log'), hashtext(p_organization_id::TEXT));

  v_budget := public.scrapio_search_budget(p_organization_id);
  IF (v_budget->>'left')::INTEGER < 1 THEN
    RETURN v_budget || jsonb_build_object('ok', false);
  END IF;

  INSERT INTO public.scrapio_search_log (organization_id, endpoint, source, detail)
  VALUES (p_organization_id, p_endpoint, p_source, p_detail);

  -- ~2% of claims sweep rows older than 90 days.
  IF random() < 0.02 THEN
    DELETE FROM public.scrapio_search_log WHERE at < now() - INTERVAL '90 days';
  END IF;

  RETURN jsonb_build_object(
    'ok',     true,
    'day',    (v_budget->>'day')::INTEGER + 1,
    'week',   (v_budget->>'week')::INTEGER + 1,
    'month',  (v_budget->>'month')::INTEGER + 1,
    'limits', v_budget->'limits',
    'left',   (v_budget->>'left')::INTEGER - 1
  );
END;
$$;

REVOKE ALL ON FUNCTION public.scrapio_search_budget(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.scrapio_search_budget(UUID) TO service_role;
REVOKE ALL ON FUNCTION public.claim_scrapio_search(UUID, TEXT, TEXT, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_scrapio_search(UUID, TEXT, TEXT, JSONB) TO service_role;
