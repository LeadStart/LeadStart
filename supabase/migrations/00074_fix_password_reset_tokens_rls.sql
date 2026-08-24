-- Fix Supabase Advisor CRITICAL findings (2026-08-24): RLS disabled + sensitive
-- columns exposed on public.password_reset_tokens.
--
-- Migration 00018 already ran ENABLE ROW LEVEL SECURITY, but prod drifted
-- (rowsecurity was false in a live audit — the table likely pre-dated the
-- migration file, so CREATE TABLE IF NOT EXISTS no-op'd and the ALTER never ran
-- against it, or RLS was disabled ad hoc). Re-assert it, and revoke the
-- PostgREST-exposed roles' grants as defense in depth so a future RLS toggle
-- can't re-expose reset tokens. The app only touches this table through the
-- service-role client (src/app/api/reset-password/route.ts), which is
-- unaffected by both statements.

ALTER TABLE public.password_reset_tokens ENABLE ROW LEVEL SECURITY;

-- No policies on purpose: with RLS on and zero policies, anon/authenticated get
-- deny-all. service_role bypasses RLS.
REVOKE ALL ON TABLE public.password_reset_tokens FROM anon, authenticated;
