-- =============================================
-- Migration 00059: per-client DNC (do-not-contact) list
--
-- Until now an opt-out flipped contacts.status='unsubscribed' on the single
-- shared contact row (email is unique per org), which is effectively a global
-- block: another client reusing that email inherits the suppression. That's
-- wrong — an opt-out is scoped to the sender/brand the person replied to. This
-- table records opt-outs (and manual adds) PER CLIENT, so "stop" to David
-- Cabrera's outreach blocks David's campaigns only, never another client's.
--
-- The native email sender checks this list (by the campaign's client_id)
-- before every send. The reply pipeline writes an entry on an 'unsubscribe'
-- classification, scoped to that reply's client. Manual add/remove is exposed
-- on the client detail page.
--
-- client_id is nullable: an orphan reply (no client yet) or a deliberately
-- org-wide manual entry lands with client_id = NULL. Email is stored
-- lowercase; the unique key dedupes repeat opt-outs per (org, client, email).
-- =============================================

SET search_path TO public;

CREATE TABLE dnc_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  client_id UUID REFERENCES clients(id) ON DELETE CASCADE,
  email TEXT NOT NULL,                       -- normalized lowercase
  reason TEXT NOT NULL DEFAULT 'unsubscribe' -- 'unsubscribe' | 'manual' | 'complaint' | 'bounce'
    CHECK (reason IN ('unsubscribe', 'manual', 'complaint', 'bounce')),
  source_channel TEXT,                       -- which channel triggered it
  source_reply_id UUID REFERENCES lead_replies(id) ON DELETE SET NULL,
  notes TEXT,
  created_by UUID,                           -- profile id for manual adds
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, client_id, email)
);

-- Hot path: "is this email on this client's DNC list" during a send tick.
CREATE INDEX idx_dnc_entries_client_email
  ON dnc_entries (organization_id, client_id, email);

-- No RLS — same stance as campaign_enrollments / native_* : admin-client only
-- (owner endpoints + cron workers).
