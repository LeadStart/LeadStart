-- 00104_harden_profile_privileges.sql
--
-- SECURITY FIX (Phase 0 of the token-based contact-sourcing product; both holes
-- are exploitable TODAY, independent of that product). Verified against the LIVE
-- prod DB, project exedxjrifprqgftyuroc, 2026-08-30 (the shipped objects match
-- migrations 00015 / 00008 exactly — no drift). Two privilege-escalation paths:
--
--   1. handle_new_user() inserts role + organization_id STRAIGHT from
--      NEW.raw_user_meta_data (00015:37-50). On a public auth.signUp() the caller
--      controls raw_user_meta_data entirely, so a stranger could sign up with
--      { role: 'owner', organization_id: '<agency org>' } and mint an owner in
--      the agency org (or attach themselves to any client via client_id). P0 the
--      moment public email signups are enabled.
--
--   2. The "Users can update their own profile" RLS policy (00008:37-39) has
--      USING (id = auth.uid()) and NO column guard / WITH CHECK, so any
--      logged-in user can  UPDATE profiles SET role='owner'  on their own row.
--      The custom_access_token_hook (00009) reads profiles.role into
--      app_metadata.role at token issuance, so that self-write becomes a real
--      owner on the next refresh. P0 self-promotion for every existing account.
--
-- Idempotent (CREATE OR REPLACE + DROP TRIGGER IF EXISTS). Safe to re-run.

SET search_path TO public;

-- ============================================================================
-- FIX 1 — handle_new_user() no longer trusts caller-supplied privileged fields.
-- ============================================================================
-- The trigger now writes ONLY the non-privileged display fields (id, email,
-- full_name). role falls back to its column default ('client'); organization_id
-- stays NULL. Privileged assignment is the job of trusted service-role
-- provisioning code: /api/invite already upserts the profile row (role +
-- organization_id) and the client_users link right after generateLink(), so
-- stripping the metadata trust here breaks no existing flow. A user created by
-- hand in the Supabase dashboard now lands as a role='client' / no-org profile
-- until an owner assigns role/org via Admin -> Settings -> Team (by design).
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.profiles (id, email, full_name)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data ->> 'full_name', '')
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ============================================================================
-- FIX 2 — a BEFORE UPDATE trigger pins the privileged columns for end users.
-- ============================================================================
-- Pure RLS can't do this: an UPDATE policy can only constrain the NEW row's
-- absolute values, never compare NEW vs OLD, so it cannot express "you may not
-- CHANGE your role". A BEFORE UPDATE trigger can. It runs SECURITY INVOKER
-- (default), so current_user is the PostgREST role the request runs under:
-- 'authenticated' / 'anon' for end users, 'service_role' for trusted server
-- code (invite/team/accept-invite routes, crons) which is exempted (and bypasses
-- RLS anyway). End users keep full self-service on the non-privileged columns
-- (the only anon self-update in the app sets full_name — client/settings) but
-- can no longer change role, organization_id, or is_active. Sending extra fields
-- can't bypass it the way an RLS-only column list could.
CREATE OR REPLACE FUNCTION public.enforce_profile_privileged_columns()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF current_user IN ('authenticated', 'anon') THEN
    IF NEW.role IS DISTINCT FROM OLD.role THEN
      RAISE EXCEPTION 'profiles.role is not self-editable'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NEW.organization_id IS DISTINCT FROM OLD.organization_id THEN
      RAISE EXCEPTION 'profiles.organization_id is not self-editable'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NEW.is_active IS DISTINCT FROM OLD.is_active THEN
      RAISE EXCEPTION 'profiles.is_active is not self-editable'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS enforce_profile_privileged_columns ON public.profiles;
CREATE TRIGGER enforce_profile_privileged_columns
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_profile_privileged_columns();
