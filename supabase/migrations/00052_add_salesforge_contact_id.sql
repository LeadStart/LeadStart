-- =============================================
-- Migration 00052: salesforge_contact_id on contacts
--
-- Auto-sync of Salesforge workspace contacts into LeadStart's contacts
-- table needs a deterministic dedup key beyond email. Salesforge's own
-- lead_xxx id is the authoritative join key for that.
--
-- Email alone almost works (the existing idx_contacts_org_email_unique
-- already dedups on email per-org), but Salesforge's lead id is
-- friendlier for "is this row actually backed by a Salesforge contact?"
-- queries and for keeping local rows in sync when an email changes
-- upstream.
--
-- Wired by the Salesforge workspace-contacts sync in
-- src/app/api/cron/sync-analytics/route.ts.
-- =============================================

SET search_path TO public;

ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS salesforge_contact_id TEXT;

-- Partial unique so rows without a Salesforge id (LinkedIn-only,
-- prospect-search, etc.) don't all collide on NULL.
CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_org_salesforge_contact_unique
  ON contacts (organization_id, salesforge_contact_id)
  WHERE salesforge_contact_id IS NOT NULL;

-- Lookup index for the sync path: find local rows whose salesforge_contact_id
-- is in a batch from the upstream list.
CREATE INDEX IF NOT EXISTS idx_contacts_salesforge_contact_id
  ON contacts (salesforge_contact_id)
  WHERE salesforge_contact_id IS NOT NULL;
