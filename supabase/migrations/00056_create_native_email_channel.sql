-- =============================================
-- Migration 00056: Native email channel (rotating Google inboxes)
--
-- Adds a first-party email-sending channel that lives alongside the
-- existing Salesforge (email) and Unipile (LinkedIn) channels. LeadStart
-- sends cold email directly through a pool of client-owned Google
-- Workspace inboxes, rotating across them and pacing per-inbox, with no
-- third-party sequencer. The channel reuses the existing sequence engine
-- (campaign_steps / campaign_enrollments from migration 00047) — this
-- migration only adds the genuinely new concepts:
--
--   organizations.gmail_service_account_*  — the DWD service-account creds
--   native_mailboxes                       — the sending-inbox registry + ramp
--   campaign_mailboxes                     — the rotation pool per campaign
--   native_sends                           — append-only send log; doubles as
--                                            the per-mailbox daily-cap counter,
--                                            the sent/bounced metric source, and
--                                            the reply-thread match index
--   campaign_steps.subject_template        — email subject (step 0)
--   campaign_enrollments.native_mailbox_id — sticky mailbox for thread continuity
--   lead_replies.gmail_*                    — native reply dedup + routing
--
-- Sending goes through a hand-rolled Gmail API client (service-account JWT
-- with domain-wide delegation; sub = the mailbox address) in src/lib/gmail/.
-- No warmup product: a brand-new inbox ramps by data (ramp_started_at +
-- max_daily_cap; the code computes the effective cap per week). No tracking
-- pixel or link rewriting — metrics are sent / bounced / replied only.
--
-- Manual step (documented in docs/native-email-runbook.md, NOT enforced
-- here): each sending DOMAIN must authorize the service account's client ID
-- for scopes gmail.send + gmail.readonly in Google Admin → Security → API
-- Controls → Domain-wide Delegation.
--
-- No RLS on the new tables — same stance as campaign_enrollments (00047)
-- and salesforge_enrollment_queue (00050): access is admin-client only
-- (owner endpoints + cron workers).
-- =============================================

-- Make schema explicit so this migration is portable across connections
-- whose default search_path may not include `public` (e.g. the Supabase
-- Management API's /database/query endpoint). Matches migration 00049/00050.
SET search_path TO public;

-- 1) Extend the channel + step-kind enums.
-- Postgres 12+ allows ALTER TYPE ... ADD VALUE inside a transaction, with
-- the caveat that the new value cannot be REFERENCED in the same
-- transaction. Nothing below references 'native_email' or 'email' as a
-- literal (no DEFAULT change, no row writes), so this is safe as one block —
-- same discipline as 00049:50-54 and 00053:28-32.
ALTER TYPE source_channel ADD VALUE IF NOT EXISTS 'native_email';
ALTER TYPE sequence_step_kind ADD VALUE IF NOT EXISTS 'email';

-- 2) Org-level Google service-account credentials (domain-wide delegation).
-- One service account can impersonate any mailbox on every domain that has
-- authorized its client ID, so these two columns are all we store — no
-- per-mailbox OAuth tokens. Same org-column pattern as the Salesforge /
-- Unipile keys in migration 00049. gmail_service_account_key is the PEM
-- private key; the client mints short-lived JWTs from it at send time.
ALTER TABLE organizations
  ADD COLUMN gmail_service_account_email TEXT,
  ADD COLUMN gmail_service_account_key TEXT;

-- 3) Sending-inbox registry.
-- ramp_started_at + max_daily_cap are "ramp as data": the worker computes
-- the effective daily cap from weeks elapsed (src/lib/gmail/ramp.ts). A
-- non-null daily_cap_override bypasses the ramp entirely. status='error'
-- is set by the worker when domain-wide delegation fails for this mailbox
-- (owner re-checks Admin console, then flips it back to 'active').
CREATE TABLE native_mailboxes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  -- Display/grouping only — which client this inbox sends on behalf of.
  client_id UUID REFERENCES clients(id) ON DELETE SET NULL,
  email_address TEXT NOT NULL,
  display_name TEXT,                        -- From: "Display Name <email>"
  provider TEXT NOT NULL DEFAULT 'gmail'
    CHECK (provider IN ('gmail')),          -- 'smtp' reserved for a later phase
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'paused', 'error')),
  ramp_started_at DATE NOT NULL DEFAULT CURRENT_DATE,
  max_daily_cap INT NOT NULL DEFAULT 20,    -- steady-state cold sends/day per inbox
  daily_cap_override INT,                   -- non-null bypasses the ramp
  last_error TEXT,
  last_error_at TIMESTAMPTZ,
  last_polled_at TIMESTAMPTZ,               -- reply-poller watermark
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, email_address)
);

