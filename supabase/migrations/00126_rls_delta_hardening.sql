-- 00126_rls_delta_hardening.sql
--
-- RLS delta for the 12 tables introduced by migrations 00101-00122, verified
-- against the LIVE prod DB (project exedxjrifprqgftyuroc) on 2026-09-05 through
-- the Management API, read-only (pg_class.relrowsecurity / relacl, pg_policies,
-- has_table_privilege). The migration FILES are not proof of live state (see
-- the 2026-08-29 drift lesson behind 00100), so every claim below is from the
-- live catalog, not from the .sql files.
--
-- Live state found:
--   * All 12 tables exist; RLS is ON for all 12 (and for all 60 public tables);
--     the 9 policies match the migration files exactly.
--   * 11 of the 12 still carry Supabase's DEFAULT table grants
--     (anon=arwdDxtm, authenticated=arwdDxtm). Only rate_limits was revoked
--     (00105). So master_contacts, segment_pulls and buyer_experience_config,
--     the three "service-role-only, RLS on, no policy" tables, are protected by
--     RLS default-deny ALONE; the defense-in-depth REVOKE that the house pattern
--     applies to server-only tables (00074 / 00100 / 00105) was never written
--     for them (00112 / 00118 omitted it).
--   * push_subscriptions has a real policy gap: its WITH CHECK binds only
--     user_id = auth.uid(). organization_id is unconstrained, and the hot-lead
--     fan-out in src/lib/notifications/web-push.ts selects subscriptions BY
--     organization_id only. Client-portal users share the agency org (verified
--     live: 4 role='client' profiles, all in the single agency org), the
--     /api/push/subscribe route has no role gate, and the policy has no role
--     check, so a client-portal user can register a push endpoint under the
--     agency org and receive EVERY hot-lead push (lead name, company, reply
--     snippet) for every client. Not exploited today (0 rows live), but open.
--
-- What this migration does:
--   1) push_subscriptions: the write side of the policy now also requires
--      organization_id = the caller's JWT org and role in (owner, va). The
--      subscribe route already sends organization_id from the same JWT claim
--      (middleware x-user-org = app_metadata.organization_id, the claim
--      get_my_org_id() reads), so the owner/VA flow is unchanged.
--   2) master_contacts / segment_pulls / buyer_experience_config: REVOKE ALL
--      from anon + authenticated (rate_limits re-asserted). Every call site is
--      the service-role client (cron/reverify-master-pool, admin/buyer-experience,
--      buyer/experience, buyer/prospecting/searches, lib/tokens/cache-serve,
--      lib/tokens/promotion, all verified 2026-09-05), so nothing changes for
--      the app; anon/authenticated already got zero rows via RLS.
--   3) Defense in depth on the remaining 8 tables + the token_balances view.
--      Beyond the strict delta, but verified safe against every call site:
--      anon never legitimately touches any of the 12 (every policy needs a JWT
--      role claim, which anon does not have) so anon loses all grants; the six
--      tables whose ONLY policies are SELECT (token_ledger, token_pricing_config,
--      token_price_tiers, token_packs, contact_ownership, buyer_reverify_jobs)
--      keep SELECT for authenticated and lose the write privileges, since every
--      write to them runs through the service-role client. push_subscriptions
--      and mailbox_tags have FOR ALL policies for user-JWT callers and keep the
--      full authenticated grant. Delete section 3 if you want the minimal change.
--
-- Not touched on purpose: FORCE ROW LEVEL SECURITY (the house never uses it;
-- the table owner is postgres and service_role bypasses via BYPASSRLS).
--
-- Idempotent: ENABLE RLS / REVOKE / GRANT converge on re-run; the policy is
-- dropped before it is re-created. Safe to re-run.

SET search_path TO public;

-- ============================================================================
-- 1) push_subscriptions: org-bound + admin-only on the write side
-- ============================================================================
ALTER TABLE public.push_subscriptions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users manage own push subscriptions" ON public.push_subscriptions;
CREATE POLICY "Users manage own push subscriptions" ON public.push_subscriptions
  FOR ALL
  TO authenticated
  -- Read / delete: still only your own rows (a user can always unsubscribe).
  USING (user_id = auth.uid())
  -- Insert / update: your own row, in YOUR org, and only for the admin roles
  -- the hot-lead push is built for (the payload deep-links to /app/admin/inbox).
  WITH CHECK (
    user_id = auth.uid()
    AND organization_id IS NOT NULL
    AND organization_id = public.get_my_org_id()
    AND public.get_my_role() IN ('owner', 'va')
  );

-- ============================================================================
-- 2) Service-role-only tables: RLS on + no policy + no anon/authenticated grant
--    (the 00100 / 00105 pattern). rate_limits is already there; re-asserted.
-- ============================================================================
ALTER TABLE public.master_contacts         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.segment_pulls           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.buyer_experience_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rate_limits             ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE
  public.master_contacts,
  public.segment_pulls,
  public.buyer_experience_config,
  public.rate_limits
FROM anon, authenticated;

-- ============================================================================
-- 3) Defense in depth on the other 8 tables + the token_balances view
--    (optional: delete this whole section for the minimal change)
-- ============================================================================
-- 3a) anon has no legitimate path to any of these: drop its grants entirely.
REVOKE ALL ON TABLE
  public.push_subscriptions,
  public.mailbox_tags,
  public.token_ledger,
  public.token_pricing_config,
  public.token_price_tiers,
  public.token_packs,
  public.contact_ownership,
  public.buyer_reverify_jobs
FROM anon;
REVOKE ALL ON public.token_balances FROM anon;

-- 3b) SELECT-only-policy tables: authenticated keeps SELECT, loses the writes
--     (every insert/update/delete on these goes through the service-role client:
--     lib/tokens/billing.ts, lib/stripe/webhooks.ts, the buyer routes, and the
--     reverify crons, all verified 2026-09-05).
REVOKE ALL ON TABLE
  public.token_ledger,
  public.token_pricing_config,
  public.token_price_tiers,
  public.token_packs,
  public.contact_ownership,
  public.buyer_reverify_jobs
FROM authenticated;
GRANT SELECT ON TABLE
  public.token_ledger,
  public.token_pricing_config,
  public.token_price_tiers,
  public.token_packs,
  public.contact_ownership,
  public.buyer_reverify_jobs
TO authenticated;

-- token_balances is a security_invoker view over token_ledger; the buyer portal
-- reads it from the browser (buyer-data-context.tsx), so SELECT stays.
REVOKE ALL ON public.token_balances FROM authenticated;
GRANT SELECT ON public.token_balances TO authenticated;

-- ============================================================================
-- Post-apply verification (read-only; run through the Management API):
--
--   select c.relname, c.relacl::text from pg_class c
--     join pg_namespace n on n.oid = c.relnamespace
--    where n.nspname = 'public' and c.relname in ('master_contacts','segment_pulls',
--      'buyer_experience_config','rate_limits','token_ledger','token_balances',
--      'push_subscriptions','mailbox_tags') order by 1;
--   -- expect: no anon entry anywhere; only postgres + service_role on the four
--   -- server-only tables; authenticated=r/postgres on the SELECT-only tables.
--
--   select policyname, cmd, roles, qual, with_check from pg_policies
--    where schemaname = 'public' and tablename = 'push_subscriptions';
--   -- expect: with_check mentions get_my_org_id() and get_my_role().
-- ============================================================================
