-- =============================================
-- Migration 00068: Seed inboxes + inbox-placement tests (native email channel)
--
-- Closes the "seed/placement spot-check" gap called out in the inbox-health
-- design: every signal scored so far (DNS, blacklist, bounce rate, a zero-reply
-- proxy) is a *proxy* for where mail lands. A placement test measures it
-- directly — send a probe from a sending mailbox to a panel of seed inboxes we
-- control, then read each seed via the Gmail API (domain-wide delegation,
-- gmail.readonly) to see whether the probe landed in Inbox, Promotions, or
-- Spam, and what the RECEIVER's Authentication-Results header says about
-- SPF/DKIM/DMARC. That is the "why" behind a health-score dip.
--
--   seed_inboxes             — the panel: Google Workspace inboxes on domains
--                              that have authorized the service account
--                              (v1: provider 'google_workspace' only)
--   placement_tests          — one row per probe run per mailbox
--   placement_test_results   — one row per seed per run (folder + auth)
--   organizations.placement_test_interval_days
--                            — NULL = manual only; N = the cron re-probes every
--                              active mailbox every N days (default 7)
--
-- Probe sends are NOT logged to native_sends on purpose: they are not campaign
-- sends, so they must not move the ramp, the daily counter, the bounce rate or
-- the reply denominator. The ramp ceiling is a reputation guard for cold mail
-- to strangers; a handful of probes/week to inboxes we own is not that.
--
-- RLS mirrors 00062: owner/va org-scoped FOR ALL; service-role (cron + API
-- routes via createAdminClient) bypasses. Clients never read these tables.
-- Apply by hand in the Supabase SQL editor (project exedxjrifprqgftyuroc).
-- =============================================

SET search_path TO public;

-- 1) Seed panel. Same shape/status vocabulary as native_mailboxes so the admin
-- UI and the DWD verification path (getProfile on add) are shared. A seed
-- flips to 'error' when a read fails with an auth error (delegation revoked)
-- and is skipped until an owner fixes the Google side and resumes it.
CREATE TABLE seed_inboxes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email_address TEXT NOT NULL,
  label TEXT,                               -- free text, e.g. "Workspace – davidcabrera"
  provider TEXT NOT NULL DEFAULT 'google_workspace'
    CHECK (provider IN ('google_workspace')),  -- 'imap' / 'microsoft_graph' reserved
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'paused', 'error')),
  last_error TEXT,
  last_error_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, email_address)
);

CREATE INDEX idx_seed_inboxes_org_status
  ON seed_inboxes (organization_id, status);

CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON seed_inboxes
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- 2) One row per probe run. probe = what was sent: 'neutral' is a short,
-- realistic, link-free note (tests reputation + auth in isolation);
-- 'campaign' renders step 1 of the campaign this mailbox is pooled into with
-- sample merge values (tests the actual copy). Running both and comparing
-- splits "domain/reputation problem" from "this copy trips the filter".
-- Counts are denormalized at completion so the mailboxes list and the health
-- cron never join the results table.
CREATE TABLE placement_tests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  mailbox_id UUID NOT NULL REFERENCES native_mailboxes(id) ON DELETE CASCADE,
  probe TEXT NOT NULL DEFAULT 'neutral'
    CHECK (probe IN ('neutral', 'campaign')),
  campaign_id UUID REFERENCES campaigns(id) ON DELETE SET NULL,  -- set for 'campaign' probes
  triggered_by TEXT NOT NULL DEFAULT 'manual'
    CHECK (triggered_by IN ('manual', 'scheduled')),
  status TEXT NOT NULL DEFAULT 'sending'
    CHECK (status IN ('sending', 'awaiting', 'complete', 'failed')),
  subject TEXT,                             -- the probe subject actually sent
  seeds_total INT NOT NULL DEFAULT 0,       -- readable seeds (excludes send_failed/unreadable)
  inbox_count INT NOT NULL DEFAULT 0,
  promotions_count INT NOT NULL DEFAULT 0,
  spam_count INT NOT NULL DEFAULT 0,
  missing_count INT NOT NULL DEFAULT 0,     -- missing + bounced + other
  auth_summary JSONB,                       -- { checked, spf_fail, dkim_fail, dmarc_fail }
  error TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_at TIMESTAMPTZ,                      -- all probes dispatched; checks may begin
  completed_at TIMESTAMPTZ
);

-- "Latest test for this mailbox" (mailboxes list, health cron, scheduler).
CREATE INDEX idx_placement_tests_mailbox_started
  ON placement_tests (mailbox_id, started_at DESC);

