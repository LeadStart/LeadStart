-- =============================================
-- Migration 00060: exclude a reply/lead from a client's statistics
--
-- Clients (and the owner) had no way to remove a misclassified or junk lead
-- from the metrics on the client dashboard/reports — every classified reply
-- counted toward replies / positive / meetings totals. This flag lets a
-- reply be excluded: the native analytics roll-up (sync-analytics) skips
-- excluded rows when it recomputes campaign_snapshots, so the client's totals
-- reflect only the leads they actually count.
--
-- excluded_by records who toggled it (owner or the client's portal user);
-- excluded_at is the timestamp (also the "is it excluded" test when non-null,
-- but we keep the boolean for a cheap indexed filter in the roll-up).
-- =============================================

SET search_path TO public;

ALTER TABLE lead_replies
  ADD COLUMN IF NOT EXISTS excluded_from_stats BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS excluded_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS excluded_by UUID;
