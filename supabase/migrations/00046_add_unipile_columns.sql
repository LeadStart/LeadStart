-- =============================================
-- Migration 00046: Unipile (LinkedIn) integration columns
--
-- Unipile is a unified messaging API that brokers LinkedIn (and, later,
-- email + WhatsApp) traffic. The integration model:
--
--   - One Unipile workspace per LeadStart org. Workspace creds are an
--     api_key + a DSN (Unipile assigns each workspace a regional host
--     like https://api7.unipile.com:13779). Stored on organizations.
--
--   - Zero or one connected LinkedIn account per LeadStart client.
--     Obtained via Unipile's hosted-auth flow, which returns an
--     account_id we persist on clients.unipile_account_id. The
--     unipile_account_status column tracks cookie expiry — Unipile
--     emits an account_disconnected webhook when LinkedIn forces a
--     re-auth (typically every 1–3 months).
--
--   - LinkedIn replies arrive via Unipile webhook with a chat_id
--     (thread) and message_id. Both are stored on lead_replies for
--     dedup + threading; the existing instantly_email_id /
--     instantly_message_id columns become nullable since LinkedIn
--     replies don't have Instantly identifiers.
--
-- Also wires AI-opener prep on contacts: contacts.intro_line already
-- exists (per migration 00010); this adds metadata so a future Haiku
-- worker can identify openers it generated and decide when to refresh
-- them. No worker is built in this migration — wiring only.
-- =============================================

-- 1) Org-level Unipile workspace credentials
ALTER TABLE organizations
  ADD COLUMN unipile_api_key TEXT,
  ADD COLUMN unipile_dsn TEXT,
  ADD COLUMN unipile_webhook_id TEXT;

-- 2) Per-client connected LinkedIn account
ALTER TABLE clients
  ADD COLUMN unipile_account_id TEXT,
  ADD COLUMN unipile_account_status TEXT
    CHECK (unipile_account_status IS NULL
           OR unipile_account_status IN ('disconnected', 'connected', 'expired'));

CREATE INDEX idx_clients_unipile_account
  ON clients (unipile_account_id)
  WHERE unipile_account_id IS NOT NULL;

-- 3) Per-campaign account binding (which connected LinkedIn account drives
--    this campaign — typically equals clients.unipile_account_id but kept
--    separate so an org could rotate accounts without invalidating campaign
--    history).
ALTER TABLE campaigns
  ADD COLUMN unipile_account_id TEXT;

-- 4) Per-reply Unipile IDs (dedup + threading)
ALTER TABLE lead_replies
  ADD COLUMN unipile_message_id TEXT,
  ADD COLUMN unipile_chat_id TEXT;

-- Webhook dedup mirrors the existing instantly_message_id pattern: org-scoped
-- unique on the Unipile message_id when present.
CREATE UNIQUE INDEX idx_lead_replies_unipile_message
  ON lead_replies (organization_id, unipile_message_id)
  WHERE unipile_message_id IS NOT NULL;

CREATE INDEX idx_lead_replies_unipile_chat
  ON lead_replies (unipile_chat_id)
  WHERE unipile_chat_id IS NOT NULL;

-- LinkedIn replies don't carry Instantly IDs. Drop NOT NULL where it exists
-- so a LinkedIn reply can be inserted with the Instantly columns null.
ALTER TABLE lead_replies
  ALTER COLUMN instantly_email_id DROP NOT NULL,
  ALTER COLUMN instantly_message_id DROP NOT NULL;

-- 5) AI-opener prep wiring on contacts
-- contacts.intro_line already exists (migration 00010). These two columns
-- let a future Haiku worker identify which openers it wrote vs ones the
-- client wrote manually, and when each was generated (for stale-detection).
-- intro_line_model = NULL means manually written; non-NULL means AI-generated.
ALTER TABLE contacts
  ADD COLUMN intro_line_model TEXT,
  ADD COLUMN intro_line_generated_at TIMESTAMPTZ;
