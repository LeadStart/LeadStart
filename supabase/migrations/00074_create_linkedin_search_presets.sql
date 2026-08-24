-- Saved LinkedIn search presets. A named, reusable full-form search config
-- (levers + depth + max_results), org-scoped so a preset saved on one machine
-- or by one teammate is available everywhere. Purely additive + idempotent.

SET search_path TO public;

CREATE TABLE IF NOT EXISTS linkedin_search_presets (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  created_by      UUID NOT NULL REFERENCES profiles(id),
  name            TEXT NOT NULL,
  config          JSONB NOT NULL DEFAULT '{}'::jsonb,   -- full form state (see SearchConfig)
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_linkedin_search_presets_org_recent
  ON linkedin_search_presets (organization_id, created_at DESC);
-- One name per org (case-insensitive) — re-saving a name updates it in place.
CREATE UNIQUE INDEX IF NOT EXISTS idx_linkedin_search_presets_org_name
  ON linkedin_search_presets (organization_id, lower(name));

ALTER TABLE linkedin_search_presets ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Owners and VAs view their org's search presets" ON linkedin_search_presets;
CREATE POLICY "Owners and VAs view their org's search presets" ON linkedin_search_presets FOR SELECT
  USING (organization_id = public.get_my_org_id() AND public.get_my_role() IN ('owner','va'));

DROP POLICY IF EXISTS "Owners and VAs insert their org's search presets" ON linkedin_search_presets;
CREATE POLICY "Owners and VAs insert their org's search presets" ON linkedin_search_presets FOR INSERT
  WITH CHECK (organization_id = public.get_my_org_id() AND public.get_my_role() IN ('owner','va'));

DROP POLICY IF EXISTS "Owners and VAs update their org's search presets" ON linkedin_search_presets;
CREATE POLICY "Owners and VAs update their org's search presets" ON linkedin_search_presets FOR UPDATE
  USING (organization_id = public.get_my_org_id() AND public.get_my_role() IN ('owner','va'));

DROP POLICY IF EXISTS "Owners and VAs delete their org's search presets" ON linkedin_search_presets;
CREATE POLICY "Owners and VAs delete their org's search presets" ON linkedin_search_presets FOR DELETE
  USING (organization_id = public.get_my_org_id() AND public.get_my_role() IN ('owner','va'));
