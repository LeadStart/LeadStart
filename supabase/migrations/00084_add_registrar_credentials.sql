-- =============================================
-- Migration 00084: Registrar API credentials + automated-purchase spend cap
--
-- Phase 2 of the deliverability-infrastructure plan: automate buying domains and
-- writing their DNS via the Porkbun and Spaceship APIs. Same org-column pattern
-- as every other integration key (Anthropic 00044, Million Verifier 00069,
-- Apify 00071): plain nullable columns on organizations.
--
--   porkbun_api_key / porkbun_api_secret       — Porkbun API credentials
--   spaceship_api_key / spaceship_api_secret   — Spaceship API credentials
--   registrar_monthly_spend_cap_usd            — HARD monthly ceiling on
--                                                automated domain purchases.
--                                                NULL = no automated purchasing
--                                                at all (fail-closed default).
--
-- Owner decision 2026-08-26: build BOTH providers (buy where cheaper); cap $25/mo.
-- The cap column is left NULL here on purpose — automated purchasing stays OFF
-- until an owner sets it in Settings, exactly like a missing key disables an
-- integration. The Settings card pre-fills 25 as the agreed value.
--
-- No purchase ever runs without BOTH a provider's credentials AND a non-null
-- cap, and the running month-to-date spend (summed from
-- sending_domains.purchase_price_usd, migration 00081) must stay under it.
--
-- Apply by hand in the Supabase SQL editor (project exedxjrifprqgftyuroc).
-- =============================================

SET search_path TO public;

ALTER TABLE organizations
  ADD COLUMN porkbun_api_key TEXT,
  ADD COLUMN porkbun_api_secret TEXT,
  ADD COLUMN spaceship_api_key TEXT,
  ADD COLUMN spaceship_api_secret TEXT,
  ADD COLUMN registrar_monthly_spend_cap_usd NUMERIC(10, 2);

COMMENT ON COLUMN organizations.registrar_monthly_spend_cap_usd IS
  'Hard monthly ceiling (USD) on automated domain purchases. NULL = automated purchasing disabled. Enforced fail-closed against month-to-date sum of sending_domains.purchase_price_usd.';
