-- Instantly webhook events log
CREATE TABLE public.webhook_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id),
  event_type TEXT NOT NULL,
  campaign_instantly_id TEXT,
  lead_email TEXT,
  payload JSONB NOT NULL,
  processed BOOLEAN DEFAULT false,
  received_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_webhook_events_type ON public.webhook_events(event_type, received_at DESC);
CREATE INDEX idx_webhook_events_unprocessed ON public.webhook_events(processed) WHERE NOT processed;
