-- =============================================
-- Migration 00036: Extend reply_status enum
--
-- Supports SAFETY-TODO C2 — the enrichment retry queue needs two new
-- terminal/transient states alongside the existing taxonomy:
--   pending_enrichment  the webhook inserted a minimal row because
--                       getEmail exhausted its in-handler backoff. The
--                       retry-enrichment cron is trying to promote it.
--   enrichment_failed   the retry cron gave up after 5 attempts. Row
--                       stays visible for admin triage but nothing
--                       further auto-processes it.
--
-- Split from 00037 because Postgres can't use a newly-added enum value
-- in the same transaction that added it (e.g. in a partial-index WHERE
-- clause). Apply this one first, then 00037.
-- =============================================

ALTER TYPE reply_status ADD VALUE IF NOT EXISTS 'pending_enrichment';
ALTER TYPE reply_status ADD VALUE IF NOT EXISTS 'enrichment_failed';
