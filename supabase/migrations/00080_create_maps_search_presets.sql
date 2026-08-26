-- Per-niche Google Maps search presets — the reusable, named search configs a
-- themed landing page will eventually point at ("pre-set for their industry").
--
-- Sibling table to linkedin_search_presets (00074), NOT a kind-column on it: the
-- config shapes are disjoint (Maps form vs LinkedIn form), and the global/system
-- tier + landing-page slug are Maps-first requirements (nullable org, a global
-- slug namespace, read-for-all RLS) that the live LinkedIn presets table doesn't
-- want. `kind` is built in so LinkedIn presets can fold in later.
--
-- organization_id NULL  ⇒ a GLOBAL/system preset (the future landing-page target;
-- app-side writes are org-scoped only — global rows are seeded by service role).
--
-- Purely additive + idempotent. Apply with:
--   node scripts/supabase-sql.mjs --file supabase/migrations/00080_create_maps_search_presets.sql

SET search_path TO public;

CREATE TABLE IF NOT EXISTS maps_search_presets (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  UUID REFERENCES organizations(id) ON DELETE CASCADE,  -- NULL = global/system tier
  created_by       UUID REFERENCES profiles(id),
  kind             TEXT NOT NULL DEFAULT 'google_maps',
  slug             TEXT NOT NULL,               -- landing-page handle, e.g. 'med-spas'
  name             TEXT NOT NULL,
  description      TEXT,
  config           JSONB NOT NULL DEFAULT '{}'::jsonb,  -- MapsSearchConfig (niche, minus location)
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Org presets: unique name + slug per org. Global presets (org NULL): unique slug
-- across the global namespace.
CREATE UNIQUE INDEX IF NOT EXISTS idx_maps_presets_org_name
  ON maps_search_presets (organization_id, lower(name)) WHERE organization_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_maps_presets_org_slug
  ON maps_search_presets (organization_id, lower(slug)) WHERE organization_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_maps_presets_global_slug
  ON maps_search_presets (lower(slug)) WHERE organization_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_maps_presets_org_recent
  ON maps_search_presets (organization_id, created_at DESC);

ALTER TABLE maps_search_presets ENABLE ROW LEVEL SECURITY;

-- SELECT: an org's own presets OR any global (org-NULL) preset. Owner/va only.
DROP POLICY IF EXISTS "Owners and VAs view maps presets" ON maps_search_presets;
CREATE POLICY "Owners and VAs view maps presets" ON maps_search_presets FOR SELECT
  USING (
    (organization_id = public.get_my_org_id() OR organization_id IS NULL)
    AND public.get_my_role() IN ('owner','va')
  );

-- INSERT/UPDATE/DELETE: org-scoped only — global presets stay read-only from the
-- app (seeded by service role) until the self-serve work lands.
DROP POLICY IF EXISTS "Owners and VAs insert maps presets" ON maps_search_presets;
CREATE POLICY "Owners and VAs insert maps presets" ON maps_search_presets FOR INSERT
  WITH CHECK (organization_id = public.get_my_org_id() AND public.get_my_role() IN ('owner','va'));

DROP POLICY IF EXISTS "Owners and VAs update maps presets" ON maps_search_presets;
CREATE POLICY "Owners and VAs update maps presets" ON maps_search_presets FOR UPDATE
  USING (organization_id = public.get_my_org_id() AND public.get_my_role() IN ('owner','va'));

DROP POLICY IF EXISTS "Owners and VAs delete maps presets" ON maps_search_presets;
CREATE POLICY "Owners and VAs delete maps presets" ON maps_search_presets FOR DELETE
  USING (organization_id = public.get_my_org_id() AND public.get_my_role() IN ('owner','va'));
