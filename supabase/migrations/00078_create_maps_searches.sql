-- Google Maps business-search sourcing (the second prospecting vein, parallel to
-- linkedin_searches). Same async-Apify-actor lifecycle as linkedin_searches
-- (compass~google-maps-extractor: start → poll → ingest → complete), so it
-- carries the identical run-tracking + lease + failure-counter columns.
-- Purely additive + idempotent.

SET search_path TO public;

CREATE TABLE IF NOT EXISTS maps_searches (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id         UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  created_by              UUID NOT NULL REFERENCES profiles(id),
  query                   JSONB NOT NULL,                       -- { levers, addons, name?, preset_slug? }
  results                 JSONB NOT NULL DEFAULT '[]'::jsonb,   -- MapsPlace[]
  result_count            INT NOT NULL DEFAULT 0,
  target_max_results      INT NOT NULL DEFAULT 200,
  truncated               BOOLEAN NOT NULL DEFAULT FALSE,
  saved_count             INT NOT NULL DEFAULT 0,
  status                  TEXT NOT NULL DEFAULT 'pending'
                            CHECK (status IN ('pending','running','complete','failed')),
  progress_message        TEXT,
  error_message           TEXT,
  -- async Apify run tracking (mirrors linkedin_searches / enrichment_runs)
  actor                   TEXT NOT NULL,
  active_apify_run_id     TEXT,
  active_apify_dataset_id TEXT,
  active_batch_started_at TIMESTAMPTZ,
  consecutive_failures    INT NOT NULL DEFAULT 0,
  cost_usd                NUMERIC(12,6) NOT NULL DEFAULT 0,
  -- delivered-outcome ledger (populated by the enrichment run at completion,
  -- migration 00079 / Phase 5) — the margin substrate for future billing.
  delivered_counts        JSONB NOT NULL DEFAULT '{}'::jsonb,
  locked_at               TIMESTAMPTZ,                          -- 90s tick lease
  started_at              TIMESTAMPTZ,
  completed_at            TIMESTAMPTZ,
  expires_at              TIMESTAMPTZ NOT NULL DEFAULT (now() + INTERVAL '30 days'),
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_maps_searches_org_recent
  ON maps_searches (organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_maps_searches_active
  ON maps_searches (created_at) WHERE status IN ('pending','running');
CREATE UNIQUE INDEX IF NOT EXISTS idx_maps_searches_one_active_per_org
  ON maps_searches (organization_id) WHERE status IN ('pending','running');

ALTER TABLE maps_searches ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Owners and VAs view their org's maps searches" ON maps_searches;
CREATE POLICY "Owners and VAs view their org's maps searches" ON maps_searches FOR SELECT
  USING (organization_id = public.get_my_org_id() AND public.get_my_role() IN ('owner','va'));

DROP POLICY IF EXISTS "Owners and VAs insert their org's maps searches" ON maps_searches;
CREATE POLICY "Owners and VAs insert their org's maps searches" ON maps_searches FOR INSERT
  WITH CHECK (organization_id = public.get_my_org_id() AND public.get_my_role() IN ('owner','va'));

DROP POLICY IF EXISTS "Owners and VAs update their org's maps searches" ON maps_searches;
CREATE POLICY "Owners and VAs update their org's maps searches" ON maps_searches FOR UPDATE
  USING (organization_id = public.get_my_org_id() AND public.get_my_role() IN ('owner','va'));

DROP POLICY IF EXISTS "Owners and VAs delete their org's maps searches" ON maps_searches;
CREATE POLICY "Owners and VAs delete their org's maps searches" ON maps_searches FOR DELETE
  USING (organization_id = public.get_my_org_id() AND public.get_my_role() IN ('owner','va'));

-- Dedup key for email-less business leads (a Maps place has no email, so the
-- (org, lower(email)) unique index can't catch a repeat pull). google_place_id is
-- Google's stable per-place identity. Deliberately NOT unique on company_domain —
-- franchise locations legitimately share one, and a LinkedIn person at the same
-- company must not collide with a Maps business row.
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS google_place_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_org_place_unique
  ON contacts (organization_id, google_place_id) WHERE google_place_id IS NOT NULL;
COMMENT ON COLUMN contacts.google_place_id IS
  'Google Maps place identity for leads sourced from the Maps vein (dedup key; NULL for all other sources).';
