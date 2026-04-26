-- =============================================
-- Migration 00041: owner_alerts queue + kpi_reports delivery tracking
--
-- Two related concerns, one migration:
--
-- 1) Track Resend message IDs + delivery state on KPI report sends so the
--    Resend webhook can correlate `email.delivered` / `email.bounced` /
--    `email.complained` events back to the report row that fired them.
--    Without this, a report that Resend accepts but the recipient's mail
--    server rejects is silently invisible inside the app.
--
-- 2) Stand up an owner-alert queue that's drained on a 5-min cron into one
--    digest email to every profile where role = 'owner'. Failure events
--    enqueue a row; the cron coalesces all pending rows into one send so a
--    burst (e.g., 8 reports failing in the same hourly cron) lands as one
--    email instead of eight. Per-event coalescing rather than per-kind so
--    the digest preserves chronological ordering and full detail.
--
-- The alert path itself uses Resend, so a fully-down Resend can't deliver
-- alerts. Mitigation is a daily heartbeat (separate follow-up). Until then,
-- if the alert fails to send, sent_at stays NULL and the next cron run
-- retries — alert events are not lost on transient Resend outages.
-- =============================================

-- ── Part 1: kpi_reports delivery tracking ─────────────────────────────
ALTER TABLE public.kpi_reports
  ADD COLUMN IF NOT EXISTS resend_email_id TEXT,
  ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS bounced_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS bounce_type TEXT;

-- The webhook handler looks up rows by Resend's message id. Partial index
-- so we don't bloat with NULLs from older rows that pre-date this column.
CREATE INDEX IF NOT EXISTS idx_kpi_reports_resend_email_id
  ON public.kpi_reports (resend_email_id)
  WHERE resend_email_id IS NOT NULL;


-- ── Part 2: owner_alerts queue ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.owner_alerts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- 'report_send_error' | 'email_hard_bounce' | 'email_complaint'
  -- | 'hot_lead_persistent_failure'
  kind TEXT NOT NULL,
  subject TEXT NOT NULL,
  body_html TEXT NOT NULL,
  -- Structured details kept for the digest UI later (admin page) and so
  -- coalescer can dedup near-duplicate events without parsing HTML.
  context JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- NULL = pending. Stamped when the digest email containing this row
  -- was successfully accepted by Resend.
  sent_at TIMESTAMPTZ
);

-- Drain query: pending rows ordered by creation time. Partial index keeps
-- the index tiny — sent rows are the long-tail majority.
CREATE INDEX IF NOT EXISTS idx_owner_alerts_pending
  ON public.owner_alerts (created_at)
  WHERE sent_at IS NULL;

ALTER TABLE public.owner_alerts ENABLE ROW LEVEL SECURITY;

-- Owners and VAs can read the audit trail in the admin UI.
DROP POLICY IF EXISTS "Admin/VA can view owner alerts" ON public.owner_alerts;
CREATE POLICY "Admin/VA can view owner alerts"
  ON public.owner_alerts FOR SELECT
  USING (public.get_my_role() IN ('owner', 'va'));

-- All writes go through the admin client (service role bypasses RLS).
