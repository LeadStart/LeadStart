-- =============================================
-- Migration 00045: Multi-channel scaffolding (source_channel discriminator)
--
-- LeadStart is moving from a single-channel email-only product (Instantly)
-- to multi-channel outreach where LinkedIn (via Unipile) sits alongside
-- email. To route campaigns, replies, and webhook events to the right
-- handler, we need a channel discriminator on three tables:
--
--   campaigns       — distinguish Instantly campaigns from LinkedIn ones
--   lead_replies    — route inbound replies to the right thread/composer
--   webhook_events  — split the audit log between providers
--
-- The DEFAULT 'instantly' on every column means existing rows backfill
-- automatically and existing query paths keep working unchanged. Indexes
-- support channel-filtered admin views (e.g. /admin/campaigns?channel=…).
-- =============================================

CREATE TYPE source_channel AS ENUM ('instantly', 'linkedin');

ALTER TABLE campaigns
  ADD COLUMN source_channel source_channel NOT NULL DEFAULT 'instantly';

ALTER TABLE lead_replies
  ADD COLUMN source_channel source_channel NOT NULL DEFAULT 'instantly';

ALTER TABLE webhook_events
  ADD COLUMN source_channel source_channel NOT NULL DEFAULT 'instantly';

CREATE INDEX idx_campaigns_source_channel
  ON campaigns (source_channel);

CREATE INDEX idx_lead_replies_source_channel
  ON lead_replies (source_channel);

CREATE INDEX idx_webhook_events_source_channel
  ON webhook_events (source_channel);
