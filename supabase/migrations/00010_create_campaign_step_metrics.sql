-- Step-level analytics for per-step health monitoring
-- Stores reply/bounce/open rates per step per period so we can detect drops

CREATE TABLE IF NOT EXISTS campaign_step_metrics (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  step INTEGER NOT NULL,
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  sent INTEGER NOT NULL DEFAULT 0,
  replies INTEGER NOT NULL DEFAULT 0,
  unique_replies INTEGER NOT NULL DEFAULT 0,
  opens INTEGER NOT NULL DEFAULT 0,
  unique_opens INTEGER NOT NULL DEFAULT 0,
  bounces INTEGER NOT NULL DEFAULT 0,
  reply_rate NUMERIC(5,2) NOT NULL DEFAULT 0,
  open_rate NUMERIC(5,2) NOT NULL DEFAULT 0,
  bounce_rate NUMERIC(5,2) NOT NULL DEFAULT 0,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(campaign_id, step, period_start, period_end)
);

-- Index for fast lookups by campaign + step
CREATE INDEX idx_step_metrics_campaign_step ON campaign_step_metrics(campaign_id, step);
CREATE INDEX idx_step_metrics_period ON campaign_step_metrics(period_start, period_end);

-- RLS: only org members can see step metrics
ALTER TABLE campaign_step_metrics ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Step metrics viewable by org members"
  ON campaign_step_metrics FOR SELECT
  USING (
    campaign_id IN (
      SELECT id FROM campaigns
      WHERE organization_id IN (
        SELECT organization_id FROM profiles WHERE id = auth.uid()
      )
    )
  );
