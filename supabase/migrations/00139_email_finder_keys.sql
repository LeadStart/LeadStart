-- 00139_email_finder_keys.sql
-- API keys for three pay-per-hit email finders under test (owner go 2026-10-12):
-- Enrow, Icypeas and Datagma. Findymail's key (migration 00099) already exists.
--
-- Why: on the 2026-10-12 national cleaning-company import the in-house
-- waterfall found a sendable owner email for 23% of named owners; the owner
-- wants to test which finder recovers the rest cheapest, on the same 200
-- owners, before wiring any of them into the enrichment cron. Until then
-- these keys are read ONLY by the finder test harness (scripts/finder-test.mts)
-- and the settings "Test connection" buttons. No cron reads them.
--
-- Security: migration 00096 role-gated the organizations SELECT policy to
-- owner/va, so these secret columns are unreadable by client-portal sessions,
-- the same posture as findymail_api_key and millionverifier_api_key. Server
-- code reads them via the service role.
--
-- Additive + idempotent, no backfill.

SET search_path TO public;

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS enrow_api_key TEXT,
  ADD COLUMN IF NOT EXISTS enrow_credits NUMERIC,
  ADD COLUMN IF NOT EXISTS enrow_credits_checked_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS icypeas_api_key TEXT,
  ADD COLUMN IF NOT EXISTS icypeas_checked_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS datagma_api_key TEXT,
  ADD COLUMN IF NOT EXISTS datagma_credits NUMERIC,
  ADD COLUMN IF NOT EXISTS datagma_credits_checked_at TIMESTAMPTZ;
