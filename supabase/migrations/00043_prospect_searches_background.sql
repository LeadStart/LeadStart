-- =============================================
-- Migration 00043: Prospect searches go async
--
-- Phase 2 ran searches synchronously inside one request — capped at 1000
-- results to fit Vercel's 60s function timeout. Phase 2.5 splits the work
-- into a fire-and-forget POST + a cron-driven worker that processes each
-- search in chunks (a few pages per tick), updating progress fields the
-- frontend polls. This unlocks much larger result sets and gives users a
-- live "page X of ~Y, Z results so far" UI.
--
-- New columns:
--   - status: 'pending' (queued) -> 'running' (worker picked it up) ->
--     'complete' or 'failed'
--   - started_at / completed_at: timing for the UI
--   - progress_message: human-readable status line for the UI
--   - error_message: filled when status='failed'
--   - next_cursor: Scrap.io's cursor for the next page — saved between
--     cron ticks so the worker resumes where it left off
--   - target_max_results: how many results the user asked for, so the
--     worker knows when to stop independently of pagination state
--
-- Backfill: existing rows from Phase 2 are completed synchronously, so
-- they get status='complete' and completed_at = created_at.
-- =============================================

ALTER TABLE prospect_searches
  ADD COLUMN status TEXT,
  ADD COLUMN started_at TIMESTAMPTZ,
  ADD COLUMN completed_at TIMESTAMPTZ,
  ADD COLUMN progress_message TEXT,
  ADD COLUMN error_message TEXT,
  ADD COLUMN next_cursor TEXT,
  ADD COLUMN target_max_results INT;

-- Backfill existing rows (Phase 2 sync results are already complete).
UPDATE prospect_searches
SET status = 'complete',
    completed_at = created_at,
    target_max_results = result_count
WHERE status IS NULL;

ALTER TABLE prospect_searches
  ALTER COLUMN status SET NOT NULL,
  ALTER COLUMN status SET DEFAULT 'pending',
  ALTER COLUMN target_max_results SET NOT NULL,
  ALTER COLUMN target_max_results SET DEFAULT 100;

-- Partial index so the cron worker can find the next job to process in
-- O(log n) without scanning completed rows.
CREATE INDEX idx_prospect_searches_active
  ON prospect_searches (created_at)
  WHERE status IN ('pending', 'running');
