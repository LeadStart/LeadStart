-- =============================================
-- Migration 00047: LinkedIn sequence engine
--
-- Adds the two tables that drive automated multi-step outreach for the
-- LinkedIn channel (commits #6 / #7):
--
--   campaign_steps        — the sequence template (one row per step)
--   campaign_enrollments  — per-contact progress through the sequence
--
-- Also relaxes campaigns.instantly_campaign_id from NOT NULL to nullable
-- so a LinkedIn campaign — which has no Instantly id — can live on the
-- same campaigns table. The original UNIQUE(organization_id,
-- instantly_campaign_id) constraint becomes a partial unique index that
-- only applies when the column is non-null.
-- =============================================

-- 1) Allow campaigns without an Instantly id (LinkedIn-only sequences)
ALTER TABLE campaigns
  ALTER COLUMN instantly_campaign_id DROP NOT NULL;

ALTER TABLE campaigns
  DROP CONSTRAINT IF EXISTS campaigns_organization_id_instantly_campaign_id_key;

CREATE UNIQUE INDEX IF NOT EXISTS idx_campaigns_org_instantly_unique
  ON campaigns (organization_id, instantly_campaign_id)
  WHERE instantly_campaign_id IS NOT NULL;

-- 2) Sequence step kinds. like_post and profile_visit are reserved for
--    future engagement steps; the cron in commit #7 dispatches only
--    connect_request and message at first.
CREATE TYPE sequence_step_kind AS ENUM (
  'connect_request',
  'message',
  'inmail',
  'like_post',
  'profile_visit'
);

-- 3) Sequence template — one row per step, ordered by step_index.
CREATE TABLE campaign_steps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  step_index INT NOT NULL,
  kind sequence_step_kind NOT NULL,
  wait_days INT NOT NULL DEFAULT 0,
  body_template TEXT,
  conditions JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (campaign_id, step_index)
);

CREATE INDEX idx_campaign_steps_campaign
  ON campaign_steps (campaign_id, step_index);

-- 4) Enrollment status. 'active' = currently progressing through the
--    sequence; 'replied' = inbound reply paused the sequence; 'completed'
--    = reached the last step; 'failed' = a dispatch errored fatally.
CREATE TYPE enrollment_status AS ENUM (
  'active',
  'paused',
  'completed',
  'replied',
  'failed'
);

-- 5) Per-contact progression. The cron worker reads from this table
--    every 15 minutes; the partial idx_campaign_enrollments_due index
--    makes "what's due to dispatch" a fast scan.
CREATE TABLE campaign_enrollments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  current_step_index INT NOT NULL DEFAULT 0,
  last_action_at TIMESTAMPTZ,
  status enrollment_status NOT NULL DEFAULT 'active',
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  unipile_chat_id TEXT,
  unipile_invitation_id TEXT,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (campaign_id, contact_id)
);

CREATE INDEX idx_campaign_enrollments_status
  ON campaign_enrollments (campaign_id, status);

CREATE INDEX idx_campaign_enrollments_due
  ON campaign_enrollments (status, last_action_at)
  WHERE status = 'active';

CREATE INDEX idx_campaign_enrollments_chat
  ON campaign_enrollments (unipile_chat_id)
  WHERE unipile_chat_id IS NOT NULL;

CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON campaign_enrollments
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