-- The finalizer cron's work queue.
CREATE INDEX idx_placement_tests_open
  ON placement_tests (status)
  WHERE status IN ('sending', 'awaiting');

-- 3) One row per seed per run. rfc_message_id is what we search the seed for
-- (Gmail's rfc822msgid: operator); gmail_message_id/gmail_thread_id are the
-- SENDER-side ids (used to spot a bounce DSN in the sender's mailbox when a
-- seed never receives the probe). labels = the raw Gmail labelIds observed in
-- the seed inbox (INBOX, CATEGORY_PROMOTIONS, SPAM, ...), kept for debugging.
--   pending      not looked up yet / not found yet
--   inbox        INBOX (Primary/Updates/…)          → delivered
--   promotions   INBOX + CATEGORY_PROMOTIONS          → delivered, but filed as marketing
--   spam         SPAM
--   other        present but neither INBOX nor SPAM (archived / user filter)
--   missing      not found in the seed after the timeout, no DSN
--   bounced      sender received a DSN for this probe
--   send_failed  the probe send itself failed (excluded from totals)
--   unreadable   the seed could not be read (delegation) (excluded from totals)
CREATE TABLE placement_test_results (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  test_id UUID NOT NULL REFERENCES placement_tests(id) ON DELETE CASCADE,
  seed_inbox_id UUID REFERENCES seed_inboxes(id) ON DELETE SET NULL,
  seed_email TEXT NOT NULL,
  rfc_message_id TEXT,
  gmail_message_id TEXT,
  gmail_thread_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'inbox', 'promotions', 'spam', 'other',
                      'missing', 'bounced', 'send_failed', 'unreadable')),
  labels TEXT[],
  auth_results JSONB,                       -- { spf, dkim, dmarc, raw } as the receiver saw them
  detail TEXT,                              -- bounce reason / send or read error
  sent_at TIMESTAMPTZ,
  found_at TIMESTAMPTZ,
  checked_at TIMESTAMPTZ
);

CREATE INDEX idx_placement_test_results_test
  ON placement_test_results (test_id);

-- 4) Org-level schedule. Default 7: once a panel exists, every active mailbox
-- gets a fresh neutral probe weekly without anyone clicking, so the health
-- score's seed_placement component stays populated. NULL = manual only.
ALTER TABLE organizations
  ADD COLUMN placement_test_interval_days INT DEFAULT 7;

-- 5) RLS — same owner/va org-scoped shape as native_mailboxes (00062).
ALTER TABLE seed_inboxes           ENABLE ROW LEVEL SECURITY;
ALTER TABLE placement_tests        ENABLE ROW LEVEL SECURITY;
ALTER TABLE placement_test_results ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS seed_inboxes_admin_all ON public.seed_inboxes;
CREATE POLICY seed_inboxes_admin_all ON public.seed_inboxes
  FOR ALL
  USING (
    organization_id = public.get_my_org_id()
    AND public.get_my_role() IN ('owner', 'va')
  )
  WITH CHECK (
    organization_id = public.get_my_org_id()
    AND public.get_my_role() IN ('owner', 'va')
  );

DROP POLICY IF EXISTS placement_tests_admin_all ON public.placement_tests;
CREATE POLICY placement_tests_admin_all ON public.placement_tests
  FOR ALL
  USING (
    organization_id = public.get_my_org_id()
    AND public.get_my_role() IN ('owner', 'va')
  )
  WITH CHECK (
    organization_id = public.get_my_org_id()
    AND public.get_my_role() IN ('owner', 'va')
  );

DROP POLICY IF EXISTS placement_test_results_admin_all ON public.placement_test_results;
CREATE POLICY placement_test_results_admin_all ON public.placement_test_results
  FOR ALL
  USING (
    public.get_my_role() IN ('owner', 'va')
    AND test_id IN (
      SELECT id FROM public.placement_tests
      WHERE organization_id = public.get_my_org_id()
    )
  )
  WITH CHECK (
    public.get_my_role() IN ('owner', 'va')
    AND test_id IN (
      SELECT id FROM public.placement_tests
      WHERE organization_id = public.get_my_org_id()
    )
  );

COMMENT ON TABLE seed_inboxes IS
  'Inbox-placement seed panel: Google Workspace inboxes (DWD-authorized) that sending mailboxes probe; read via Gmail API to see Inbox/Promotions/Spam.';
COMMENT ON TABLE placement_tests IS
  'One inbox-placement probe run per sending mailbox; counts denormalized at completion; feeds the seed_placement inbox-health component.';
COMMENT ON COLUMN organizations.placement_test_interval_days IS
  'Days between automatic neutral placement probes per active mailbox (run-placement-tests cron). NULL = manual only.';
