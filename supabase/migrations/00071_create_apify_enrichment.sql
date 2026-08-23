-- =============================================
-- Migration 00070: Contact enrichment runs (Apify-native)
--
-- LinkedIn-sourced contacts arrive with a profile URL + company LinkedIn URL
-- and no email. One cron worker (/api/cron/run-apify-enrichment) drives a
-- four-phase pipeline, every step an Apify batch actor:
--   profiles   harvestapi~linkedin-profile-scraper ("+ email search") → contacts.email
--   domains    harvestapi~linkedin-company                            → contacts.company_domain
--   waterfall  vdrmota~contact-info-scraper (leads enrichment)        → contacts.email for profile misses
--   activity   harvestapi~linkedin-profile-posts                      → contacts.last_posted_at (recency)
--
-- Email VERIFICATION is deliberately NOT a phase here: Million Verifier owns it
-- (migration 00069_add_email_verification + its pre-send gate in
-- run-native-sequences). This pipeline only FILLS contacts.email (fill-only) +
-- provenance in enrichment_data; MV verifies just before the first send.
--
-- decision_maker_runs/results are keyed by (search_id, google_id) and cannot
-- hold contact-keyed work, so this adds contact-keyed enrichment_runs /
-- enrichment_run_items mirroring 00044's shape, indexes and RLS.
--
-- Purely ADDITIVE and IDEMPOTENT (local dev shares the prod DB; applied via
-- scripts/supabase-sql.mjs as one statement batch): IF NOT EXISTS / DROP …
-- IF EXISTS throughout, no enum changes, no data backfills.
-- Apply: node scripts/supabase-sql.mjs --file supabase/migrations/00070_create_apify_enrichment.sql
-- =============================================

SET search_path TO public;

-- 1) Per-org Apify token (env fallback APIFY_API_TOKEN). One key powers the
--    profiles, domains and waterfall phases. Verification is Million Verifier's.
ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS apify_api_key TEXT;

-- 2) Contact fields written by the pipeline (+ LinkedIn import).
--    contacts.status is the dispatch lifecycle and is NEVER touched here.
--    Email verification columns are NOT added here — they belong to Million
--    Verifier (migration 00069_add_email_verification), the single source of
--    truth for email_verification_status / email_verified_at.
ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS company_linkedin_url TEXT,
  ADD COLUMN IF NOT EXISTS company_domain TEXT,
  -- LinkedIn activity (activity phase — harvestapi profile-posts). Recency
  -- signal for prioritizing who to contact first.
  ADD COLUMN IF NOT EXISTS last_posted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS recent_post_count INT,       -- posts in the sampled window (up to 5)
  ADD COLUMN IF NOT EXISTS activity_checked_at TIMESTAMPTZ;

-- Import dedupe lookups by person LinkedIn URL (non-unique; case-insensitive).
CREATE INDEX IF NOT EXISTS idx_contacts_org_linkedin
  ON contacts (organization_id, lower(linkedin_url))
  WHERE linkedin_url IS NOT NULL;

