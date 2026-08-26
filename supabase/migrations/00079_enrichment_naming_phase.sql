-- Opt-in "naming" phase for the enrichment pipeline — decision-maker (owner)
-- name + title discovery, the per-search add-on for Google-Maps business leads.
--
-- Phase order becomes: profiles → domains → naming → waterfall → activity →
-- verify. The naming phase runs the existing decision-maker orchestrator
-- (enrichBusiness: Layer 1 site scrape → Layer 2 web search) per name-less item,
-- writing first/last/title so the waterfall's pattern_mv can then build a
-- personal email from the name + domain. Owner names are the fuel pattern_mv
-- needs; without this a Maps lead can only get a generic company inbox.
--
-- Also lands the delivered-outcome ledger columns (Phase 5): outcome_counts on
-- the run, and delivered_counts on linkedin_searches for symmetry with
-- maps_searches (00078). These are the margin substrate for future billing.
--
-- Purely additive + idempotent (local dev shares the prod DB). Apply with:
--   node scripts/supabase-sql.mjs --file supabase/migrations/00079_enrichment_naming_phase.sql

SET search_path TO public;

-- 1) enrichment_runs: opt-in naming flag + a found-names counter + the run-level
--    outcome ledger, and widen the phase CHECK to allow the new 'naming' phase.
ALTER TABLE enrichment_runs
  ADD COLUMN IF NOT EXISTS run_naming BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS found_names_count INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS outcome_counts JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE enrichment_runs DROP CONSTRAINT IF EXISTS enrichment_runs_phase_check;
ALTER TABLE enrichment_runs
  ADD CONSTRAINT enrichment_runs_phase_check
  CHECK (phase IN ('profiles','domains','naming','waterfall','activity','verify','complete'));

-- 2) enrichment_run_items: the naming step columns. naming_status is NULL until
--    the item is seeded into the naming phase (name-less, has a company name).
--    title holds the decision-maker's role for the report.
ALTER TABLE enrichment_run_items
  ADD COLUMN IF NOT EXISTS naming_status TEXT,
  ADD COLUMN IF NOT EXISTS naming_notes TEXT,
  ADD COLUMN IF NOT EXISTS title TEXT;

ALTER TABLE enrichment_run_items DROP CONSTRAINT IF EXISTS enrichment_run_items_naming_status_check;
ALTER TABLE enrichment_run_items
  ADD CONSTRAINT enrichment_run_items_naming_status_check
  CHECK (naming_status IS NULL OR naming_status IN ('pending','in_flight','found','not_found','skipped','error'));

-- Worker batch selection for the naming phase (mirrors the per-phase pending
-- indexes from 00071 / 00077).
CREATE INDEX IF NOT EXISTS idx_enrichment_items_naming_pending
  ON enrichment_run_items (run_id, created_at, id) WHERE naming_status = 'pending';

-- 3) Delivered-outcome ledger on linkedin_searches (maps_searches already has it
--    from 00078). Populated by the enrichment run at completion (Phase 5).
ALTER TABLE linkedin_searches
  ADD COLUMN IF NOT EXISTS delivered_counts JSONB NOT NULL DEFAULT '{}'::jsonb;
