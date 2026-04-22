-- =============================================
-- Migration 00033: webhook_auth_failures log
--
-- Records every 401 against a public webhook endpoint. Used by D1 to:
--   - Surface an at-a-glance "is someone probing us?" count in the pipeline
--     health dashboard (D4).
--   - Fire an owner alert when >=5 failures land in any 10-minute window
--     (catches a wrong-secret deploy before Instantly gives up retrying).
--
-- No organization_id: auth failed, so we can't attribute the attempt to an
-- org. This is intentional — the table is admin-only diagnostic state.
-- RLS is enabled and restricted to owner/va role; admin client (service role)
-- bypasses RLS so the webhook handler can insert from any request context.
-- =============================================

CREATE TABLE IF NOT EXISTS public.webhook_auth_failures (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  endpoint TEXT NOT NULL,
  reason TEXT,
  ip INET,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_webhook_auth_failures_endpoint_created
  ON public.webhook_auth_failures(endpoint, created_at DESC);

ALTER TABLE public.webhook_auth_failures ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admin/VA can view webhook auth failures" ON public.webhook_auth_failures;
CREATE POLICY "Admin/VA can view webhook auth failures"
  ON public.webhook_auth_failures FOR SELECT
  USING (public.get_my_role() IN ('owner', 'va'));

-- INSERT is via admin client only (from the webhook handlers). No insert
-- policy — service role bypasses RLS.
