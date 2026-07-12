-- =============================================
-- Migration 00062: RLS lockdown for the client-reachable surface
--
-- Context: client-portal users authenticate with the shared anon key, and
-- their JWT carries the agency's organization_id. Two exposures existed:
--
--   1. contacts had a single org-wide FOR ALL policy (00010), so any client
--      login could read/write EVERY contact in the org — other clients'
--      lists and LeadStart's own CRM prospects — straight from the browser.
--   2. Eight newer tables had RLS disabled entirely (the "admin-client only"
--      comments in 00047/00050/00056/00059/00061 were wrong: Supabase grants
--      table access to the authenticated role by default, so any logged-in
--      user could SELECT/INSERT/UPDATE/DELETE all rows via PostgREST).
--
-- This migration:
--   - Replaces the contacts policy with owner/va-only (no client page reads
--     contacts from the browser; the client CSV import goes through the
--     service-role API route /api/campaigns/[id]/client-import).
--   - Enables RLS on the eight exposed tables. Owner/va keep org-scoped
--     FOR ALL (deliberately not SELECT-only: admin pages do direct browser
--     writes elsewhere and owner/va are the trusted operators — this shape
--     matches the original contacts policy and removes any regression risk).
--   - Grants clients SELECT-only on campaign_steps + campaign_enrollments
--     scoped to their own campaigns via client_users — the client LinkedIn
--     campaign page reads both from the browser.
--
-- Service-role (crons, API routes using createAdminClient) bypasses RLS and
-- is unaffected.
--
-- Idempotent: safe to re-run. Apply by hand in the Supabase dashboard SQL
-- editor (project exedxjrifprqgftyuroc).
-- =============================================

SET search_path TO public;

-- ========== A) contacts: owner/va only ====================================

DROP POLICY IF EXISTS contacts_org_access ON public.contacts;
DROP POLICY IF EXISTS contacts_admin_all ON public.contacts;
CREATE POLICY contacts_admin_all ON public.contacts
  FOR ALL
  USING (
    organization_id = public.get_my_org_id()
    AND public.get_my_role() IN ('owner', 'va')
  )
  WITH CHECK (
    organization_id = public.get_my_org_id()
    AND public.get_my_role() IN ('owner', 'va')
  );

-- ========== B) enable RLS on the exposed tables ===========================

ALTER TABLE public.campaign_steps             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.campaign_enrollments       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.native_mailboxes           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.native_sends               ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.campaign_mailboxes         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.dnc_entries                ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.salesforge_enrollment_queue ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mailbox_health_checks      ENABLE ROW LEVEL SECURITY;

-- ========== C) owner/va org-scoped FOR ALL ================================
-- Tables without an organization_id column scope through their campaign.

DROP POLICY IF EXISTS campaign_steps_admin_all ON public.campaign_steps;
CREATE POLICY campaign_steps_admin_all ON public.campaign_steps
  FOR ALL
  USING (
    public.get_my_role() IN ('owner', 'va')
    AND campaign_id IN (
      SELECT id FROM public.campaigns
      WHERE organization_id = public.get_my_org_id()
    )
  )
  WITH CHECK (
    public.get_my_role() IN ('owner', 'va')
    AND campaign_id IN (
      SELECT id FROM public.campaigns
      WHERE organization_id = public.get_my_org_id()
    )
  );

DROP POLICY IF EXISTS campaign_enrollments_admin_all ON public.campaign_enrollments;
CREATE POLICY campaign_enrollments_admin_all ON public.campaign_enrollments
  FOR ALL
  USING (
    public.get_my_role() IN ('owner', 'va')
    AND campaign_id IN (
      SELECT id FROM public.campaigns
      WHERE organization_id = public.get_my_org_id()
    )
  )
  WITH CHECK (
    public.get_my_role() IN ('owner', 'va')
    AND campaign_id IN (
      SELECT id FROM public.campaigns
      WHERE organization_id = public.get_my_org_id()
    )
  );

