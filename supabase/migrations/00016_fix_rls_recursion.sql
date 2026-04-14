-- Fix infinite recursion: client_users ↔ clients RLS circular dependency
--
-- Problem: clients RLS checks client_users, client_users RLS checks clients → loop
-- Solution: SECURITY DEFINER helper function bypasses RLS for the org lookup,
--           breaking the cycle.

-- Helper: returns client IDs in an org WITHOUT triggering clients RLS
CREATE OR REPLACE FUNCTION public.client_ids_for_org(org_id UUID)
RETURNS SETOF UUID
LANGUAGE SQL STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT id FROM public.clients WHERE organization_id = org_id;
$$;

GRANT EXECUTE ON FUNCTION public.client_ids_for_org TO authenticated;

-- Recreate client_users policies using the helper
DROP POLICY IF EXISTS "Admin/VA can view client_users in org" ON public.client_users;
CREATE POLICY "Admin/VA can view client_users in org"
  ON public.client_users FOR SELECT
  USING (
    client_id IN (SELECT public.client_ids_for_org(public.get_my_org_id()))
    AND public.get_my_role() IN ('owner', 'va')
  );

DROP POLICY IF EXISTS "Owner can insert client_users" ON public.client_users;
CREATE POLICY "Owner can insert client_users"
  ON public.client_users FOR INSERT
  WITH CHECK (
    client_id IN (SELECT public.client_ids_for_org(public.get_my_org_id()))
    AND public.get_my_role() = 'owner'
  );

DROP POLICY IF EXISTS "Owner can delete client_users" ON public.client_users;
CREATE POLICY "Owner can delete client_users"
  ON public.client_users FOR DELETE
  USING (
    client_id IN (SELECT public.client_ids_for_org(public.get_my_org_id()))
    AND public.get_my_role() = 'owner'
  );
