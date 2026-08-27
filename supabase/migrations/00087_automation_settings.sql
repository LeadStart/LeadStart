-- Internal automations — org-level notify config for event-triggered
-- notifications (the "internal automation" surface behind the Flow builder's
-- kind:'internal' nodes). Purely additive + idempotent.
--
-- One JSONB blob on organizations, versioned by shape (mirrors the
-- enrichment_settings precedent, migration 00075):
-- {
--   "enabled": false,                    -- master switch; nothing fires until on
--   "notify_on": "hot",                  -- "hot" (positive replies) | "all_replies"
--   "slack_webhook_url": "",             -- Slack incoming-webhook URL ("" = off)
--   "notify_email": "",                  -- extra teammate address to email ("" = off)
--   "outbound_webhook_url": "",          -- generic outbound webhook POST target ("" = off)
--   "outbound_webhook_secret": ""        -- optional HMAC-SHA256 signing secret
-- }
-- NULL = disabled (code defaults, DEFAULT_AUTOMATION_SETTINGS in src/types/app.ts).
--
-- Event-triggered delivery runs from the reply pipeline today
-- (src/lib/replies/pipeline.ts → deliverReplyAutomations). Inline graph
-- internal-nodes will reuse these same targets via runInternalNode once the
-- branch-execution / graph runtime ships (out of scope here).
SET search_path TO public;

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS automation_settings JSONB;

COMMENT ON COLUMN organizations.automation_settings IS
  'Internal-automation notify config (migration 00087): {enabled, notify_on, slack_webhook_url, notify_email, outbound_webhook_url, outbound_webhook_secret}. NULL = disabled. Event-triggered from the reply pipeline; the graph runtime reuses these targets for inline internal nodes.';
