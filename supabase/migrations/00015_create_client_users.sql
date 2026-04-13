-- =============================================
-- Migration: client_users join table
-- Replaces clients.user_id (1:1) with a many-to-many join table
-- =============================================

-- 1. Create the join table
CREATE TABLE public.client_users (
  client_id UUID NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (client_id, user_id)
);

CREATE INDEX idx_client_users_user ON public.client_users(user_id);
CREATE INDEX idx_client_users_client ON public.client_users(client_id);

-- 2. Migrate existing data
INSERT INTO public.client_users (client_id, user_id)
SELECT id, user_id FROM public.clients WHERE user_id IS NOT NULL;

-- 3. Drop old column and index
DROP INDEX IF EXISTS idx_clients_user;
ALTER TABLE public.clients DROP COLUMN user_id;

-- 4. Update handle_new_user() trigger to use client_users
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.profiles (id, email, full_name, role, organization_id)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data ->> 'full_name', ''),
    COALESCE((NEW.raw_user_meta_data ->> 'role')::app_role, 'client'),
    (NEW.raw_user_meta_data ->> 'organization_id')::UUID
  );

  IF NEW.raw_user_meta_data ->> 'client_id' IS NOT NULL THEN
    INSERT INTO public.client_users (client_id, user_id)
    VALUES ((NEW.raw_user_meta_data ->> 'client_id')::UUID, NEW.id)
    ON CONFLICT DO NOTHING;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 5. Enable RLS on client_users
ALTER TABLE public.client_users ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admin/VA can view client_users in org"
  ON public.client_users FOR SELECT
  USING (
    client_id IN (
      SELECT id FROM public.clients WHERE organization_id = public.get_my_org_id()
    )
    AND public.get_my_role() IN ('owner', 'va')
  );

CREATE POLICY "Client can view own client_users"
  ON public.client_users FOR SELECT
  USING (user_id = auth.uid());

CREATE POLICY "Owner can insert client_users"
  ON public.client_users FOR INSERT
  WITH CHECK (
    client_id IN (
      SELECT id FROM public.clients WHERE organization_id = public.get_my_org_id()
    )
    AND public.get_my_role() = 'owner'
  );

CREATE POLICY "Owner can delete client_users"
  ON public.client_users FOR DELETE
  USING (
    client_id IN (
      SELECT id FROM public.clients WHERE organization_id = public.get_my_org_id()
    )
    AND public.get_my_role() = 'owner'
  );

-- 6. Replace RLS policies that referenced clients.user_id

-- clients: "Client can view own record"
DROP POLICY IF EXISTS "Client can view own record" ON public.clients;
CREATE POLICY "Client can view own record"
  ON public.clients FOR SELECT
  USING (id IN (SELECT client_id FROM public.client_users WHERE user_id = auth.uid()));

-- campaigns: "Client can view own campaigns"
DROP POLICY IF EXISTS "Client can view own campaigns" ON public.campaigns;
CREATE POLICY "Client can view own campaigns"
  ON public.campaigns FOR SELECT
  USING (
    client_id IN (
      SELECT client_id FROM public.client_users WHERE user_id = auth.uid()
    )
  );

-- campaign_snapshots: "Client can view own campaign snapshots"
DROP POLICY IF EXISTS "Client can view own campaign snapshots" ON public.campaign_snapshots;
CREATE POLICY "Client can view own campaign snapshots"
  ON public.campaign_snapshots FOR SELECT
  USING (
    campaign_id IN (
      SELECT c.id FROM public.campaigns c
      JOIN public.client_users cu ON c.client_id = cu.client_id
      WHERE cu.user_id = auth.uid()
    )
  );

-- lead_feedback: "Client can insert feedback for their campaigns"
DROP POLICY IF EXISTS "Client can insert feedback for their campaigns" ON public.lead_feedback;
CREATE POLICY "Client can insert feedback for their campaigns"
  ON public.lead_feedback FOR INSERT
  WITH CHECK (
    campaign_id IN (
      SELECT c.id FROM public.campaigns c
      JOIN public.client_users cu ON c.client_id = cu.client_id
      WHERE cu.user_id = auth.uid()
    )
  );

-- kpi_reports: "Client can view own reports"
DROP POLICY IF EXISTS "Client can view own reports" ON public.kpi_reports;
CREATE POLICY "Client can view own reports"
  ON public.kpi_reports FOR SELECT
  USING (
    client_id IN (
      SELECT client_id FROM public.client_users WHERE user_id = auth.uid()
    )
  );
