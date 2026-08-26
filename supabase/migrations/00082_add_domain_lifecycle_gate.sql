-- =============================================
-- Migration 00082: Domain-lifecycle automation gate (org opt-in, default OFF)
--
-- The manage-mailbox-lifecycle cron (Phase 5 of the deliverability-infrastructure
-- plan) drives sending domains through warming → active → tired → resting →
-- re-warming automatically. Two of those transitions change live send behavior:
-- `tired` closes a domain's intake to new leads, and `resting` pauses all of its
-- mailboxes. Shipping that armed-by-default would let a deploy silently change how
-- the live fleet sends, so — exactly like the inbox-health auto-pause gate
-- (`inbox_health_offline_threshold`, migration 00061) — it is OPT-IN.
--
--   organizations.domain_lifecycle_enabled
--     false (default) → the cron runs in OBSERVE mode: it computes every
--                       decision and reports what it WOULD do, but applies
--                       nothing (no status writes, no mailbox pauses).
--     true            → the cron APPLIES transitions (and their side effects:
--                       drain/rest timers, mailbox pause on rest, resume + ramp
--                       reset on re-warm).
--
-- Apply by hand in the Supabase SQL editor (project exedxjrifprqgftyuroc).
-- =============================================

SET search_path TO public;

ALTER TABLE organizations
  ADD COLUMN domain_lifecycle_enabled BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN organizations.domain_lifecycle_enabled IS
  'Opt-in for the manage-mailbox-lifecycle cron. false = observe-only (compute + report, apply nothing); true = apply domain lifecycle transitions and their side effects. Mirrors the inbox_health_offline_threshold auto-pause opt-in.';
