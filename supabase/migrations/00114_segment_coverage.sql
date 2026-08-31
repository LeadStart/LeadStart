-- 00114_segment_coverage.sql
--
-- Phase 4, segment awareness: tag each ownership grant with its SEGMENT (vein +
-- simple terms + area — owner decision D4) and maintain the segment_pulls ledger,
-- so the coverage readout ("you own N of ~M in this segment") and the later
-- segment cache have exact, cheap aggregates.
--
--   contact_ownership.segment_key  which segment earned this grant (nullable —
--                                  an unsegmentable search still grants ownership)
--   segment_pulls                  per-segment rollup: last_pulled_at (freshness)
--                                  + master_contact_count (M = distinct masters
--                                  anyone owns under the segment)
--
-- Extends promote_master_contacts to a 7-arg form that writes both. Additive +
-- idempotent; the master-row merge is unchanged from 00112.

SET search_path TO public;

ALTER TABLE public.contact_ownership
  ADD COLUMN IF NOT EXISTS segment_key text;

CREATE INDEX IF NOT EXISTS idx_contact_ownership_segment
  ON public.contact_ownership(segment_key) WHERE segment_key IS NOT NULL;

-- Replace the 4-arg promote fn with the segment-aware 7-arg form (a new argument
-- list is a distinct function, so drop the old one first).
DROP FUNCTION IF EXISTS public.promote_master_contacts(uuid, uuid, text, jsonb);

CREATE OR REPLACE FUNCTION public.promote_master_contacts(
  p_org         uuid,
  p_search_id   uuid,
  p_search_kind text,
  p_segment_key text,
  p_terms       text[],
  p_area        text,
  p_contacts    jsonb
) RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  v_granted   integer;
  v_seg_count integer;
BEGIN
  IF p_contacts IS NULL OR jsonb_typeof(p_contacts) <> 'array' THEN
    RETURN 0;
  END IF;

  -- 1) Upsert canonical master rows (COALESCE-merge; never null-clobber; blob
  --    shallow-merges). Identical to 00112.
  INSERT INTO public.master_contacts AS m (
    natural_key, vein, first_name, last_name, email, company_name, title, phone,
    company_phone, company_email, location, linkedin_url, company_linkedin_url,
    company_domain, google_place_id, enrichment_data, email_verification_status,
    email_verified_at, best_tier, last_verified_at
  )
  SELECT
    x.natural_key, x.vein, x.first_name, x.last_name, x.email, x.company_name, x.title, x.phone,
    x.company_phone, x.company_email, x.location, x.linkedin_url, x.company_linkedin_url,
    x.company_domain, x.google_place_id, COALESCE(x.enrichment_data, '{}'::jsonb),
    x.email_verification_status, x.email_verified_at, x.best_tier,
    CASE WHEN x.email_verification_status = 'ok' THEN now() ELSE NULL END
  FROM jsonb_to_recordset(p_contacts) AS x(
    natural_key text, vein text, first_name text, last_name text, email text, company_name text,
    title text, phone text, company_phone text, company_email text, location text, linkedin_url text,
    company_linkedin_url text, company_domain text, google_place_id text, enrichment_data jsonb,
    email_verification_status text, email_verified_at timestamptz, best_tier text
  )
  WHERE x.natural_key IS NOT NULL AND length(x.natural_key) > 0
  ON CONFLICT (natural_key) DO UPDATE SET
    vein                      = COALESCE(m.vein, EXCLUDED.vein),
    first_name                = COALESCE(EXCLUDED.first_name, m.first_name),
    last_name                 = COALESCE(EXCLUDED.last_name, m.last_name),
    email                     = COALESCE(EXCLUDED.email, m.email),
    company_name              = COALESCE(EXCLUDED.company_name, m.company_name),
    title                     = COALESCE(EXCLUDED.title, m.title),
    phone                     = COALESCE(EXCLUDED.phone, m.phone),
    company_phone             = COALESCE(EXCLUDED.company_phone, m.company_phone),
    company_email             = COALESCE(EXCLUDED.company_email, m.company_email),
    location                  = COALESCE(EXCLUDED.location, m.location),
    linkedin_url              = COALESCE(EXCLUDED.linkedin_url, m.linkedin_url),
    company_linkedin_url      = COALESCE(EXCLUDED.company_linkedin_url, m.company_linkedin_url),
    company_domain            = COALESCE(EXCLUDED.company_domain, m.company_domain),
    google_place_id           = COALESCE(EXCLUDED.google_place_id, m.google_place_id),
    enrichment_data           = m.enrichment_data || COALESCE(EXCLUDED.enrichment_data, '{}'::jsonb),
    email_verification_status = COALESCE(EXCLUDED.email_verification_status, m.email_verification_status),
    email_verified_at         = COALESCE(EXCLUDED.email_verified_at, m.email_verified_at),
    best_tier                 = COALESCE(EXCLUDED.best_tier, m.best_tier),
    last_verified_at          = CASE WHEN EXCLUDED.email_verification_status = 'ok'
                                     THEN now() ELSE m.last_verified_at END,
    updated_at                = now();

  -- 2) Grant ownership once per (org, master), tagging the segment that earned it.
  WITH ins AS (
    INSERT INTO public.contact_ownership (organization_id, master_contact_id, search_id, search_kind, segment_key)
    SELECT p_org, m.id, p_search_id, p_search_kind, p_segment_key
    FROM public.master_contacts m
    JOIN (
      SELECT DISTINCT x.natural_key
      FROM jsonb_to_recordset(p_contacts) AS x(natural_key text)
      WHERE x.natural_key IS NOT NULL AND length(x.natural_key) > 0
    ) k ON k.natural_key = m.natural_key
    ON CONFLICT (organization_id, master_contact_id) DO NOTHING
    RETURNING 1
  )
  SELECT count(*) INTO v_granted FROM ins;

  -- 3) Maintain the segment ledger (only when the search was segmentable).
  --    master_contact_count = M = distinct masters anyone owns under the segment.
  IF p_segment_key IS NOT NULL AND length(p_segment_key) > 0 THEN
    SELECT count(DISTINCT master_contact_id) INTO v_seg_count
    FROM public.contact_ownership
    WHERE segment_key = p_segment_key;

    INSERT INTO public.segment_pulls AS sp (segment_key, vein, terms, area, last_pulled_at, master_contact_count)
    VALUES (p_segment_key, p_search_kind, p_terms, p_area, now(), v_seg_count)
    ON CONFLICT (segment_key) DO UPDATE SET
      vein                 = COALESCE(sp.vein, EXCLUDED.vein),
      terms                = COALESCE(EXCLUDED.terms, sp.terms),
      area                 = COALESCE(EXCLUDED.area, sp.area),
      last_pulled_at       = now(),
      master_contact_count = EXCLUDED.master_contact_count,
      updated_at           = now();
  END IF;

  RETURN v_granted;
END;
$$;

REVOKE ALL ON FUNCTION public.promote_master_contacts(uuid, uuid, text, text, text[], text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.promote_master_contacts(uuid, uuid, text, text, text[], text, jsonb) FROM anon;
REVOKE ALL ON FUNCTION public.promote_master_contacts(uuid, uuid, text, text, text[], text, jsonb) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.promote_master_contacts(uuid, uuid, text, text, text[], text, jsonb) TO service_role;
