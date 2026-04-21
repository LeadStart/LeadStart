-- =============================================
-- Migration: add notification_token_consumed_at to lead_replies
-- Supports single-use enforcement for signed portal deep-links (commit #5).
-- Token hash is written at send-time (existing notification_token_hash);
-- consumed_at is stamped the first time the link is verified successfully.
-- Later verifies that hash to the same row but with consumed_at already set
-- are rejected by src/lib/security/signed-urls.ts.
-- =============================================

ALTER TABLE public.lead_replies
  ADD COLUMN IF NOT EXISTS notification_token_consumed_at TIMESTAMPTZ;

-- verifyReplyUrl() looks up rows by notification_token_hash, so index it.
-- Partial: only populated rows matter for the lookup.
CREATE INDEX IF NOT EXISTS idx_lead_replies_notification_token_hash
  ON public.lead_replies(notification_token_hash)
  WHERE notification_token_hash IS NOT NULL;
