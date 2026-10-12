-- 00138_enrichment_run_cost_breakdown.sql
-- What each enrichment run spent, by provider (owner request 2026-10-12).
--
-- enrichment_runs.cost_usd stays the run's total. cost_breakdown splits what the
-- run-apify-enrichment cron adds to it, in USD, by provider:
--   apify            every Apify batch (profiles, domains, site_scrape, bovi,
--                    activity), raised at completion to the Apify runs' final usage
--   millionverifier  credits charged in pattern_mv and the verify phase
--   findymail        catch-all recoveries (pay-on-hit)
--   perplexity       website lookups: tokens plus the per-request fee
--   anthropic        owner naming: the Haiku site read and the Haiku 5.5 web search
-- The cron writes it in the same statement as cost_usd, so for a run accrued
-- with this column the parts add up to the total. A run from before it reads
-- '{}': its cost_usd is not split by provider. Missing keys read as 0.
--
-- Additive + idempotent, no backfill. Apply it BEFORE the code that writes it is
-- pushed: the cron and the Contacts enrichment banner select the column by name
-- (ENRICH_RUN_COLUMNS), and without it the cron's run select fails and the cron
-- sits idle.

ALTER TABLE public.enrichment_runs
  ADD COLUMN IF NOT EXISTS cost_breakdown JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN public.enrichment_runs.cost_breakdown IS
  'USD per provider added to cost_usd (apify, millionverifier, findymail, perplexity, anthropic). {} = a run from before the split; a missing key = 0.';
