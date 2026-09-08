-- 00128_role_gate_admin_only_rls.sql
--
-- SECURITY FIX (CRITICAL 2 + HIGH #3 of the 2026-09-08 audit).
--
-- Several tables had org-only RLS -- USING (organization_id = get_my_org_id())
-- with NO role check. Client-role users are provisioned INTO the agency's
-- organization_id (see 00009_create_auth_hook.sql), so get_my_org_id() returns
-- the agency org for a client. That means any logged-in CLIENT could read rows
-- meant for owner/va only:
--   * Billing: every OTHER client's quotes, subscriptions, invoices, pricing
--     plans, and Stripe payment links (cross-client financial exposure).
--   * Agency infrastructure: google_workspaces and sending_domains were cmd=ALL
--     org-only, so a client could READ and even WRITE/DELETE DKIM/domain/
--     workspace config (deliverability sabotage).
--   * campaign_step_metrics: all clients' per-step metrics.
--
-- Fix: add the owner/va role gate. Safe because (a) the client portal reads NONE
-- of these tables (grep-verified 2026-09-08), and (b) every server-side write
-- uses the service-role client, which bypasses RLS entirely -- so crons, admin
-- routes, and webhooks are unaffected. Only a client's direct RLS read is
-- newly denied, which is the intended change.
--
-- Verify LIVE after apply (migration files drift from prod):
--   node scripts/supabase-sql.mjs --file scripts/verify-00128-role-gate.sql
-- or re-query pg_policies. Every policy below must show a get_my_role() clause.

BEGIN;

-- ---------------------------------------------------------------------------
-- Billing cluster: SELECT limited to owner/va (was org-only, no role check).
-- ---------------------------------------------------------------------------
ALTER POLICY "Quotes viewable by org members" ON public.quotes
  USING (
    organization_id = public.get_my_org_id()
    AND public.get_my_role() = ANY (ARRAY['owner'::text, 'va'::text])
  );

ALTER POLICY "Subscriptions viewable by org members" ON public.client_subscriptions
  USING (
    organization_id = public.get_my_org_id()
    AND public.get_my_role() = ANY (ARRAY['owner'::text, 'va'::text])
  );

ALTER POLICY "Invoices viewable by org members" ON public.billing_invoices
  USING (
    organization_id = public.get_my_org_id()
    AND public.get_my_role() = ANY (ARRAY['owner'::text, 'va'::text])
  );

ALTER POLICY "Plans viewable by org members" ON public.pricing_plans
  USING (
    organization_id = public.get_my_org_id()
    AND public.get_my_role() = ANY (ARRAY['owner'::text, 'va'::text])
  );

ALTER POLICY "Payment links viewable by org members" ON public.payment_links
  USING (
    organization_id = public.get_my_org_id()
    AND public.get_my_role() = ANY (ARRAY['owner'::text, 'va'::text])
  );

-- ---------------------------------------------------------------------------
-- Agency sending infrastructure: was cmd=ALL org-only (client-readable AND
-- client-writable). Gate BOTH read (USING) and write (WITH CHECK) to owner/va.
-- ---------------------------------------------------------------------------
ALTER POLICY "google_workspaces_org_access" ON public.google_workspaces
  USING (
    organization_id = public.get_my_org_id()
    AND public.get_my_role() = ANY (ARRAY['owner'::text, 'va'::text])
  )
  WITH CHECK (
    organization_id = public.get_my_org_id()
    AND public.get_my_role() = ANY (ARRAY['owner'::text, 'va'::text])
  );

ALTER POLICY "sending_domains_org_access" ON public.sending_domains
  USING (
    organization_id = public.get_my_org_id()
    AND public.get_my_role() = ANY (ARRAY['owner'::text, 'va'::text])
  )
  WITH CHECK (
    organization_id = public.get_my_org_id()
    AND public.get_my_role() = ANY (ARRAY['owner'::text, 'va'::text])
  );

-- ---------------------------------------------------------------------------
-- Operational metrics: SELECT limited to owner/va (was any org member).
-- Org derivation simplified to get_my_org_id() (equivalent to the prior
-- profiles subquery, which resolved the caller's own org).
-- ---------------------------------------------------------------------------
ALTER POLICY "Step metrics viewable by org members" ON public.campaign_step_metrics
  USING (
    campaign_id IN (
      SELECT campaigns.id FROM public.campaigns
      WHERE campaigns.organization_id = public.get_my_org_id()
    )
    AND public.get_my_role() = ANY (ARRAY['owner'::text, 'va'::text])
  );

COMMIT;
