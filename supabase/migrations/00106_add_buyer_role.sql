-- 00106_add_buyer_role.sql
--
-- Phase 1 of the token-based contact-sourcing product: add the self-serve
-- 'buyer' role. A buyer is doubly fenced from agency data by construction:
--   * they sit alone in their own organization, so get_my_org_id() scopes them
--     to a buyer-kind org that holds no agency clients/campaigns/mailboxes;
--   * their role='buyer' fails every existing agency RLS check
--     (get_my_role() IN ('owner','va') / = 'owner'), and they have no
--     client_users row, so the client policies deny them too.
--
-- MUST be its own migration: Postgres can't use a newly-added enum value in the
-- same transaction that adds it (same split as 00036 -> 00037). Apply this,
-- THEN 00107 (which references 'buyer'). Idempotent.

ALTER TYPE public.app_role ADD VALUE IF NOT EXISTS 'buyer';
