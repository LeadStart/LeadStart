-- Configurable enrichment waterfall (RESUME-WATERFALL-SETTINGS).
-- Purely additive + idempotent. 00074 is already taken twice
-- (00074_fix_password_reset_tokens_rls + 00074_create_linkedin_search_presets),
-- so this is 00075 — do not "fix" that collision here.
SET search_path TO public;

-- Org-level enrichment/waterfall config. One JSONB blob, versioned by shape:
-- {
--   "waterfall_enabled": true,
--   "size_threshold": 50,
--   "small_method":   "scrape_plus_pattern",   -- scrape_plus_pattern|pattern_mv|site_scrape|vdrmota|bovi|off
--   "large_method":   "pattern_mv",
--   "unknown_method": "pattern_mv",
--   "vdrmota_max_leads": 3,
--   "accept_catch_all_guesses": false,
--   "scrape_max_pages": 4
-- }
-- NULL = use code defaults (DEFAULT_ENRICHMENT_SETTINGS in src/types/app.ts).
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS enrichment_settings JSONB;

-- Per-item routing + size input (advancePhase stamps method; domain ingest stamps count)
ALTER TABLE enrichment_run_items
  ADD COLUMN IF NOT EXISTS waterfall_method TEXT,
  ADD COLUMN IF NOT EXISTS employee_count INT;

-- Config snapshot on the run (matches the existing actor-snapshot pattern so an
-- in-flight run never re-reads live settings).
ALTER TABLE enrichment_runs ADD COLUMN IF NOT EXISTS waterfall_config JSONB;
