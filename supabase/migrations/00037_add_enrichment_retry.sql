-- =============================================
-- Migration 00037: Enrichment retry state on lead_replies
--
-- Pairs with 00036 (which added the 'pending_enrichment' + 'enrichment_failed'
-- enum values). Adds the per-row state the retry cron needs to drive an
-- un-enriched reply toward either success or terminal failure.
--
-- Columns:
--   enrichment_retry_count       incremented per retry attempt, capped at 5
--                                by src/app/api/cron/retry-enrichment/route.ts.
--   enrichment_last_attempt_at   drives exponential backoff (same formula
--                                as C1: 2^(count-1) minutes).
--
-- Partial index stays tiny because 'pending_enrichment' is transient —
-- rows live there for minutes to hours, not permanently.
-- =============================================

ALTER TABLE public.lead_replies
  ADD COLUMN IF NOT EXISTS enrichment_retry_count INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS enrichment_last_attempt_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_lead_replies_pending_enrichment
  ON public.lead_replies(enrichment_last_attempt_at)
  WHERE status = 'pending_enrichment';
