-- =============================================
-- Migration 00044: Decision-maker enrichment for the Prospecting tab
--
-- After Phase 2 (Scrap.io background search) returns a list of businesses,
-- the user selects rows and kicks off "Find decision makers" — a two-layer
-- enrichment pipeline ported from the standalone LeadEnrich tool:
--
--   Layer 1: scrape the business website (homepage + up to 4 contact/team
--            pages), strip to text, ask Claude Haiku for the most senior
--            decision maker using a category-aware seniority hierarchy.
--   Layer 2: if Layer 1 returns nothing AND use_layer2=true, fall back to
--            Perplexity Sonar web search with the same seniority prompt.
--
-- Architecture mirrors prospect_searches: a parent run row + N pending
-- per-business result rows, processed by a cron worker in chunks. The
-- frontend polls the run row to render progress + per-row results inline.
--
-- Three concerns:
--
-- 1) Per-org Anthropic + Perplexity API keys (mirrors instantly_api_key /
--    scrapio_api_key). Anthropic is required; Perplexity is optional and
--    only consulted when use_layer2=true.
--
-- 2) decision_maker_runs — one row per "Find decision makers" click.
--    Tracks targeting profile, layer-2 toggle, status lifecycle (pending →
--    running → complete | failed), aggregate cost, and progress message.
--
-- 3) decision_maker_results — one row per (run, business) pair. Holds the
--    enriched fields (first_name, last_name, title, personal_email, etc.)
--    and per-business cost. UNIQUE (search_id, google_id) enables result
--    reuse: re-running enrichment for a business already enriched in a
--    prior run for the same search reuses the existing row at zero cost.
-- =============================================

ALTER TABLE organizations
  ADD COLUMN anthropic_api_key TEXT,
  ADD COLUMN perplexity_api_key TEXT;

-- ---- decision_maker_runs ----

CREATE TABLE decision_maker_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  created_by UUID NOT NULL REFERENCES profiles(id),
  search_id UUID NOT NULL REFERENCES prospect_searches(id) ON DELETE CASCADE,
  service_type TEXT NOT NULL DEFAULT 'operations',  -- 'operations' | 'events'
  use_layer2 BOOLEAN NOT NULL DEFAULT TRUE,
  status TEXT NOT NULL DEFAULT 'pending',           -- 'pending'|'running'|'complete'|'failed'
  total_count INT NOT NULL,
  processed_count INT NOT NULL DEFAULT 0,
  cost_usd NUMERIC(12, 6) NOT NULL DEFAULT 0,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  progress_message TEXT,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_dm_runs_org_recent
  ON decision_maker_runs (organization_id, created_at DESC);

-- Partial index so the cron worker finds the next active run in O(log n).
CREATE INDEX idx_dm_runs_active
  ON decision_maker_runs (created_at)
  WHERE status IN ('pending', 'running');

CREATE INDEX idx_dm_runs_search ON decision_maker_runs (search_id);

ALTER TABLE decision_maker_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Owners and VAs view their org's enrichment runs"
  ON decision_maker_runs FOR SELECT
  USING (
    organization_id = public.get_my_org_id()
    AND public.get_my_role() IN ('owner', 'va')
  );

CREATE POLICY "Owners and VAs insert enrichment runs"
  ON decision_maker_runs FOR INSERT
  WITH CHECK (
    organization_id = public.get_my_org_id()
    AND public.get_my_role() IN ('owner', 'va')
  );

CREATE POLICY "Owners and VAs update enrichment runs"
  ON decision_maker_runs FOR UPDATE
  USING (
    organization_id = public.get_my_org_id()
    AND public.get_my_role() IN ('owner', 'va')
  );

CREATE POLICY "Owners and VAs delete enrichment runs"
  ON decision_maker_runs FOR DELETE
  USING (
    organization_id = public.get_my_org_id()
    AND public.get_my_role() IN ('owner', 'va')
  );

-- ---- decision_maker_results ----

CREATE TABLE decision_maker_results (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID NOT NULL REFERENCES decision_maker_runs(id) ON DELETE CASCADE,
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  search_id UUID NOT NULL REFERENCES prospect_searches(id) ON DELETE CASCADE,
  google_id TEXT NOT NULL,
  business_name TEXT,
  category TEXT,
  first_name TEXT,
  last_name TEXT,
  title TEXT,
  personal_email TEXT,
  other_emails TEXT[] NOT NULL DEFAULT '{}',
  enrichment_source TEXT,                           -- 'website' | 'web_search' | NULL
  enrichment_notes TEXT,
  status TEXT NOT NULL DEFAULT 'pending',           -- 'pending'|'complete'|'error'|'skipped'
  cost_usd NUMERIC(12, 6) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_dm_results_run ON decision_maker_results (run_id);

-- Cron worker selects pending rows for a given run.
CREATE INDEX idx_dm_results_pending
  ON decision_maker_results (run_id, created_at)
  WHERE status = 'pending';

-- Save endpoint merges enrichment by (search, google_id), and the start
-- endpoint reuses prior results via the same key.
CREATE UNIQUE INDEX idx_dm_results_search_google
  ON decision_maker_results (search_id, google_id);

CREATE TRIGGER set_dm_results_updated_at
  BEFORE UPDATE ON decision_maker_results
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at();

ALTER TABLE decision_maker_results ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Owners and VAs view their org's enrichment results"
  ON decision_maker_results FOR SELECT
  USING (
    organization_id = public.get_my_org_id()
    AND public.get_my_role() IN ('owner', 'va')
  );

CREATE POLICY "Owners and VAs insert enrichment results"
  ON decision_maker_results FOR INSERT
  WITH CHECK (
    organization_id = public.get_my_org_id()
    AND public.get_my_role() IN ('owner', 'va')
  );

CREATE POLICY "Owners and VAs update enrichment results"
  ON decision_maker_results FOR UPDATE
  USING (
    organization_id = public.get_my_org_id()
    AND public.get_my_role() IN ('owner', 'va')
  );

CREATE POLICY "Owners and VAs delete enrichment results"
  ON decision_maker_results FOR DELETE
  USING (
    organization_id = public.get_my_org_id()
    AND public.get_my_role() IN ('owner', 'va')
  );
