-- 00100_enable_rls_on_exposed_tables.sql
--
-- SECURITY FIX (verified against the LIVE prod DB, project exedxjrifprqgftyuroc,
-- 2026-08-29). Three public-schema tables have RLS disabled AND full grants to
-- the anon + authenticated roles. The anon key ships in the browser bundle
-- (NEXT_PUBLIC_SUPABASE_ANON_KEY), so anyone can read/write these tables through
-- the auto-generated PostgREST API today:
--
--   * password_reset_tokens  -- token + email + user_id readable by anon =>
--                               account-takeover path (pull a live token, reset
--                               any user's password). P0. The REVOKE in an
--                               earlier migration never took effect live.
--   * google_workspaces      -- admin_email + license/provisioning config per org.
--   * sending_domains        -- sending-domain config per org.
--
-- Every server/cron caller of all three uses the service-role client, which
-- BYPASSES RLS, so this change breaks no code path (verified: reset-password
-- route, admin/workspaces, admin/domains*, the domain/lifecycle crons, and the
-- registrar libs all go through the admin client). No browser/SSR-user path
-- reads any of the three.
--
-- The other 45 public tables already have RLS enabled in prod (some were toggled
-- on in the dashboard rather than by migration), so they are intentionally left
-- untouched here. Idempotent: safe to re-run.

-- 1) password_reset_tokens — server-only token store. Deny-all under RLS
-- (service_role still bypasses), plus re-assert the intended grant revoke as
-- defense in depth. No policy on purpose: nothing legitimate uses the anon or
-- authenticated role against this table.
ALTER TABLE public.password_reset_tokens ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.password_reset_tokens FROM anon, authenticated;

-- 2) google_workspaces — org-scoped, mirrors the shipped contacts_org_access
-- pattern (get_my_org_id() reads organization_id from the JWT; anon has none,
-- so anon is denied; owner/VA see only their own org).
ALTER TABLE public.google_workspaces ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS google_workspaces_org_access ON public.google_workspaces;
CREATE POLICY google_workspaces_org_access ON public.google_workspaces
  FOR ALL
  USING (organization_id = public.get_my_org_id())
  WITH CHECK (organization_id = public.get_my_org_id());

-- 3) sending_domains — same org-scoped pattern.
ALTER TABLE public.sending_domains ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS sending_domains_org_access ON public.sending_domains;
CREATE POLICY sending_domains_org_access ON public.sending_domains
  FOR ALL
  USING (organization_id = public.get_my_org_id())
  WITH CHECK (organization_id = public.get_my_org_id());
