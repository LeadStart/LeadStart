-- Enable RLS on all tables
ALTER TABLE public.organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.clients ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.campaign_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lead_feedback ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.kpi_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.webhook_events ENABLE ROW LEVEL SECURITY;

-- Helper: get current user's org from JWT
CREATE OR REPLACE FUNCTION public.get_my_org_id()
RETURNS UUID AS $$
  SELECT (auth.jwt() -> 'app_metadata' ->> 'organization_id')::UUID;
$$ LANGUAGE SQL STABLE SECURITY DEFINER;

-- Helper: get current user's role from JWT
CREATE OR REPLACE FUNCTION public.get_my_role()
RETURNS TEXT AS $$
  SELECT auth.jwt() -> 'app_metadata' ->> 'role';
$$ LANGUAGE SQL STABLE SECURITY DEFINER;

-- ===== ORGANIZATIONS =====
CREATE POLICY "Users can view their own org"
  ON public.organizations FOR SELECT
  USING (id = public.get_my_org_id());

CREATE POLICY "Owner can update their org"
  ON public.organizations FOR UPDATE
  USING (id = public.get_my_org_id() AND public.get_my_role() = 'owner');

-- ===== PROFILES =====
CREATE POLICY "Users can view profiles in their org"
  ON public.profiles FOR SELECT
  USING (organization_id = public.get_my_org_id());

CREATE POLICY "Users can update their own profile"
  ON public.profiles FOR UPDATE
  USING (id = auth.uid());

-- ===== CLIENTS =====
CREATE POLICY "Admin/VA can view all clients in org"
  ON public.clients FOR SELECT
  USING (
    organization_id = public.get_my_org_id()
    AND public.get_my_role() IN ('owner', 'va')
  );

CREATE POLICY "Client can view own record"
  ON public.clients FOR SELECT
  USING (user_id = auth.uid());

CREATE POLICY "Owner can manage clients"
  ON public.clients FOR INSERT
  WITH CHECK (
    organization_id = public.get_my_org_id()
    AND public.get_my_role() = 'owner'
  );

CREATE POLICY "Owner can update clients"
  ON public.clients FOR UPDATE
  USING (
    organization_id = public.get_my_org_id()
    AND public.get_my_role() = 'owner'
  );

CREATE POLICY "Owner can delete clients"
  ON public.clients FOR DELETE
  USING (
    organization_id = public.get_my_org_id()
    AND public.get_my_role() = 'owner'
  );

-- ===== CAMPAIGNS =====
CREATE POLICY "Admin/VA can view all campaigns in org"
  ON public.campaigns FOR SELECT
  USING (
    organization_id = public.get_my_org_id()
    AND public.get_my_role() IN ('owner', 'va')
  );

CREATE POLICY "Client can view own campaigns"
  ON public.campaigns FOR SELECT
  USING (
    client_id IN (
      SELECT id FROM public.clients WHERE user_id = auth.uid()
    )
  );

CREATE POLICY "Owner can manage campaigns"
  ON public.campaigns FOR INSERT
  WITH CHECK (
    organization_id = public.get_my_org_id()
    AND public.get_my_role() = 'owner'
  );

CREATE POLICY "Owner can update campaigns"
  ON public.campaigns FOR UPDATE
  USING (
    organization_id = public.get_my_org_id()
    AND public.get_my_role() = 'owner'
  );

-- ===== CAMPAIGN SNAPSHOTS =====
CREATE POLICY "Admin/VA can view all snapshots"
  ON public.campaign_snapshots FOR SELECT
  USING (
    campaign_id IN (
      SELECT id FROM public.campaigns
      WHERE organization_id = public.get_my_org_id()
    )
    AND public.get_my_role() IN ('owner', 'va')
  );

CREATE POLICY "Client can view own campaign snapshots"
  ON public.campaign_snapshots FOR SELECT
  USING (
    campaign_id IN (
      SELECT c.id FROM public.campaigns c
      JOIN public.clients cl ON c.client_id = cl.id
      WHERE cl.user_id = auth.uid()
    )
  );

-- Service role handles inserts (from cron/API routes)

-- ===== LEAD FEEDBACK =====
CREATE POLICY "Client can insert feedback for their campaigns"
  ON public.lead_feedback FOR INSERT
  WITH CHECK (
    campaign_id IN (
      SELECT c.id FROM public.campaigns c
      JOIN public.clients cl ON c.client_id = cl.id
      WHERE cl.user_id = auth.uid()
    )
  );

CREATE POLICY "Admin/VA can view all feedback in org"
  ON public.lead_feedback FOR SELECT
  USING (
    campaign_id IN (
      SELECT id FROM public.campaigns
      WHERE organization_id = public.get_my_org_id()
    )
    AND public.get_my_role() IN ('owner', 'va')
  );

CREATE POLICY "Client can view own feedback"
  ON public.lead_feedback FOR SELECT
  USING (submitted_by = auth.uid());

-- ===== KPI REPORTS =====
CREATE POLICY "Admin/VA can view all reports in org"
  ON public.kpi_reports FOR SELECT
  USING (
    organization_id = public.get_my_org_id()
    AND public.get_my_role() IN ('owner', 'va')
  );

CREATE POLICY "Client can view own reports"
  ON public.kpi_reports FOR SELECT
  USING (
    client_id IN (
      SELECT id FROM public.clients WHERE user_id = auth.uid()
    )
  );

CREATE POLICY "Owner can manage reports"
  ON public.kpi_reports FOR INSERT
  WITH CHECK (
    organization_id = public.get_my_org_id()
    AND public.get_my_role() = 'owner'
  );

-- ===== WEBHOOK EVENTS =====
CREATE POLICY "Admin can view webhook events"
  ON public.webhook_events FOR SELECT
  USING (
    organization_id = public.get_my_org_id()
    AND public.get_my_role() IN ('owner', 'va')
  );
