-- =============================================
-- Migration 00065: Re-add the Instantly.ai email channel
--
-- Instantly was the original email channel; it was stripped in migration
-- 00051 (columns dropped, 'instantly' removed from the source_channel enum)
-- when the platform moved to Salesforge and then to the native Gmail API.
-- We are re-introducing Instantly as a PARALLEL channel alongside native
-- email (and the dormant LinkedIn/Unipile channel): campaigns are authored
-- and sent inside Instantly; LeadStart links to them, pushes leads, ingests
-- replies, and rolls up analytics.
--
-- This re-adds what 00051 removed, plus the eaccount/thread columns needed
-- for outbound reply-from-portal:
--   organizations.instantly_api_key / _workspace_id / _webhook_id
--   campaigns.instantly_campaign_id            (+ org-scoped unique)
--   lead_replies.instantly_email_id / _message_id / _eaccount / _thread_id
--     (+ org-scoped unique on instantly_email_id for webhook dedup)
--   'instantly' back onto the source_channel enum
--
-- Enum note (mirrors 00056): ALTER TYPE ... ADD VALUE is safe here because
-- nothing in this migration USES 'instantly' as a literal in the same
-- transaction — we only add the value and the columns. Code that inserts
-- source_channel='instantly' ships separately.
-- =============================================

SET search_path TO public;

-- 1) Re-add 'instantly' to the channel enum (removed in 00051).
ALTER TYPE source_channel ADD VALUE IF NOT EXISTS 'instantly';

-- 2) Org-level Instantly workspace credentials (same names 00051 dropped).
ALTER TABLE organizations
  ADD COLUMN instantly_api_key TEXT,
  ADD COLUMN instantly_workspace_id TEXT,
  ADD COLUMN instantly_webhook_id TEXT;

-- 3) Per-campaign Instantly campaign id. The reply webhook resolves an
--    inbound reply's org/client/campaign by matching this against the
--    payload's campaign_id; the sync/link flow upserts campaigns keyed on it.
--
--    Regular UNIQUE constraint (NOT a partial index) so PostgREST's upsert
--    onConflict can target it — the lesson 00029/00049/00056 documented.
--    NULLs (native/LinkedIn campaigns) are never equal, so many NULL rows
--    per org stay allowed.
ALTER TABLE campaigns
  ADD COLUMN instantly_campaign_id TEXT;

ALTER TABLE campaigns
  ADD CONSTRAINT campaigns_org_instantly_campaign_unique
  UNIQUE (organization_id, instantly_campaign_id);

-- 4) Per-reply Instantly identifiers.
--    instantly_email_id   — Instantly's Email-object UUID; ALWAYS present on
--                           the reply_received webhook. Used as the dedup key
--                           and as reply_to_uuid when sending a reply back.
--    instantly_message_id — RFC Message-ID from the enriched email (threading).
--    instantly_eaccount   — the hosted mailbox that received the reply; passed
--                           back as `eaccount` on POST /emails/reply.
--    instantly_thread_id  — Instantly thread id (threading / debugging).
ALTER TABLE lead_replies
  ADD COLUMN instantly_email_id TEXT,
  ADD COLUMN instantly_message_id TEXT,
  ADD COLUMN instantly_eaccount TEXT,
  ADD COLUMN instantly_thread_id TEXT;

-- Webhook dedup: org-scoped unique on the Instantly email UUID. Regular
-- UNIQUE constraint (see note above) so the webhook's upsert onConflict
-- matches it. instantly_email_id is always present on reply_received, so
-- this is a more reliable key than the RFC message id.
ALTER TABLE lead_replies
  ADD CONSTRAINT lead_replies_instantly_email_dedupe
  UNIQUE (organization_id, instantly_email_id);

-- Threading lookups by Instantly thread id.
CREATE INDEX idx_lead_replies_instantly_thread
  ON lead_replies (instantly_thread_id)
  WHERE instantly_thread_id IS NOT NULL;
