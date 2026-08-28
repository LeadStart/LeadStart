-- SECURITY: stop client-portal users from reading the organizations secret
-- columns (all third-party keys + the Gmail service-account key + Porkbun/
-- Spaceship registrar secrets), verified exposed 2026-08-28.
--
-- Root cause: client-portal users share the agency org, so their JWT carries the
-- agency organization_id, and the organizations SELECT policy was
--   USING (id = get_my_org_id())
-- with NO role check. Any logged-in client could read every plaintext secret
-- from the browser with the public anon key.
--
-- Fix chosen = role-gate the SELECT policy to owner/va. Column-level REVOKEs do
-- NOT work here: anon/authenticated hold a TABLE-level SELECT grant that
-- supersedes per-column REVOKEs. RLS, by contrast, is evaluated regardless of
-- grants, so gating the row by role blocks clients cleanly.
--
-- Verified non-breaking: the ONLY browser reader of organizations is the admin
-- settings page (owner/va); no client-facing code reads organizations. All other
-- reads are server-side (service role, bypasses RLS). Idempotent.
--
-- Residual (tracked separately, not the acute risk): owner/va can still read the
-- raw keys via the admin settings page browser session. The full fix is moving
-- these single-tenant agency keys to Vercel env (server-only) and having the
-- settings UI report presence via a server route rather than reading raw values.

SET search_path TO public;

DROP POLICY IF EXISTS "Users can view their own org" ON organizations;

CREATE POLICY "Owners and VAs view their org" ON organizations FOR SELECT
  USING (
    id = public.get_my_org_id()
    AND public.get_my_role() IN ('owner', 'va')
  );
