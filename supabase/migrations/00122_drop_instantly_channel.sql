-- =============================================
-- Migration 00122: Drop the Instantly email-channel schema
--
-- The Instantly integration was removed from the application entirely (lib,
-- API routes, webhook, Settings card, campaign lifecycle arms, types). This
-- migration removes the now-orphaned DB objects that migration 00065 re-added.
--
-- SAFE TO RUN: every one of these columns is 100% empty in production.
-- Verified 2026-09-03 via the service-role API:
--   organizations.instantly_api_key            0 non-null
--   organizations.instantly_workspace_id / _webhook_id   0 non-null
--   campaigns.instantly_campaign_id            0 non-null (4 campaigns, all native_email)
--   lead_replies.instantly_email_id / _message_id / _eaccount / _thread_id
--                                              0 non-null (15 reply rows, all native)
-- No row loses data; no surviving code path (native email / LinkedIn) reads
-- any of these columns.
--
-- ENUM NOTE: the 'instantly' value on the source_channel enum is intentionally
-- LEFT IN PLACE. Postgres cannot drop an enum value in place; doing so would
-- require recreating the type and rewriting every column that uses it (a heavy,
-- risky operation across campaigns / lead_replies / webhook_events). An unused
-- enum value is inert and harmless; no code emits it any more.
--
-- Idempotent: every DROP uses IF EXISTS, so a re-run is a no-op.
-- =============================================

SET search_path TO public;

-- 1) organizations: Instantly workspace credentials (added in 00065).
ALTER TABLE organizations
  DROP COLUMN IF EXISTS instantly_api_key,
  DROP COLUMN IF EXISTS instantly_workspace_id,
  DROP COLUMN IF EXISTS instantly_webhook_id;

-- 2) campaigns: per-campaign Instantly campaign id + its org-scoped unique.
--    Dropping the column also drops the constraint, but drop it explicitly
--    first so the intent is clear and the migration is order-independent.
ALTER TABLE campaigns
  DROP CONSTRAINT IF EXISTS campaigns_org_instantly_campaign_unique;

ALTER TABLE campaigns
  DROP COLUMN IF EXISTS instantly_campaign_id;

-- 3) lead_replies: per-reply Instantly identifiers + the webhook-dedup
--    constraint and the threading index.
DROP INDEX IF EXISTS idx_lead_replies_instantly_thread;

ALTER TABLE lead_replies
  DROP CONSTRAINT IF EXISTS lead_replies_instantly_email_dedupe;

ALTER TABLE lead_replies
  DROP COLUMN IF EXISTS instantly_email_id,
  DROP COLUMN IF EXISTS instantly_message_id,
  DROP COLUMN IF EXISTS instantly_eaccount,
  DROP COLUMN IF EXISTS instantly_thread_id;
