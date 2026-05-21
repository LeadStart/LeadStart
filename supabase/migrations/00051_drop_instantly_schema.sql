-- =============================================
-- Migration 00051: Strip Instantly schema
--
-- Instantly was decommissioned. This migration removes the leftover
-- schema: columns, indexes, the unique dedup constraint, the
-- 'instantly' value on the source_channel ENUM, and renames the
-- misnamed `sent_instantly_email_id` column (which has been holding
-- the upstream provider id for any channel) to `sent_external_email_id`.
--
-- Preserves the 19 historical lead_replies rows that came in via the
-- old Instantly webhook by NULLing their source_channel — keeps the
-- customer conversation visible in the inbox without lying about its
-- origin. Deletes the 470 webhook_events audit rows (stale, dead
-- integration, no future use).
--
-- Companion code changes (same commit):
--   - Drop SourceChannel='instantly' from src/types/app.ts
--   - Drop instantly_* fields from Organization/Campaign/LeadReply/WebhookEvent interfaces
--   - Drop instantly_category from ClassifierInput/DecideInput
--   - Rename sent_instantly_email_id → sent_external_email_id in code
--   - UI copy fixes (delete dialog, "uploaded to Instantly", "Instantly tag")
--   - Two client pages (excluded-meetings count, activity feed) temporarily
--     degraded to empty — they joined webhook_events on campaign_instantly_id;
--     rebuild against Salesforge events later
-- =============================================

SET search_path TO public;

-- ===== Step 1: backfill rows that reference the 'instantly' enum value =====

-- Delete the Instantly-tagged webhook audit log (stale, dead integration).
DELETE FROM webhook_events WHERE source_channel = 'instantly';

-- Preserve the 19 historical lead_replies but drop their dead channel tag.
-- Make column nullable first so we can NULL them — historically true
-- (rows really did come through Instantly) but the enum value is going
-- away, so they get NULL = "channel no longer known".
ALTER TABLE lead_replies ALTER COLUMN source_channel DROP NOT NULL;
UPDATE lead_replies SET source_channel = NULL WHERE source_channel = 'instantly';

-- ===== Step 2: drop dependent indexes / constraints / policies =====

-- RLS policy on webhook_events that joined campaigns via
-- instantly_campaign_id. Without a campaign_id FK on webhook_events
-- there's no good replacement until we rebuild events on Salesforge.
-- Clients can't see webhook_events for now (already disabled in the
-- client activity page UI).
DROP POLICY IF EXISTS "Client can view own campaign events" ON webhook_events;

-- Unique dedup on lead_replies.instantly_message_id (migration 00025/00029)
ALTER TABLE lead_replies DROP CONSTRAINT IF EXISTS lead_replies_message_dedupe;

-- Partial unique on campaigns.instantly_campaign_id (migration 00047)
DROP INDEX IF EXISTS idx_campaigns_org_instantly_unique;

-- Routing index on lead_replies.eaccount (migration 00026)
DROP INDEX IF EXISTS idx_lead_replies_eaccount;

-- ===== Step 3: drop columns =====

ALTER TABLE organizations
  DROP COLUMN IF EXISTS instantly_api_key,
  DROP COLUMN IF EXISTS instantly_workspace_id,
  DROP COLUMN IF EXISTS instantly_webhook_id;

ALTER TABLE campaigns
  DROP COLUMN IF EXISTS instantly_campaign_id;

ALTER TABLE lead_replies
  DROP COLUMN IF EXISTS instantly_email_id,
  DROP COLUMN IF EXISTS instantly_message_id,
  DROP COLUMN IF EXISTS instantly_campaign_id,
  DROP COLUMN IF EXISTS instantly_category,
  DROP COLUMN IF EXISTS thread_id,
  DROP COLUMN IF EXISTS eaccount;

ALTER TABLE webhook_events
  DROP COLUMN IF EXISTS campaign_instantly_id;

-- ===== Step 4: rename sent_instantly_email_id =====

-- This column was actively used by the Salesforge reply-send path —
-- misnamed by history (originally Instantly's email id, now holds
-- whichever upstream provider id we just got back from /reply).
ALTER TABLE lead_replies
  RENAME COLUMN sent_instantly_email_id TO sent_external_email_id;

-- ===== Step 5: recreate source_channel ENUM without 'instantly' =====
-- Postgres has no DROP VALUE from ENUM. Standard workaround: create
-- new enum, ALTER all referencing columns to use it, drop old, rename.

-- Drop defaults that reference the old enum (would block the type swap).
ALTER TABLE campaigns ALTER COLUMN source_channel DROP DEFAULT;
ALTER TABLE lead_replies ALTER COLUMN source_channel DROP DEFAULT;
ALTER TABLE webhook_events ALTER COLUMN source_channel DROP DEFAULT;

-- New enum without 'instantly'.
CREATE TYPE source_channel_new AS ENUM ('linkedin', 'salesforge');

-- Swap each column's type. The NULL rows on lead_replies cast cleanly.
-- Other rows are already 'linkedin' or 'salesforge'.
ALTER TABLE campaigns
  ALTER COLUMN source_channel TYPE source_channel_new
  USING source_channel::text::source_channel_new;

ALTER TABLE lead_replies
  ALTER COLUMN source_channel TYPE source_channel_new
  USING source_channel::text::source_channel_new;

ALTER TABLE webhook_events
  ALTER COLUMN source_channel TYPE source_channel_new
  USING source_channel::text::source_channel_new;

-- Drop the old enum, rename the new one into place.
DROP TYPE source_channel;
ALTER TYPE source_channel_new RENAME TO source_channel;

-- Restore defaults — 'salesforge' is the email channel now.
-- lead_replies stays default-less (handlers always set explicitly).
ALTER TABLE campaigns ALTER COLUMN source_channel SET DEFAULT 'salesforge';
ALTER TABLE webhook_events ALTER COLUMN source_channel SET DEFAULT 'salesforge';
