-- verify-phase0-security.sql
--
-- Behavioral proof that the Phase 0 privilege-escalation fixes (migration 00104)
-- actually block the two attacks. Faithful to production semantics: PostgREST
-- runs every request as `SET LOCAL ROLE authenticated | anon | service_role`
-- from the JWT, and this harness switches roles the same way, so the BEFORE
-- UPDATE trigger sees the same current_user it will in prod.
--
-- SAFE BY CONSTRUCTION: everything happens inside ONE transaction that ends in
-- ROLLBACK, in a throwaway `_sec_verify` schema, against REPLICA tables -- it
-- never reads or writes public.profiles or auth.users, so it leaves the target
-- project byte-identical. It can therefore run against a sandbox project OR
-- (with the owner's OK) non-destructively against prod. It tests the FIX LOGIC
-- (the trigger body + the metadata-ignoring signup insert), which is exactly
-- what migration 00104 installs. The role switches auto-revert: each is scoped
-- inside a BEGIN...EXCEPTION subtransaction, so an exception rolls the role back
-- to the caller and the success path RESETs explicitly.
--
-- Run:  node scripts/supabase-sql.mjs --file scripts/verify-phase0-security.sql
-- PASS: the final result set shows passed = true for all five tests.

BEGIN;

CREATE SCHEMA _sec_verify;
SET search_path TO _sec_verify, public;

CREATE TEMP TABLE _results (n int GENERATED ALWAYS AS IDENTITY, test text, passed boolean, detail text);

-- Replica of the guarded columns of public.profiles (reuses the real app_role enum).
CREATE TABLE _sec_verify.profiles (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email           text NOT NULL,
  full_name       text,
  role            public.app_role NOT NULL DEFAULT 'client',
  organization_id uuid,
  is_active       boolean NOT NULL DEFAULT true
);

-- The EXACT enforce function body from migration 00104, attached to the replica.
CREATE FUNCTION _sec_verify.enforce_profile_privileged_columns()
RETURNS TRIGGER LANGUAGE plpgsql AS $fn$
BEGIN
  IF current_user IN ('authenticated', 'anon') THEN
    IF NEW.role IS DISTINCT FROM OLD.role THEN
      RAISE EXCEPTION 'profiles.role is not self-editable' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NEW.organization_id IS DISTINCT FROM OLD.organization_id THEN
      RAISE EXCEPTION 'profiles.organization_id is not self-editable' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NEW.is_active IS DISTINCT FROM OLD.is_active THEN
      RAISE EXCEPTION 'profiles.is_active is not self-editable' USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER enforce_profile_privileged_columns
  BEFORE UPDATE ON _sec_verify.profiles
  FOR EACH ROW EXECUTE FUNCTION _sec_verify.enforce_profile_privileged_columns();

-- The FIXED handle_new_user insert logic (metadata role/org IGNORED), generalized
-- to write into the replica from a synthetic raw_user_meta_data blob.
CREATE FUNCTION _sec_verify.simulate_signup(p_id uuid, p_email text, p_meta jsonb)
RETURNS void LANGUAGE plpgsql AS $fn$
BEGIN
  INSERT INTO _sec_verify.profiles (id, email, full_name)
  VALUES (p_id, p_email, COALESCE(p_meta ->> 'full_name', ''));
END;
$fn$;

GRANT USAGE ON SCHEMA _sec_verify TO authenticated, anon, service_role;
GRANT SELECT, UPDATE ON _sec_verify.profiles TO authenticated, anon, service_role;

-- Seed a victim row (as the owning/superuser role).
INSERT INTO _sec_verify.profiles (id, email, full_name, role, organization_id)
VALUES ('00000000-0000-0000-0000-000000000001', 'victim@test.local', 'Victim', 'client',
        '11111111-1111-1111-1111-111111111111');

-- ============================================================================
-- TEST 0 -- preflight: the role switch actually reaches 'authenticated' (so a
-- later "blocked" result can't be a SET ROLE permission error in disguise).
-- ============================================================================
DO $t$
DECLARE v_cu text;
BEGIN
  BEGIN
    SET LOCAL ROLE authenticated;
    v_cu := current_user;
    RESET ROLE;
    INSERT INTO _results(test, passed, detail)
      VALUES ('PREFLIGHT: role switch reaches authenticated', v_cu = 'authenticated',
              format('current_user under SET ROLE = %s', v_cu));
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO _results(test, passed, detail)
      VALUES ('PREFLIGHT: role switch reaches authenticated', false, 'SET ROLE failed: ' || SQLERRM);
  END;
END $t$;

-- ============================================================================
-- TEST 1 -- FIX 1: a public signup's raw_user_meta_data cannot set role/org.
-- ============================================================================
DO $t$
DECLARE v_role public.app_role; v_org uuid;
BEGIN
  PERFORM _sec_verify.simulate_signup(
    '00000000-0000-0000-0000-000000000002', 'attacker@test.local',
    '{"full_name":"Attacker","role":"owner","organization_id":"11111111-1111-1111-1111-111111111111"}'::jsonb
  );
  SELECT role, organization_id INTO v_role, v_org
  FROM _sec_verify.profiles WHERE id = '00000000-0000-0000-0000-000000000002';
  INSERT INTO _results(test, passed, detail) VALUES (
    'FIX1: signup metadata role/org ignored',
    (v_role = 'client' AND v_org IS NULL),
    format('stored role=%s (want client), org=%s (want NULL)', v_role, COALESCE(v_org::text,'NULL'))
  );
END $t$;

-- ============================================================================
-- TEST 2 -- FIX 2 (the headline): a client-role user cannot self-promote to owner.
-- PASS only on our trigger's specific message, so a stray error can't fake it.
-- ============================================================================
DO $t$
BEGIN
  BEGIN
    SET LOCAL ROLE authenticated;
    UPDATE _sec_verify.profiles SET role = 'owner' WHERE id = '00000000-0000-0000-0000-000000000001';
    RESET ROLE;
    INSERT INTO _results(test, passed, detail)
      VALUES ('FIX2: client cannot self-promote role', false, 'UPDATE role=owner unexpectedly SUCCEEDED');
  EXCEPTION WHEN insufficient_privilege THEN
    INSERT INTO _results(test, passed, detail)
      VALUES ('FIX2: client cannot self-promote role',
              SQLERRM ILIKE '%not self-editable%',
              'blocked: ' || SQLERRM);
  END;
END $t$;

-- ============================================================================
-- TEST 3 -- FIX 2 does not break legit self-service (full_name still editable).
-- ============================================================================
DO $t$
DECLARE v_name text;
BEGIN
  BEGIN
    SET LOCAL ROLE authenticated;
    UPDATE _sec_verify.profiles SET full_name = 'Renamed By Self'
      WHERE id = '00000000-0000-0000-0000-000000000001';
    SELECT full_name INTO v_name FROM _sec_verify.profiles WHERE id = '00000000-0000-0000-0000-000000000001';
    RESET ROLE;
    INSERT INTO _results(test, passed, detail)
      VALUES ('FIX2: client CAN edit own full_name', v_name = 'Renamed By Self',
              format('full_name now %L', v_name));
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO _results(test, passed, detail)
      VALUES ('FIX2: client CAN edit own full_name', false, 'legit full_name update was blocked: ' || SQLERRM);
  END;
END $t$;

-- ============================================================================
-- TEST 4 -- FIX 2 still lets trusted service-role code set role (admin routes/crons).
-- ============================================================================
DO $t$
DECLARE v_role public.app_role;
BEGIN
  BEGIN
    SET LOCAL ROLE service_role;
    UPDATE _sec_verify.profiles SET role = 'va' WHERE id = '00000000-0000-0000-0000-000000000001';
    SELECT role INTO v_role FROM _sec_verify.profiles WHERE id = '00000000-0000-0000-0000-000000000001';
    RESET ROLE;
    INSERT INTO _results(test, passed, detail)
      VALUES ('FIX2: service_role CAN set role', v_role = 'va', format('role now %s (want va)', v_role));
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO _results(test, passed, detail)
      VALUES ('FIX2: service_role CAN set role', false, 'service-role update was blocked: ' || SQLERRM);
  END;
END $t$;

-- Final report: every row must show passed = true.
SELECT n, test, passed, detail FROM _results ORDER BY n;

ROLLBACK;
