-- =============================================
-- Migration: AI reply classification & routing pipeline
-- Creates lead_replies (inbound replies with Claude-classified routing)
-- Adds client-level persona + notification config columns
-- Plan: docs/plans/ai-reply-routing.md
-- =============================================

-- 1. Reply status enum ----------------------------------------------------
CREATE TYPE public.reply_status AS ENUM (
  'new',        -- just ingested, not yet classified
  'classified', -- classifier ran, waiting for client action (hot classes only)
  'sent',       -- client sent email reply via portal
  'resolved',   -- client handled offline (called, etc.)
  'rejected',   -- client explicitly dismissed
  'expired'     -- auto-expired after 48h of no action
);

-- 2. lead_replies table ---------------------------------------------------
CREATE TABLE public.lead_replies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  client_id UUID NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  campaign_id UUID REFERENCES public.campaigns(id) ON DELETE SET NULL,

  -- Instantly references (for thread continuity + dedupe)
  instantly_email_id TEXT,           -- Instantly's internal email uuid (reply target)
  instantly_message_id TEXT,         -- RFC 5322 Message-ID, stable across retries
  thread_id TEXT,                    -- Instantly's thread grouping id
  instantly_campaign_id TEXT,        -- raw Instantly campaign id from payload

  -- Lead / prospect identity
  lead_email TEXT NOT NULL,
  lead_name TEXT,
  lead_company TEXT,
  lead_title TEXT,
  lead_phone_e164 TEXT,              -- pulled straight from webhook payload
  lead_linkedin_url TEXT,

  -- Reply content
  from_address TEXT,
  to_address TEXT,
  subject TEXT,
  body_text TEXT,
  body_html TEXT,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  raw_payload JSONB,                 -- full webhook body for audit / reclassify

  -- Classification signals
  instantly_category TEXT,           -- raw tag from Instantly's classifier
  keyword_flags TEXT[] DEFAULT '{}', -- prefilter hits: wrong_person, referral_email_present, unsubscribe_phrase, etc.
  claude_class TEXT,                 -- structured output from Haiku classifier
  claude_confidence NUMERIC(3,2),    -- 0.00–1.00
  claude_reason TEXT,                -- one-line justification
  referral_contact JSONB,            -- {email, name, title} when claude_class = 'referral_forward'
  final_class TEXT,                  -- the class used for routing (see taxonomy in plan)
  classified_at TIMESTAMPTZ,

  -- Notification delivery
  notified_at TIMESTAMPTZ,
  notification_token_hash TEXT,      -- HMAC hash for the signed portal deep-link
  notification_email_id TEXT,        -- Resend message id for audit

  -- Outcome (post-contact disposition)
  outcome TEXT CHECK (outcome IS NULL OR outcome IN (
    'called_booked', 'called_vm', 'called_no_answer', 'emailed', 'no_contact'
  )),
  outcome_notes TEXT,
  outcome_logged_at TIMESTAMPTZ,
  outcome_logged_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,

  -- Optional drafter output (only if client opens the email-reply composer)
  draft_body TEXT,
  draft_subject TEXT,
  draft_model TEXT,
  draft_token_usage JSONB,
  draft_generated_at TIMESTAMPTZ,
  draft_regenerations INT NOT NULL DEFAULT 0,

  -- Send (only if client chose to email-reply)
  status public.reply_status NOT NULL DEFAULT 'new',
  final_body_text TEXT,
  final_body_html TEXT,
  sent_at TIMESTAMPTZ,
  sent_instantly_email_id TEXT,
  error TEXT,

  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Auto-update updated_at
CREATE TRIGGER set_updated_at_on_lead_replies
  BEFORE UPDATE ON public.lead_replies
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- 3. Indexes --------------------------------------------------------------
-- Webhook dedupe — same message should collapse on retry
CREATE UNIQUE INDEX idx_lead_replies_message_dedupe
  ON public.lead_replies(organization_id, instantly_message_id)
  WHERE instantly_message_id IS NOT NULL;

-- Client-portal inbox list (hot classes, reverse-chron)
CREATE INDEX idx_lead_replies_client_hot
  ON public.lead_replies(client_id, final_class, received_at DESC)
  WHERE final_class IS NOT NULL;

-- Admin oversight list (org-wide)
CREATE INDEX idx_lead_replies_org_hot
  ON public.lead_replies(organization_id, final_class, received_at DESC);

-- Thread lookup
CREATE INDEX idx_lead_replies_thread
  ON public.lead_replies(thread_id)
  WHERE thread_id IS NOT NULL;

-- Unresolved queue (for expire-replies cron)
CREATE INDEX idx_lead_replies_pending
  ON public.lead_replies(received_at)
  WHERE status IN ('new', 'classified');

-- 4. Row-level security ---------------------------------------------------
ALTER TABLE public.lead_replies ENABLE ROW LEVEL SECURITY;

-- Admin/VA: full read across their org
CREATE POLICY "Admin/VA can view all replies in org"
  ON public.lead_replies FOR SELECT
  USING (
    organization_id = public.get_my_org_id()
    AND public.get_my_role() IN ('owner', 'va')
  );

-- Admin/VA: update (reclassify, amend outcomes, etc.)
CREATE POLICY "Admin/VA can update replies in org"
  ON public.lead_replies FOR UPDATE
  USING (
    organization_id = public.get_my_org_id()
    AND public.get_my_role() IN ('owner', 'va')
  );

-- Client: read their own replies
CREATE POLICY "Client can view own replies"
  ON public.lead_replies FOR SELECT
  USING (
    client_id IN (
      SELECT client_id FROM public.client_users WHERE user_id = auth.uid()
    )
  );

-- Client: update outcome fields only (status/outcome/outcome_notes/final_body_*)
-- Postgres RLS can't restrict to specific columns; we rely on application layer
-- to call only the /api/replies/[id]/outcome and /api/replies/[id]/send routes,
-- both of which run under createAdminClient() after verifying client ownership.
-- For direct client-side updates we still need this policy so SWR mutate works:
CREATE POLICY "Client can update own replies"
  ON public.lead_replies FOR UPDATE
  USING (
    client_id IN (
      SELECT client_id FROM public.client_users WHERE user_id = auth.uid()
    )
  );

-- INSERT is handled exclusively by the webhook handler via createAdminClient().
-- No client- or admin-role insert policy.

-- 5. clients column additions --------------------------------------------
ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS notification_email TEXT,
  ADD COLUMN IF NOT EXISTS phone_number TEXT,
  ADD COLUMN IF NOT EXISTS auto_notify_classes TEXT[]
    NOT NULL DEFAULT '{true_interest, meeting_booked, qualifying_question, referral_forward}',
  ADD COLUMN IF NOT EXISTS persona_name TEXT,
  ADD COLUMN IF NOT EXISTS persona_title TEXT,
  ADD COLUMN IF NOT EXISTS persona_linkedin_url TEXT,
  ADD COLUMN IF NOT EXISTS persona_photo_url TEXT,
  ADD COLUMN IF NOT EXISTS brand_voice TEXT,
  ADD COLUMN IF NOT EXISTS signature_block TEXT;

-- 6. organizations column additions ---------------------------------------
ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS instantly_webhook_id TEXT;

-- 7. webhook_events index for correlation ---------------------------------
-- Used by tagReply() to find the lead_replies row when a lead_* tag event
-- arrives after the reply_received event (out-of-order webhooks).
CREATE INDEX IF NOT EXISTS idx_webhook_events_message_id
  ON public.webhook_events ((payload ->> 'message_id'));
