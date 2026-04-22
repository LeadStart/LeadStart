-- =============================================
-- Migration 00032: Notification reliability columns on lead_replies
--
-- Adds the per-row state a retry queue needs to reason about a failed or
-- pending hot-lead notification. Populated by:
--   - send-hot-lead pipeline (status transitions)
--   - future C1 retry cron (src/app/api/cron/retry-notifications/route.ts)
--   - future C3 Resend delivery webhook (delivered / bounced timestamps)
--
-- Column semantics:
--   notification_status         'pending' (default — includes orphan-awaiting-link
--                                case) | 'sent' | 'failed' | 'retrying'
--                               Plain TEXT, no CHECK, matching SAFETY-TODO
--                               spec. The retry cron filters on exact values.
--   notification_retry_count    incremented by retry cron each attempt; used to
--                               cap retries at 5 per SAFETY-TODO C1.
--   notification_last_attempt_at Wall-clock of the most recent send attempt;
--                               drives exponential backoff in the retry cron.
--   notification_last_error     Transient error string from Resend / the
--                               wrapper (e.g. "rate_limited", "5xx"). Owner
--                               feedback: do NOT reuse this for routing /
--                               orphan state — it's strictly for transient
--                               send failures so C1's retry logic stays clean.
--   notification_delivered_at   Populated by C3 Resend webhook on
--                               email.delivered. Distinct from notified_at,
--                               which records our Resend accept-time.
--   notification_bounced_at     Populated by C3 on email.bounced /
--                               email.complained.
-- =============================================

ALTER TABLE public.lead_replies
  ADD COLUMN IF NOT EXISTS notification_status TEXT NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS notification_retry_count INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS notification_last_attempt_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS notification_last_error TEXT,
  ADD COLUMN IF NOT EXISTS notification_delivered_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS notification_bounced_at TIMESTAMPTZ;

-- Index for C1's retry cron: "find rows needing retry, oldest first."
-- Partial to keep it tiny — the sent/pending majority is excluded.
CREATE INDEX IF NOT EXISTS idx_lead_replies_notification_retry
  ON public.lead_replies(notification_last_attempt_at)
  WHERE notification_status IN ('failed', 'retrying');

-- Backfill: any row that successfully hit Resend before this migration
-- landed already has notified_at set; those are 'sent'. The default
-- 'pending' is correct for every other row (including rows that never
-- classified as hot and so were never sent — they sit pending with
-- client_id populated, harmless to future retry logic since
-- notification_last_attempt_at stays NULL).
UPDATE public.lead_replies
  SET notification_status = 'sent'
  WHERE notified_at IS NOT NULL
    AND notification_status = 'pending';