DROP POLICY IF EXISTS campaign_mailboxes_admin_all ON public.campaign_mailboxes;
CREATE POLICY campaign_mailboxes_admin_all ON public.campaign_mailboxes
  FOR ALL
  USING (
    public.get_my_role() IN ('owner', 'va')
    AND campaign_id IN (
      SELECT id FROM public.campaigns
      WHERE organization_id = public.get_my_org_id()
    )
  )
  WITH CHECK (
    public.get_my_role() IN ('owner', 'va')
    AND campaign_id IN (
      SELECT id FROM public.campaigns
      WHERE organization_id = public.get_my_org_id()
    )
  );

DROP POLICY IF EXISTS native_mailboxes_admin_all ON public.native_mailboxes;
CREATE POLICY native_mailboxes_admin_all ON public.native_mailboxes
  FOR ALL
  USING (
    organization_id = public.get_my_org_id()
    AND public.get_my_role() IN ('owner', 'va')
  )
  WITH CHECK (
    organization_id = public.get_my_org_id()
    AND public.get_my_role() IN ('owner', 'va')
  );

DROP POLICY IF EXISTS native_sends_admin_all ON public.native_sends;
CREATE POLICY native_sends_admin_all ON public.native_sends
  FOR ALL
  USING (
    organization_id = public.get_my_org_id()
    AND public.get_my_role() IN ('owner', 'va')
  )
  WITH CHECK (
    organization_id = public.get_my_org_id()
    AND public.get_my_role() IN ('owner', 'va')
  );

DROP POLICY IF EXISTS dnc_entries_admin_all ON public.dnc_entries;
CREATE POLICY dnc_entries_admin_all ON public.dnc_entries
  FOR ALL
  USING (
    organization_id = public.get_my_org_id()
    AND public.get_my_role() IN ('owner', 'va')
  )
  WITH CHECK (
    organization_id = public.get_my_org_id()
    AND public.get_my_role() IN ('owner', 'va')
  );

DROP POLICY IF EXISTS sfq_admin_all ON public.salesforge_enrollment_queue;
CREATE POLICY sfq_admin_all ON public.salesforge_enrollment_queue
  FOR ALL
  USING (
    organization_id = public.get_my_org_id()
    AND public.get_my_role() IN ('owner', 'va')
  )
  WITH CHECK (
    organization_id = public.get_my_org_id()
    AND public.get_my_role() IN ('owner', 'va')
  );

DROP POLICY IF EXISTS mailbox_health_checks_admin_all ON public.mailbox_health_checks;
CREATE POLICY mailbox_health_checks_admin_all ON public.mailbox_health_checks
  FOR ALL
  USING (
    organization_id = public.get_my_org_id()
    AND public.get_my_role() IN ('owner', 'va')
  )
  WITH CHECK (
    organization_id = public.get_my_org_id()
    AND public.get_my_role() IN ('owner', 'va')
  );

-- ========== D) client read access where the portal needs it ===============
-- The client LinkedIn campaign page (linkedin-client-campaign.tsx) reads
-- steps + enrollments from the browser. SELECT only, own campaigns only.

DROP POLICY IF EXISTS campaign_steps_client_read ON public.campaign_steps;
CREATE POLICY campaign_steps_client_read ON public.campaign_steps
  FOR SELECT
  USING (
    campaign_id IN (
      SELECT c.id
      FROM public.campaigns c
      JOIN public.client_users cu ON c.client_id = cu.client_id
      WHERE cu.user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS campaign_enrollments_client_read ON public.campaign_enrollments;
CREATE POLICY campaign_enrollments_client_read ON public.campaign_enrollments
  FOR SELECT
  USING (
    campaign_id IN (
      SELECT c.id
      FROM public.campaigns c
      JOIN public.client_users cu ON c.client_id = cu.client_id
      WHERE cu.user_id = auth.uid()
    )
  );
