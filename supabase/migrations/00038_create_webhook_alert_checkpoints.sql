-- =============================================
-- Migration 00038: webhook_alert_checkpoints
--
-- Tracks the last time D1 fired an owner alert for each webhook endpoint.
-- Used only by the 401-alerting path in src/lib/notifications/webhook-auth-alerts.ts
-- to enforce a 1h per-endpoint cooldown between alert emails. Keeping this
-- in its own table (rather than a sentinel row in webhook_auth_failures)
-- means D4's pipeline-health dashboard can SELECT COUNT from
-- webhook_auth_failures without a reason != 'last_alert_sent' filter
-- every reader would have to remember.
--
-- One row per endpoint, upserted on every alert. Service role bypasses RLS
-- so the webhook handlers can write without a session.
-- =============================================

CREATE TABLE IF NOT EXISTS public.webhook_alert_checkpoints (
  endpoint TEXT PRIMARY KEY,
  last_alert_sent_at TIMESTAMPTZ NOT NULL
);

ALTER TABLE public.webhook_alert_checkpoints ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admin/VA can view webhook alert checkpoints" ON public.webhook_alert_checkpoints;
CREATE POLICY "Admin/VA can view webhook alert checkpoints"
  ON public.webhook_alert_checkpoints FOR SELECT
  USING (public.get_my_role() IN ('owner', 'va'));

-- Writes are service-role only (from the webhook handlers).
