-- 00107_buyer_orgs.sql
--
-- Phase 1: mark which organizations are self-serve buyer orgs vs the agency org,
-- so agency crons / alerts / nav can exclude buyer orgs. Depends on 00106 having
-- committed the 'buyer' app_role value first. Idempotent + additive.

SET search_path TO public;

-- kind: 'agency' (the LeadStart cold-email org, the default for every existing
-- row) vs 'buyer' (one per self-serve signup). is_self_serve is the convenience
-- flag the buyer provisioning route sets.
ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'agency',
  ADD COLUMN IF NOT EXISTS is_self_serve BOOLEAN NOT NULL DEFAULT false;

-- Constrain kind to the known set. Dropped-and-recreated so re-runs converge.
ALTER TABLE public.organizations DROP CONSTRAINT IF EXISTS organizations_kind_check;
ALTER TABLE public.organizations
  ADD CONSTRAINT organizations_kind_check CHECK (kind IN ('agency', 'buyer'));

-- Agency queries that iterate orgs filter on kind; index it.
CREATE INDEX IF NOT EXISTS idx_organizations_kind ON public.organizations(kind);

-- No new RLS needed: the existing "Users can view their own org"
-- (id = get_my_org_id()) already lets a buyer read their own org row, and buyers
-- never need to write organizations. The buyer provisioning route creates the
-- org via the service-role client (bypasses RLS).
