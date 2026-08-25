-- Opt-in email-verification phase for the enrichment pipeline.
--
-- The core waterfall (profiles → domains → waterfall) always runs; `activity`
-- and now `verify` are opt-in add-ons chosen per prospecting search (or in the
-- Contacts → Enrich dialog). The verify phase runs Million Verifier inline on
-- every found email so the enrichment report carries a verdict — MV stays the
-- single source of truth (writes the same contacts.email_verification_* columns
-- from 00069), so the pre-send gate reuses the 30-day cache with no double spend.
--
-- Purely additive + idempotent (local dev shares the prod DB). Apply with:
--   node scripts/supabase-sql.mjs --file supabase/migrations/00077_enrichment_verify_phase.sql

SET search_path TO public;

-- 1) enrichment_runs: opt-in verify flag + a verified counter, and widen the
--    phase CHECK to allow the new 'verify' phase.
ALTER TABLE enrichment_runs
  ADD COLUMN IF NOT EXISTS run_verify BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS found_verified_count INT NOT NULL DEFAULT 0;

ALTER TABLE enrichment_runs DROP CONSTRAINT IF EXISTS enrichment_runs_phase_check;
ALTER TABLE enrichment_runs
  ADD CONSTRAINT enrichment_runs_phase_check
  CHECK (phase IN ('profiles','domains','waterfall','activity','verify','complete'));

-- 2) enrichment_run_items: the verify step columns. verify_status is NULL until
--    the item is seeded into the verify phase (has an email to verify).
ALTER TABLE enrichment_run_items
  ADD COLUMN IF NOT EXISTS verify_status TEXT,
  ADD COLUMN IF NOT EXISTS verify_notes TEXT,
  ADD COLUMN IF NOT EXISTS verification_result TEXT;  -- ok|catch_all|unknown|invalid|disposable|error

ALTER TABLE enrichment_run_items DROP CONSTRAINT IF EXISTS enrichment_run_items_verify_status_check;
ALTER TABLE enrichment_run_items
  ADD CONSTRAINT enrichment_run_items_verify_status_check
  CHECK (verify_status IS NULL OR verify_status IN ('pending','in_flight','found','not_found','skipped','error'));

-- Worker batch selection for the verify phase (mirrors the per-phase pending
-- indexes from 00071).
CREATE INDEX IF NOT EXISTS idx_enrichment_items_verify_pending
  ON enrichment_run_items (run_id, created_at, id) WHERE verify_status = 'pending';
