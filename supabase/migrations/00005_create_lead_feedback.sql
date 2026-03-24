-- Lead feedback statuses
CREATE TYPE public.feedback_status AS ENUM (
  'good_lead', 'bad_lead', 'already_contacted',
  'wrong_person', 'interested', 'not_interested', 'other'
);

-- Lead feedback from clients
CREATE TABLE public.lead_feedback (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID NOT NULL REFERENCES public.campaigns(id) ON DELETE CASCADE,
  lead_email TEXT NOT NULL,
  lead_name TEXT,
  lead_company TEXT,
  status feedback_status NOT NULL,
  comment TEXT,
  submitted_by UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_feedback_campaign ON public.lead_feedback(campaign_id);
CREATE INDEX idx_feedback_submitted_by ON public.lead_feedback(submitted_by);
