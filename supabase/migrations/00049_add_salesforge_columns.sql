-- =============================================
-- Migration 00049: Salesforge channel columns
--
-- LeadStart is migrating its email-sending channel from Instantly to
-- Salesforge.ai (with Warmforge for inbox warming). This migration adds
-- the Salesforge counterparts of every Instantly identifier we currently
-- persist, so the new channel can run parallel to Instantly during the
-- migration and (eventually) replace it.
--
-- Wiring context (not enforced here; lives in the client / webhook code):
--
--   - Salesforge API: https://api.salesforge.ai
--     Auth header is `Authorization: <key>` (raw, NOT `Bearer <key>`).
--     One workspace per LeadStart org. Workspace creds are an api_key
--     plus a workspace_id and (for outbound campaigns) a default product_id.
--
--   - Warmforge API: https://api.warmforge.ai/public/v1
--     Separate api_key. Mailboxes auto-sync from Salesforge so there is
--     no per-mailbox connect step on Warmforge — just the key.
--
--   - Webhooks register per-sequence + per-event-type. There is no
--     DELETE endpoint in Salesforge's public spec, so registration is
--     idempotent via GET /webhooks dedupe by (sequence_id, event_type, url).
--     We deliberately do NOT track webhook IDs locally — listing on
--     register is mandatory anyway, and tracking adds drift.
--
-- Reuses the source_channel ENUM from migration 00045 (extends it with
-- the 'salesforge' value).
--
-- NOT NULL audit (recorded so the next reader doesn't have to repeat it):
--
--   * lead_replies.instantly_* columns were all nullable from the
--     original CREATE TABLE in migration 00025. Migration 00046
--     re-dropped NOT NULL on instantly_email_id + instantly_message_id
--     redundantly. No further relaxation needed.
--   * campaigns.instantly_campaign_id was already relaxed from NOT NULL
--     in migration 00047 (and the UNIQUE constraint replaced with a
--     partial unique index). No further change needed.
--   * webhook_events: source_channel column from migration 00045 covers
--     Salesforge once the ENUM gets the new value below. No schema change.
-- =============================================

-- Make schema explicit so this migration is portable across connections
-- whose default search_path may not include `public` (e.g. the Supabase
-- Management API's /database/query endpoint). The dashboard SQL editor
-- already runs with public in scope, so this is a no-op there.
SET search_path TO public;

-- 1) Extend source_channel ENUM with 'salesforge'.
-- Postgres 12+ allows ALTER TYPE ... ADD VALUE inside a transaction, with
-- the caveat that the new value cannot be referenced in the same
-- transaction. This migration never references 'salesforge' (no DEFAULTs
-- change, no row writes), so it is safe to run as one block.
ALTER TYPE source_channel ADD VALUE IF NOT EXISTS 'salesforge';

-- 2) Org-level Salesforge + Warmforge credentials.
ALTER TABLE organizations
  ADD COLUMN salesforge_api_key TEXT,
  ADD COLUMN salesforge_workspace_id TEXT,
  ADD COLUMN salesforge_default_product_id TEXT,
  ADD COLUMN warmforge_api_key TEXT;

-- 3) Per-campaign Salesforge sequence binding.
-- Parallels campaigns.instantly_campaign_id. Partial unique index mirrors
-- the pattern installed for instantly_campaign_id in migration 00047.
ALTER TABLE campaigns
  ADD COLUMN salesforge_sequence_id TEXT;

CREATE UNIQUE INDEX idx_campaigns_org_salesforge_unique
  ON campaigns (organization_id, salesforge_sequence_id)
  WHERE salesforge_sequence_id IS NOT NULL;

-- 4) Per-reply Salesforge identifiers.
--
-- Salesforge does not expose RFC 5322 message-id, so the dedup key is
-- (organization_id, salesforge_email_id). salesforge_thread_id parallels
-- the existing thread_id column (Instantly thread). salesforge_mailbox_id
-- is the Salesforge counterpart of `eaccount` — ingest writes it from the
-- inbound webhook so reply-send can route the outbound reply through the
-- right mailbox.
--
-- Dedup is a regular UNIQUE constraint (not a partial unique index)
-- because the ingest path in commit 4 uses upsert / ON CONFLICT, which
-- PostgREST cannot match against a partial index — see migration 00029
-- for the same fix applied to the Instantly side. Postgres treats NULLs
-- as distinct in unique constraints by default, so multiple rows with
-- NULL salesforge_email_id (every Instantly / LinkedIn reply) remain
-- allowed.
ALTER TABLE lead_replies
  ADD COLUMN salesforge_email_id TEXT,
  ADD COLUMN salesforge_thread_id TEXT,
  ADD COLUMN salesforge_mailbox_id TEXT;

ALTER TABLE lead_replies
  ADD CONSTRAINT lead_replies_salesforge_email_dedupe
    UNIQUE (organization_id, salesforge_email_id);

CREATE INDEX idx_lead_replies_salesforge_thread
  ON lead_replies (salesforge_thread_id)
  WHERE salesforge_thread_id IS NOT NULL;

-- Mirrors idx_lead_replies_eaccount from migration 00026: lets admin
-- views slice by which Salesforge mailbox is getting the hot replies.
CREATE INDEX idx_lead_replies_salesforge_mailbox
  ON lead_replies (client_id, salesforge_mailbox_id)
  WHERE salesforge_mailbox_id IS NOT NULL;
