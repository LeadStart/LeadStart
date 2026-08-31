-- 00112_token_master_pool.sql
--
-- Phase 4 of the token product: the shared, platform-owned MASTER CONTACTS POOL.
-- A business/person sourced once becomes a durable, resellable asset (near-100%
-- margin on resale). Three ADDITIVE tables with ZERO impact on the agency's
-- org-scoped `contacts` table or the shared enrichment engine.
--
-- Architecture (Option A, owner-locked 2026-08-31): buyer searches keep sourcing
-- + enriching into the buyer's OWN org `contacts` exactly as today (engine
-- untouched — the key risk avoided). At settlement, delivered buyer contacts are
-- PROMOTED into this pool (upsert by natural key) and OWNED via a ledger. The
-- buyer keeps their per-org working copy AND gains ownership of the master row.
--
--   master_contacts    canonical, globally-deduped pool (service-role only)
--   contact_ownership  buyer org <-> master row, one row per (org, master) pair
--   segment_pulls      segment-cache ledger (service-role only)
--
-- Natural-key dedup — a real-world entity maps to ONE master row regardless of
-- how many buyers source it:
--   'place:<google_place_id>'  (Maps origin — the stable Google place id)
--   'li:<lower(linkedin_url)>' (LinkedIn origin — the stable profile url)
--   'email:<lower(email)>'     (fallback when neither id is present)
--
-- Additive + idempotent (IF NOT EXISTS everywhere) so it is safe to re-run.

SET search_path TO public;

-- ── master_contacts ─────────────────────────────────────────────────────────
-- The canonical, resellable asset. Columns mirror the buyer's `contacts` row so a
-- promotion is a straight copy of the delivered lead; `enrichment_data` holds the
-- merged canonical enrichment. `best_tier` is outcomes.bestTier for coverage /
-- reporting. Deduped globally by `natural_key`.
CREATE TABLE IF NOT EXISTS public.master_contacts (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  natural_key               text NOT NULL UNIQUE,
  vein                      text CHECK (vein IN ('maps','linkedin')),
  first_name                text,
  last_name                 text,
  email                     text,
  company_name              text,
  title                     text,
  phone                     text,
  company_phone             text,
  company_email             text,
  location                  text,
  linkedin_url              text,
  company_linkedin_url      text,
  company_domain            text,
  google_place_id           text,
  enrichment_data           jsonb NOT NULL DEFAULT '{}',
  email_verification_status text,
  email_verified_at         timestamptz,
  best_tier                 text,
  first_acquired_at         timestamptz NOT NULL DEFAULT now(),
  last_verified_at          timestamptz,
  updated_at                timestamptz NOT NULL DEFAULT now()
);

-- ── contact_ownership ───────────────────────────────────────────────────────
-- Who has paid for which master contact. UNIQUE(organization_id, master_contact_id)
-- makes ownership idempotent: a buyer owns a master row exactly once, so a repeat
-- pull that re-touches an owned record can never grant (or bill) it twice. The
-- dollar charge itself lives in token_ledger (per search), not here.
CREATE TABLE IF NOT EXISTS public.contact_ownership (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  master_contact_id uuid NOT NULL REFERENCES public.master_contacts(id) ON DELETE CASCADE,
  search_id         uuid,
  search_kind       text CHECK (search_kind IN ('maps','linkedin')),
  acquired_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, master_contact_id)
);

CREATE INDEX IF NOT EXISTS idx_contact_ownership_org
  ON public.contact_ownership(organization_id);
CREATE INDEX IF NOT EXISTS idx_contact_ownership_master
  ON public.contact_ownership(master_contact_id);
CREATE INDEX IF NOT EXISTS idx_contact_ownership_search
  ON public.contact_ownership(search_id) WHERE search_id IS NOT NULL;

-- ── segment_pulls ───────────────────────────────────────────────────────────
-- Segment-cache ledger. `segment_key` = a stable hash of (vein + normalized terms
-- + area). A repeat pull of a recently-sourced segment (within
-- token_pricing_config.segment_cache_freshness_days) can be served from
-- master_contacts with no actor re-run. Populated by Phase 4 promotion + cache.
CREATE TABLE IF NOT EXISTS public.segment_pulls (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  segment_key          text NOT NULL UNIQUE,
  vein                 text CHECK (vein IN ('maps','linkedin')),
  terms                text[],
  area                 text,
  last_pulled_at       timestamptz,
  master_contact_count integer NOT NULL DEFAULT 0,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

-- ── RLS ─────────────────────────────────────────────────────────────────────
-- master_contacts + segment_pulls are platform-owned. RLS ON with NO policy =>
-- only the service-role (which bypasses RLS) can read/write; anon/authenticated
-- (buyers, agency users) get zero rows directly. The coverage readout and the
-- cache serve reach them through service-role routes.
ALTER TABLE public.master_contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.segment_pulls   ENABLE ROW LEVEL SECURITY;

-- contact_ownership: a buyer reads only their own org's ownership rows (same
-- idiom as token_ledger_buyer_read). Every write runs through the service-role
-- promotion / cache path, which bypasses RLS.
ALTER TABLE public.contact_ownership ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS contact_ownership_buyer_read ON public.contact_ownership;
CREATE POLICY contact_ownership_buyer_read ON public.contact_ownership
  FOR SELECT
  USING (organization_id = public.get_my_org_id() AND public.get_my_role() = 'buyer');
