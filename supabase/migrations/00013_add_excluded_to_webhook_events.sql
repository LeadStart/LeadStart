-- Add excluded column to webhook_events for admin lead exclusion
-- When a lead is miscategorized as "interested" on Instantly, admin can exclude it
ALTER TABLE webhook_events ADD COLUMN excluded boolean NOT NULL DEFAULT false;

-- Index for efficient filtering
CREATE INDEX idx_webhook_events_excluded ON webhook_events (excluded) WHERE excluded = true;
