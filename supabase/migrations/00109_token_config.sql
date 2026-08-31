-- 00109_token_config.sql
--
-- Phase 2: persistence behind the admin Tokens config shell (Settings -> Tokens).
-- These are AGENCY-owned product settings (one platform-wide config), NOT
-- per-buyer. Three tables mirror the shell's cards:
--   token_pricing_config   singleton: token economics + spend-safety + dedup/
--                          coverage + master-DB cadence knobs, plus a `version`
--                          the charge ledger snapshots (price_card_version).
--   token_price_tiers      per-vein per-tier token price (the price cards).
--   token_packs            the Stripe one-time top-up packs.
--
-- Seeded with STRUCTURE only (tier rows + pack names + a config row) with NULL
-- prices — the actual numbers (token unit value, markup, pack + tier prices) are
-- the owner's pricing decisions, entered through the shell. RLS: owner/va read;
-- writes go through the service-role admin save route (no anon write policy).
-- Idempotent + additive.

SET search_path TO public;

-- ---- singleton global config -------------------------------------------------
CREATE TABLE IF NOT EXISTS public.token_pricing_config (
  singleton                     boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  token_unit_usd                numeric,       -- retail $ per token
  target_markup                 numeric,       -- × over cost_usd ÷ delivered
  max_rows_per_search           integer,       -- variance/spend bound per search
  max_charge_per_run_usd        numeric,       -- -> actor maxTotalChargeUsd
  segment_cache_freshness_days  integer,       -- serve-from-DB window
  reverify_token_price          numeric,       -- minimal re-verify tier
  auto_reverify_days            integer,       -- buyer auto re-verify threshold
  master_reverify_cadence_days  integer,       -- background master-DB re-check
  version                       integer NOT NULL DEFAULT 1,  -- bumped on save; charges snapshot it
  updated_at                    timestamptz NOT NULL DEFAULT now(),
  updated_by                    uuid
);
INSERT INTO public.token_pricing_config (singleton) VALUES (true)
  ON CONFLICT (singleton) DO NOTHING;

-- ---- per-vein price cards -----------------------------------------------------
CREATE TABLE IF NOT EXISTS public.token_price_tiers (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vein         text NOT NULL CHECK (vein IN ('maps','linkedin')),
  tier_key     text NOT NULL,
  token_price  numeric,          -- NULL = not priced yet (or free/bundled)
  is_free      boolean NOT NULL DEFAULT false,
  is_bundled   boolean NOT NULL DEFAULT false,
  sort         integer NOT NULL DEFAULT 0,
  UNIQUE (vein, tier_key)
);

INSERT INTO public.token_price_tiers (vein, tier_key, is_free, is_bundled, sort) VALUES
  ('maps','record',                  true,  false, 0),
  ('maps','company_inbox',           false, false, 1),
  ('maps','owner_name',              false, false, 2),
  ('maps','personal_email',          false, false, 3),
  ('maps','verified_personal_email', false, false, 4),
  ('maps','catch_all_guess',         false, true,  5),
  ('maps','catch_all_recovered',     false, false, 6),
  ('linkedin','record',                  true,  false, 0),
  ('linkedin','personal_email',          false, false, 1),
  ('linkedin','verified_personal_email', false, false, 2),
  ('linkedin','company_inbox',           false, false, 3),
  ('linkedin','catch_all_recovered',     false, false, 4)
ON CONFLICT (vein, tier_key) DO NOTHING;

-- ---- Stripe token packs -------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.token_packs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name            text NOT NULL,
  tokens          integer NOT NULL,
  price_usd       numeric,          -- NULL until the owner sets it
  stripe_price_id text,             -- set when the Stripe product is created
  active          boolean NOT NULL DEFAULT true,
  sort            integer NOT NULL DEFAULT 0
);

INSERT INTO public.token_packs (name, tokens, sort) VALUES
  ('Starter', 1000,  0),
  ('Growth',  5000,  1),
  ('Scale',   25000, 2)
ON CONFLICT DO NOTHING;

-- ---- RLS: owner/va read; writes via service-role only -------------------------
ALTER TABLE public.token_pricing_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.token_price_tiers   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.token_packs         ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS token_pricing_config_admin_read ON public.token_pricing_config;
CREATE POLICY token_pricing_config_admin_read ON public.token_pricing_config
  FOR SELECT USING (public.get_my_role() IN ('owner','va'));

DROP POLICY IF EXISTS token_price_tiers_admin_read ON public.token_price_tiers;
CREATE POLICY token_price_tiers_admin_read ON public.token_price_tiers
  FOR SELECT USING (public.get_my_role() IN ('owner','va'));

DROP POLICY IF EXISTS token_packs_admin_read ON public.token_packs;
CREATE POLICY token_packs_admin_read ON public.token_packs
  FOR SELECT USING (public.get_my_role() IN ('owner','va'));
