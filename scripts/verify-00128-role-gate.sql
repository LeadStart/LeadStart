-- Confirms migration 00128 applied LIVE. Every row must show has_role_gate = true.
-- Run: node scripts/supabase-sql.mjs --file scripts/verify-00128-role-gate.sql
-- (or paste into the prod dashboard SQL editor). Migration files drift from the
-- live DB, so this checks the ACTUAL live policies, not the .sql on disk.
SELECT
  tablename,
  policyname,
  cmd,
  (qual LIKE '%get_my_role%') AS has_role_gate,
  qual AS using_expr
FROM pg_policies
WHERE schemaname = 'public'
  AND (
    (tablename = 'quotes'                AND policyname = 'Quotes viewable by org members') OR
    (tablename = 'client_subscriptions'  AND policyname = 'Subscriptions viewable by org members') OR
    (tablename = 'billing_invoices'      AND policyname = 'Invoices viewable by org members') OR
    (tablename = 'pricing_plans'         AND policyname = 'Plans viewable by org members') OR
    (tablename = 'payment_links'         AND policyname = 'Payment links viewable by org members') OR
    (tablename = 'google_workspaces'     AND policyname = 'google_workspaces_org_access') OR
    (tablename = 'sending_domains'       AND policyname = 'sending_domains_org_access') OR
    (tablename = 'campaign_step_metrics' AND policyname = 'Step metrics viewable by org members')
  )
ORDER BY tablename;
