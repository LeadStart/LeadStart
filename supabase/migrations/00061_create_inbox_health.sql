-- =============================================
-- Migration 00061: Inbox health scoring (native email channel)
--
-- Adds a per-mailbox health score (0-100) computed hourly by a new cron
-- (/api/cron/check-inbox-health) from free / already-paid signals: live
-- SPF/DKIM/DMARC/MX DNS checks, the Spamhaus domain blocklist (DBL), the
-- 7-day hard-bounce rate from native_sends, and Warmforge's per-mailbox
-- heat score + blacklist + warmup placement. Fulfils the "auto-benching on
-- bounce rate" item deferred in RESUME-NATIVE-EMAIL.md.
--
--   mailbox_health_checks                  — history of score transitions
--   native_mailboxes.health_*              — denormalized "current" score
--   organizations.spamhaus_dqs_key         — free Spamhaus DQS query key
--   organizations.inbox_health_offline_threshold
--                                          — NULL = alert-only; a number turns
--                                            on auto-pause below that score
--
-- Enforcement (auto-pause) is a plain status='paused' write on
-- native_mailboxes, which the send dispatcher already skips (eligible() in
-- run-native-sequences requires status='active') — no dispatcher change.
-- health_paused_at distinguishes an automatic bench from a manual pause and
-- is cleared when an owner manually resumes.
--
-- No RLS on the new table — same stance as native_mailboxes (00056) and
-- campaign_enrollments (00047): access is admin-client only (owner endpoints
-- + cron workers).
-- =============================================

-- Make schema explicit so this migration is portable across connections whose
-- default search_path may not include `public` (matches 00049/00050/00056).
SET search_path TO public;

-- 1) Health-check history. One row per SCORE TRANSITION (the cron inserts only
-- when the score changed from the mailbox's last value, or when an action was
-- taken), so this stays a compact "when did it degrade / recover" timeline
-- rather than one row per mailbox per hour — no prune cron needed.
--
-- components is the full per-signal breakdown the UI renders (blacklist, spf,
-- dkim, dmarc, mx, bounce_rate, heat_score, warmup_placement), including
-- "unchecked" signals. action is plain TEXT (same stance as owner_alerts.kind
-- in 00041) so a future 'auto_resumed' needs no migration.
CREATE TABLE mailbox_health_checks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  mailbox_id UUID NOT NULL REFERENCES native_mailboxes(id) ON DELETE CASCADE,
  checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  score INT NOT NULL CHECK (score BETWEEN 0 AND 100),
  band TEXT NOT NULL CHECK (band IN ('healthy', 'watch', 'critical')),
  components JSONB NOT NULL DEFAULT '[]'::jsonb,
  action TEXT                              -- NULL = observation only; 'auto_paused'
);

-- "Show me this mailbox's score history, newest first" — the detail timeline.
CREATE INDEX idx_mailbox_health_checks_mailbox
  ON mailbox_health_checks (mailbox_id, checked_at DESC);

-- 2) Denormalized "current" score on the mailbox itself. The mailboxes admin
-- table reads these directly (no join), and the cron's two-consecutive-runs
-- auto-pause guard reads health_score to see the prior run's value.
-- health_components is the current per-signal breakdown the admin UI expands
-- inline (the snapshot table keeps history; this is always the latest).
-- health_paused_at is set ONLY by an automatic bench and cleared on manual
-- resume, so the UI can label an auto-pause distinctly from a manual one.
ALTER TABLE native_mailboxes
  ADD COLUMN health_score INT,
  ADD COLUMN health_band TEXT,
  ADD COLUMN health_components JSONB,
  ADD COLUMN health_checked_at TIMESTAMPTZ,
  ADD COLUMN health_paused_at TIMESTAMPTZ;

-- 3) Org-level settings (same org-column pattern as the vendor keys in
-- 00049/00056). spamhaus_dqs_key is the free Data Query Service key used to
-- query the domain blocklist (public mirrors are blocked from cloud IPs).
-- inbox_health_offline_threshold: NULL = alert only, never auto-pause; a
-- number (e.g. 50) turns on auto-pause when a mailbox scores below it for two
-- consecutive checks.
ALTER TABLE organizations
  ADD COLUMN spamhaus_dqs_key TEXT,
  ADD COLUMN inbox_health_offline_threshold INT;