-- 3) enrichment_runs — one row per "Enrich" click.
CREATE TABLE IF NOT EXISTS enrichment_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  created_by UUID NOT NULL REFERENCES profiles(id),
  -- provider snapshots (changing code constants never re-targets an in-flight run)
  profile_actor TEXT NOT NULL,
  domain_actor TEXT NOT NULL,
  waterfall_actor TEXT,
  activity_actor TEXT,
  run_profiles BOOLEAN NOT NULL DEFAULT TRUE,
  run_domains BOOLEAN NOT NULL DEFAULT TRUE,
  run_waterfall BOOLEAN NOT NULL DEFAULT TRUE,
  run_activity BOOLEAN NOT NULL DEFAULT TRUE,
  phase TEXT NOT NULL DEFAULT 'profiles'
    CHECK (phase IN ('profiles','domains','waterfall','activity','complete')),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','running','complete','failed')),
  total_count INT NOT NULL,
  phase_total_count INT NOT NULL DEFAULT 0,      -- items applicable to the current phase
  processed_count INT NOT NULL DEFAULT 0,        -- terminal in the current phase (resets per phase)
  found_emails_profiles_count INT NOT NULL DEFAULT 0,
  found_domains_count INT NOT NULL DEFAULT 0,
  found_emails_waterfall_count INT NOT NULL DEFAULT 0,
  found_emails_count INT NOT NULL DEFAULT 0,      -- profiles + waterfall
  found_activity_count INT NOT NULL DEFAULT 0,    -- contacts with a recent post
  cost_usd NUMERIC(12,6) NOT NULL DEFAULT 0,
  active_apify_run_id TEXT,                        -- the one Apify run this run is awaiting
  active_apify_dataset_id TEXT,
  active_batch_started_at TIMESTAMPTZ,
  active_batch_attempt INT NOT NULL DEFAULT 0,
  consecutive_failures INT NOT NULL DEFAULT 0,     -- circuit breaker: 3 → failed
  locked_at TIMESTAMPTZ,                            -- 90s tick lease (see worker)
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  progress_message TEXT,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_enrichment_runs_org_recent
  ON enrichment_runs (organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_enrichment_runs_active
  ON enrichment_runs (created_at) WHERE status IN ('pending','running');
-- One active run per org → the start route's pre-check is race-safe (23505 → 409).
CREATE UNIQUE INDEX IF NOT EXISTS idx_enrichment_runs_one_active_per_org
  ON enrichment_runs (organization_id) WHERE status IN ('pending','running');

-- 4) enrichment_run_items — one row per (run, contact).
CREATE TABLE IF NOT EXISTS enrichment_run_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID NOT NULL REFERENCES enrichment_runs(id) ON DELETE CASCADE,
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  -- snapshots taken at start (join keys + display)
  linkedin_url TEXT,
  profile_id TEXT,             -- URN id parsed from the profile URL, e.g. 'ACwAA…'
  company_linkedin_url TEXT,
  company_id TEXT,             -- numeric id parsed from the company URL, e.g. '19178324'
  company_slug TEXT,
  company_name TEXT,
  first_name TEXT,
  last_name TEXT,
  company_domain TEXT,         -- pre-filled from the contact when present, else set by domains/profiles
  -- step 1: profiles (harvestapi profile + email)
  profile_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (profile_status IN ('pending','in_flight','found','not_found','skipped','error')),
  profile_apify_run_id TEXT,
  profile_notes TEXT,
  -- step 2: domains (harvestapi company)
  domain_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (domain_status IN ('pending','in_flight','found','not_found','skipped','error')),
  domain_apify_run_id TEXT,
  domain_notes TEXT,
  -- step 3: waterfall (vdrmota/bovi). NULL = not part of the waterfall.
  waterfall_status TEXT
    CHECK (waterfall_status IS NULL OR waterfall_status IN ('pending','in_flight','found','not_found','skipped','error')),
  waterfall_apify_run_id TEXT,
  waterfall_notes TEXT,
  -- step 4: activity (harvestapi profile-posts). NULL = not part of scoring.
  activity_status TEXT
    CHECK (activity_status IS NULL OR activity_status IN ('pending','in_flight','found','not_found','skipped','error')),
  activity_apify_run_id TEXT,
  activity_notes TEXT,
  last_posted_at TIMESTAMPTZ,
  recent_post_count INT,
  -- final email outcome (whichever step found it). Verification is NOT tracked
  -- here — Million Verifier owns it on the contact.
  email TEXT,
  email_provider TEXT,         -- 'harvestapi' | 'vdrmota' | 'bovi' (provenance)
  confidence INT,              -- 0-100 (provider's own confidence in the email)
  attempts INT NOT NULL DEFAULT 0,  -- failed attempts in the CURRENT phase (reset on phase advance)
  cost_usd NUMERIC(12,6) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (run_id, contact_id)
);

