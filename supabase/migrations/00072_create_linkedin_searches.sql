-- LinkedIn people-search sourcing (Prospecting → Contacts funnel head).
-- Mirrors prospect_searches (cached search + inline JSONB results) but the
-- engine is an ASYNC Apify actor, so it also carries the run-tracking columns
-- from enrichment_runs (active_apify_run_id, lease, failure counter).
-- Purely additive + idempotent.

SET search_path TO public;

CREATE TABLE IF NOT EXISTS linkedin_searches (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id         UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  created_by              UUID NOT NULL REFERENCES profiles(id),
  query                   JSONB NOT NULL,                       -- { levers, depth }
  results                 JSONB NOT NULL DEFAULT '[]'::jsonb,   -- LinkedInProspect[]
  result_count            INT NOT NULL DEFAULT 0,
  target_max_results      INT NOT NULL DEFAULT 100,
  truncated               BOOLEAN NOT NULL DEFAULT FALSE,
  saved_count             INT NOT NULL DEFAULT 0,
  status                  TEXT NOT NULL DEFAULT 'pending'
                            CHECK (status IN ('pending','running','complete','failed')),
  progress_message        TEXT,
  error_message           TEXT,
  -- async Apify run tracking (mirrors enrichment_runs)
  actor                   TEXT NOT NULL,
  active_apify_run_id     TEXT,
  active_apify_dataset_id TEXT,
  active_batch_started_at TIMESTAMPTZ,
  consecutive_failures    INT NOT NULL DEFAULT 0,
  cost_usd                NUMERIC(12,6) NOT NULL DEFAULT 0,
  locked_at               TIMESTAMPTZ,                          -- 90s tick lease
  started_at              TIMESTAMPTZ,
  completed_at            TIMESTAMPTZ,
  expires_at              TIMESTAMPTZ NOT NULL DEFAULT (now() + INTERVAL '30 days'),
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_linkedin_searches_org_recent
  ON linkedin_searches (organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_linkedin_searches_active
  ON linkedin_searches (created_at) WHERE status IN ('pending','running');
CREATE UNIQUE INDEX IF NOT EXISTS idx_linkedin_searches_one_active_per_org
  ON linkedin_searches (organization_id) WHERE status IN ('pending','running');

ALTER TABLE linkedin_searches ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Owners and VAs view their org's linkedin searches" ON linkedin_searches;
CREATE POLICY "Owners and VAs view their org's linkedin searches" ON linkedin_searches FOR SELECT
  USING (organization_id = public.get_my_org_id() AND public.get_my_role() IN ('owner','va'));

DROP POLICY IF EXISTS "Owners and VAs insert their org's linkedin searches" ON linkedin_searches;
CREATE POLICY "Owners and VAs insert their org's linkedin searches" ON linkedin_searches FOR INSERT
  WITH CHECK (organization_id = public.get_my_org_id() AND public.get_my_role() IN ('owner','va'));

DROP POLICY IF EXISTS "Owners and VAs update their org's linkedin searches" ON linkedin_searches;
CREATE POLICY "Owners and VAs update their org's linkedin searches" ON linkedin_searches FOR UPDATE
  USING (organization_id = public.get_my_org_id() AND public.get_my_role() IN ('owner','va'));

DROP POLICY IF EXISTS "Owners and VAs delete their org's linkedin searches" ON linkedin_searches;
CREATE POLICY "Owners and VAs delete their org's linkedin searches" ON linkedin_searches FOR DELETE
  USING (organization_id = public.get_my_org_id() AND public.get_my_role() IN ('owner','va'));
