-- =============================================
-- Migration 00042: Prospecting tab — Scrap.io key + searches table
--
-- Adds the plumbing for the new admin Prospecting tab that searches
-- Scrap.io for businesses by location + category and lets the user
-- selectively save chosen rows into the existing contacts/CRM pipeline.
--
-- Three concerns, one migration:
--
-- 1) Per-org Scrap.io API key (mirrors organizations.instantly_api_key)
--    plus a couple of cached fields for the credit-balance sidebar tile.
--
-- 2) Allow contacts.email to be NULL. Scrap.io often returns businesses
--    with phone + website but no scraped email — those are still valuable
--    leads (LeadStart already routes hot replies to phone via tel: links),
--    so we want to be able to save them as contacts. Three call sites that
--    treated email as non-null have been guarded in the same commit:
--    global-search, admin/contacts, admin/prospects.
--
-- 3) prospect_searches table — caches search configs + flattened result
--    rows for 30 days so a user can revisit a recent search and save more
--    rows without re-paying for the API call. Owner+VA scoped via RLS.
-- =============================================

ALTER TABLE organizations
  ADD COLUMN scrapio_api_key TEXT,
  ADD COLUMN scrapio_credits_balance INT,
  ADD COLUMN scrapio_last_credit_check_at TIMESTAMPTZ;

-- Drop NOT NULL on contacts.email. Companion app-code guards landed in the
-- same commit. If any future code path needs a non-null email, it should
-- check the row's source/status and short-circuit explicitly rather than
-- relying on the column constraint.
ALTER TABLE contacts ALTER COLUMN email DROP NOT NULL;

-- Partial unique index for upsert dedup on Prospecting save. Keys on
-- lower(email) so case variations of the same address collide. Partial
-- WHERE clause exempts rows with no email so the migration won't fail on
-- duplicate NULLs and the dedup semantic is precise (we only dedup when
-- we actually have an email to compare).
--
-- If this migration ever fails on existing data, it means the contacts
-- table already has duplicate (organization_id, lower(email)) pairs.
-- Resolve by SELECTing the duplicates, deciding which row to keep, and
-- DELETEing the rest before re-running. There's no good auto-resolution
-- — the duplicates carry different statuses / pipeline state.
CREATE UNIQUE INDEX idx_contacts_org_email_unique
  ON contacts (organization_id, lower(email))
  WHERE email IS NOT NULL;

CREATE TABLE prospect_searches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  created_by UUID NOT NULL REFERENCES profiles(id),
  query JSONB NOT NULL,
  results JSONB NOT NULL,
  result_count INT NOT NULL,
  pages_fetched INT NOT NULL,
  truncated BOOLEAN NOT NULL DEFAULT FALSE,
  saved_count INT NOT NULL DEFAULT 0,
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '30 days'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_prospect_searches_org_recent
  ON prospect_searches (organization_id, created_at DESC);

ALTER TABLE prospect_searches ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Owners and VAs view their org's prospect searches"
  ON prospect_searches FOR SELECT
  USING (
    organization_id = public.get_my_org_id()
    AND public.get_my_role() IN ('owner', 'va')
  );

CREATE POLICY "Owners and VAs insert prospect searches"
  ON prospect_searches FOR INSERT
  WITH CHECK (
    organization_id = public.get_my_org_id()
    AND public.get_my_role() IN ('owner', 'va')
  );

CREATE POLICY "Owners and VAs update prospect searches"
  ON prospect_searches FOR UPDATE
  USING (
    organization_id = public.get_my_org_id()
    AND public.get_my_role() IN ('owner', 'va')
  );

CREATE POLICY "Owners and VAs delete prospect searches"
  ON prospect_searches FOR DELETE
  USING (
    organization_id = public.get_my_org_id()
    AND public.get_my_role() IN ('owner', 'va')
  );