CREATE INDEX IF NOT EXISTS idx_enrichment_items_run ON enrichment_run_items (run_id);
CREATE INDEX IF NOT EXISTS idx_enrichment_items_contact ON enrichment_run_items (contact_id);
-- Worker batch selection per phase (bulk inserts share one created_at, so we
-- order by (created_at, id) for a deterministic batch).
CREATE INDEX IF NOT EXISTS idx_enrichment_items_profile_pending
  ON enrichment_run_items (run_id, created_at, id) WHERE profile_status = 'pending';
CREATE INDEX IF NOT EXISTS idx_enrichment_items_domain_pending
  ON enrichment_run_items (run_id, created_at, id) WHERE domain_status = 'pending';
CREATE INDEX IF NOT EXISTS idx_enrichment_items_waterfall_pending
  ON enrichment_run_items (run_id, created_at, id) WHERE waterfall_status = 'pending';
CREATE INDEX IF NOT EXISTS idx_enrichment_items_activity_pending
  ON enrichment_run_items (run_id, created_at, id) WHERE activity_status = 'pending';

DROP TRIGGER IF EXISTS set_enrichment_items_updated_at ON enrichment_run_items;
CREATE TRIGGER set_enrichment_items_updated_at
  BEFORE UPDATE ON enrichment_run_items
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- 5) RLS — identical predicate to migration 00044 (owner/va scoped by org).
ALTER TABLE enrichment_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE enrichment_run_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Owners and VAs view their org's enrichment runs" ON enrichment_runs;
CREATE POLICY "Owners and VAs view their org's enrichment runs"
  ON enrichment_runs FOR SELECT
  USING (organization_id = public.get_my_org_id() AND public.get_my_role() IN ('owner','va'));
DROP POLICY IF EXISTS "Owners and VAs insert enrichment runs" ON enrichment_runs;
CREATE POLICY "Owners and VAs insert enrichment runs"
  ON enrichment_runs FOR INSERT
  WITH CHECK (organization_id = public.get_my_org_id() AND public.get_my_role() IN ('owner','va'));
DROP POLICY IF EXISTS "Owners and VAs update enrichment runs" ON enrichment_runs;
CREATE POLICY "Owners and VAs update enrichment runs"
  ON enrichment_runs FOR UPDATE
  USING (organization_id = public.get_my_org_id() AND public.get_my_role() IN ('owner','va'));
DROP POLICY IF EXISTS "Owners and VAs delete enrichment runs" ON enrichment_runs;
CREATE POLICY "Owners and VAs delete enrichment runs"
  ON enrichment_runs FOR DELETE
  USING (organization_id = public.get_my_org_id() AND public.get_my_role() IN ('owner','va'));

DROP POLICY IF EXISTS "Owners and VAs view their org's enrichment items" ON enrichment_run_items;
CREATE POLICY "Owners and VAs view their org's enrichment items"
  ON enrichment_run_items FOR SELECT
  USING (organization_id = public.get_my_org_id() AND public.get_my_role() IN ('owner','va'));
DROP POLICY IF EXISTS "Owners and VAs insert enrichment items" ON enrichment_run_items;
CREATE POLICY "Owners and VAs insert enrichment items"
  ON enrichment_run_items FOR INSERT
  WITH CHECK (organization_id = public.get_my_org_id() AND public.get_my_role() IN ('owner','va'));
DROP POLICY IF EXISTS "Owners and VAs update enrichment items" ON enrichment_run_items;
CREATE POLICY "Owners and VAs update enrichment items"
  ON enrichment_run_items FOR UPDATE
  USING (organization_id = public.get_my_org_id() AND public.get_my_role() IN ('owner','va'));
DROP POLICY IF EXISTS "Owners and VAs delete enrichment items" ON enrichment_run_items;
CREATE POLICY "Owners and VAs delete enrichment items"
  ON enrichment_run_items FOR DELETE
  USING (organization_id = public.get_my_org_id() AND public.get_my_role() IN ('owner','va'));