CREATE INDEX idx_native_mailboxes_org_status
  ON native_mailboxes (organization_id, status);

CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON native_mailboxes
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- 4) Rotation pool: which mailboxes a campaign may send from. The worker
-- picks the healthiest under-cap mailbox from this set for each new
-- enrollment, then sticks with it for that contact's whole thread.
CREATE TABLE campaign_mailboxes (
  campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  mailbox_id UUID NOT NULL REFERENCES native_mailboxes(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (campaign_id, mailbox_id)
);

-- 5) Append-only send log. One row per successful send. This single table
-- is the per-mailbox daily-cap counter ("count where mailbox_id AND
-- sent_at >= local midnight"), the sent/bounced metric source, and the
-- reply-thread match index (gmail_thread_id). rfc_message_id is the
-- authoritative Message-ID read back from Gmail post-send, used to thread
-- follow-up steps via In-Reply-To/References.
CREATE TABLE native_sends (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  enrollment_id UUID REFERENCES campaign_enrollments(id) ON DELETE SET NULL,
  mailbox_id UUID NOT NULL REFERENCES native_mailboxes(id) ON DELETE CASCADE,
  step_index INT NOT NULL,
  to_email TEXT NOT NULL,
  rfc_message_id TEXT,        -- authoritative Message-ID read back post-send
  gmail_message_id TEXT,      -- Gmail's own id from users.messages.send
  gmail_thread_id TEXT,
  status TEXT NOT NULL DEFAULT 'sent'
    CHECK (status IN ('sent', 'bounced')),
  bounce_reason TEXT,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  bounced_at TIMESTAMPTZ
);

-- "How many did this mailbox send today" — the daily-cap counter query.
CREATE INDEX idx_native_sends_mailbox_sent_at
  ON native_sends (mailbox_id, sent_at);

-- Per-campaign metrics (sent / bounced counts, send log on campaign detail).
CREATE INDEX idx_native_sends_campaign_sent_at
  ON native_sends (campaign_id, sent_at);

-- Reply/bounce poller: match an inbound Gmail thread back to a send.
CREATE INDEX idx_native_sends_thread
  ON native_sends (gmail_thread_id)
  WHERE gmail_thread_id IS NOT NULL;

-- 6) Reuse of the existing sequence tables (the big lean move — no parallel
-- "email_steps" / "email_enrollments" tables).
--
-- subject_template is required on step 0 for an email sequence; NULL on
-- later steps means the worker sends "Re: <step-0 subject>" into the same
-- thread. Existing LinkedIn steps leave it NULL — harmless.
ALTER TABLE campaign_steps
  ADD COLUMN subject_template TEXT;

-- native_mailbox_id makes the mailbox sticky per enrollment (thread + SPF
-- alignment): once step 0 picks a mailbox, every follow-up threads through
-- it. gmail_thread_id + last_rfc_message_id carry the threading state so
-- the worker doesn't have to re-query native_sends every tick.
ALTER TABLE campaign_enrollments
  ADD COLUMN native_mailbox_id UUID REFERENCES native_mailboxes(id) ON DELETE SET NULL,
  ADD COLUMN gmail_thread_id TEXT,
  ADD COLUMN last_rfc_message_id TEXT;

-- 7) Per-reply Gmail identifiers for the native channel.
--
-- Dedup is a REGULAR UNIQUE constraint (not a partial unique index)
-- because the reply poller ingests via upsert / ON CONFLICT, which
-- PostgREST cannot match against a partial index — see migration 00029
-- (and 00049:82-88) for the same fix on the Instantly / Salesforge sides.
-- Postgres treats NULLs as distinct by default, so every Salesforge /
-- LinkedIn reply (NULL gmail_message_id) remains allowed.
ALTER TABLE lead_replies
  ADD COLUMN gmail_message_id TEXT,
  ADD COLUMN gmail_thread_id TEXT,
  ADD COLUMN native_mailbox_id UUID REFERENCES native_mailboxes(id) ON DELETE SET NULL;

ALTER TABLE lead_replies
  ADD CONSTRAINT lead_replies_gmail_message_dedupe
    UNIQUE (organization_id, gmail_message_id);

CREATE INDEX idx_lead_replies_gmail_thread
  ON lead_replies (gmail_thread_id)
  WHERE gmail_thread_id IS NOT NULL;
