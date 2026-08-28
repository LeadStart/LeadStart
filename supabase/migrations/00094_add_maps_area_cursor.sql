-- Multi-region fan-out cursor for maps_searches. A DIY Maps search can span
-- several structured areas (query.levers.areas); the run-maps-searches cron
-- scrapes ONE actor run per area, sequentially, accumulating de-duplicated
-- places into the existing `results` JSONB until every area is done, then slices
-- to target_max_results and completes. `area_index` is the cursor into
-- levers.areas of the area currently being scraped. Purely additive + idempotent.
--
-- Backward-compat: single-area searches (query.levers.locationQuery, no `areas`)
-- keep area_index = 0 and ignore it — they run the unchanged single-run path.
-- Partial accumulation reuses `results` (already JSONB): as each area finishes,
-- the cron writes the running de-duplicated union there, so no new results
-- column is needed.

SET search_path TO public;

ALTER TABLE maps_searches ADD COLUMN IF NOT EXISTS area_index INT NOT NULL DEFAULT 0;

COMMENT ON COLUMN maps_searches.area_index IS
  'Multi-region fan-out cursor: 0-based index into query.levers.areas of the area currently being scraped. The run-maps-searches cron starts one actor run per area sequentially, accumulating de-duplicated places into results until area_index reaches areas.length, then slices to target_max_results and completes. 0 (and ignored) for single-area locationQuery searches.';
