-- Campaign analytics snapshots (no open/click tracking - hurts deliverability)
CREATE TABLE public.campaign_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID NOT NULL REFERENCES public.campaigns(id) ON DELETE CASCADE,
  snapshot_date DATE NOT NULL,
  -- Core metrics
  total_leads INTEGER DEFAULT 0,
  emails_sent INTEGER DEFAULT 0,
  replies INTEGER DEFAULT 0,
  unique_replies INTEGER DEFAULT 0,
  positive_replies INTEGER DEFAULT 0,
  bounces INTEGER DEFAULT 0,
  unsubscribes INTEGER DEFAULT 0,
  meetings_booked INTEGER DEFAULT 0,
  new_leads_contacted INTEGER DEFAULT 0,
  -- Calculated rates (stored for fast reads)
  reply_rate NUMERIC(5,2),
  positive_reply_rate NUMERIC(5,2),
  bounce_rate NUMERIC(5,2),
  unsubscribe_rate NUMERIC(5,2),
  -- Raw JSON from Instantly for reference
  raw_data JSONB,
  fetched_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(campaign_id, snapshot_date)
);

CREATE INDEX idx_snapshots_campaign_date ON public.campaign_snapshots(campaign_id, snapshot_date DESC);
