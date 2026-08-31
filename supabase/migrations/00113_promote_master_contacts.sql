-- 00113_promote_master_contacts.sql
--
-- Phase 4 promotion primitive: the atomic, idempotent merge-upsert that populates
-- the shared master pool at settlement, plus the two config flags that gate the
-- promotion and (later) the segment-cache serve.
--
-- Why a DB function instead of a supabase-js .upsert(): a plain upsert overwrites
-- every column with the new row's value, which would CLOBBER a known field with a
-- NULL when a later, thinner delivery of the same entity lands. This function
-- COALESCE-merges (never overwrites a known value with null; shallow-merges the
-- enrichment_data blob), so the canonical master row only ever accretes. Ownership
-- is granted once per (org, master) via ON CONFLICT DO NOTHING. Both writes are one
-- set-based statement each, so the whole promotion of a search is two round trips.
--
-- Callable by the service-role only (the cron's admin client). Additive + idempotent.

SET search_path TO public;

-- ---- promotion + cache flags on the singleton config --------------------------
ALTER TABLE public.token_pricing_config
  ADD COLUMN IF NOT EXISTS master_pool_promotion_enabled boolean NOT NULL DEFAULT true;
ALTER TABLE public.token_pricing_config
  ADD COLUMN IF NOT EXISTS segment_cache_enabled boolean NOT NULL DEFAULT false;

-- ---- the merge-upsert -------------------------------------------------------
-- p_contacts: a JSON array of promotable contacts (natural_key computed + non-null,
-- best_tier precomputed by the caller's classifier). Returns the number of NEWLY
-- granted ownership rows (rows this org did not already own).
CREATE OR REPLACE FUNCTION public.promote_master_contacts(
  p_org         uuid,
  p_search_id   uuid,
  p_search_kind text,
  p_contacts    jsonb
) RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  v_granted integer;
BEGIN
  IF p_contacts IS NULL OR jsonb_typeof(p_contacts) <> 'array' THEN
    RETURN 0;
  END IF;

  -- 1) Upsert canonical master rows. COALESCE-merge: a new delivery fills gaps and
  --    refreshes verification, but never nulls a value we already have. The
  --    enrichment_data blob is shallow-merged (new keys win). first_acquired_at is
  --    preserved (the ON CONFLICT path does not touch it).
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

  -- 2) Grant ownership once per (org, master). Idempotent: a repeat pull that
  --    re-touches an already-owned record grants nothing (and so bills nothing).
  WITH ins AS (
    INSERT INTO public.contact_ownership (organization_id, master_contact_id, search_id, search_kind)
    SELECT p_org, m.id, p_search_id, p_search_kind
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

  RETURN v_granted;
END;
$$;

-- Service-role only (the cron admin client). Not exposed to buyers/agency users.
REVOKE ALL ON FUNCTION public.promote_master_contacts(uuid, uuid, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.promote_master_contacts(uuid, uuid, text, jsonb) FROM anon;
REVOKE ALL ON FUNCTION public.promote_master_contacts(uuid, uuid, text, jsonb) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.promote_master_contacts(uuid, uuid, text, jsonb) TO service_role;
