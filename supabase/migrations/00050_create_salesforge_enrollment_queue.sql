-- =============================================
-- Migration 00050: Salesforge enrollment queue + per-campaign daily cap
--
-- Salesforge.ai has no per-sequence cap on how many new contacts can be
-- enrolled per day. With 8 inboxes × 25 sends/day = 200 sends/day capacity,
-- pushing a 500-contact batch in one shot overflows the send queue and
-- causes step-2/3/4 timing to drift arbitrarily as Salesforge spreads the
-- day-1 emails across multiple days.
--
-- This migration adds the storage for an app-side throttle:
--
--   1) campaigns.salesforge_daily_contact_cap — owner-tunable per-campaign
--      ceiling on how many new contacts the dispatcher will hand to
--      Salesforge per UTC day. NULL = fall back to the default in the
--      dispatcher code (currently 66, sized for a 3-step sequence on
--      200 sends/day of inbox capacity).
--
--   2) salesforge_enrollment_queue — pending bucket. The push endpoint
--      writes rows here instead of calling Salesforge synchronously. The
--      once-daily cron at /api/cron/dispatch-salesforge-enrollments
--      (12:00 UTC ≈ 5am Pacific) dequeues up to (cap - sent_today) per
--      campaign, calls pushContactsToSequence() in 100-row chunks
--      (Salesforge's bulk limit), and stamps rows as 'sent' or 'failed'.
--
-- No RLS on the queue table — same pattern as campaign_enrollments from
-- migration 00047. All access goes through the admin Supabase client
-- (owner-only endpoints + cron worker).
-- =============================================

SET search_path TO public;

-- 1) Per-campaign daily cap. NULL means "use the dispatcher default".
ALTER TABLE campaigns
  ADD COLUMN salesforge_daily_contact_cap INTEGER;

-- 2) Queue table.
CREATE TABLE salesforge_enrollment_queue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'sent', 'failed')),
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at TIMESTAMPTZ
);

-- Cron dequeue path: pending rows for a given campaign, oldest first.
CREATE INDEX idx_sf_queue_campaign_pending
  ON salesforge_enrollment_queue (campaign_id, created_at)
  WHERE status = 'pending';

-- "How many already sent today for this campaign" — drives the throttle.
CREATE INDEX idx_sf_queue_campaign_sent_processed
  ON salesforge_enrollment_queue (campaign_id, processed_at)
  WHERE status = 'sent';

-- Prevents re-queueing the same contact into the same campaign while a
-- previous row is still pending. Sent/failed rows don't block re-queue
-- (failed rows can be requeued manually after fixing the underlying issue).
CREATE UNIQUE INDEX idx_sf_queue_pending_dedup
  ON salesforge_enrollment_queue (campaign_id, contact_id)
  WHERE status = 'pending';

-- Owner-facing list views ("show me the queue for this org").
CREATE INDEX idx_sf_queue_org_status
  ON salesforge_enrollment_queue (organization_id, status, created_at);
