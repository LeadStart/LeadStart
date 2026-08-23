-- Auto-enrich queue for the Prospecting → Contacts handoff.
-- When people are imported while an enrichment run is already active for the
-- org (one-active-run-per-org), they can't start a second run — they're stamped
-- enrich_queued_at and the drain cron starts them once the org frees up.
-- Purely additive + idempotent.

SET search_path TO public;

ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS enrich_queued_at TIMESTAMPTZ;

-- The drain cron looks up orgs with anything queued; a partial index keeps that
-- lookup cheap and out of the way of the main contacts workload.
CREATE INDEX IF NOT EXISTS idx_contacts_enrich_queued
  ON contacts (organization_id, enrich_queued_at)
  WHERE enrich_queued_at IS NOT NULL;
