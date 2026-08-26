-- =============================================
-- Migration 00083: Optional per-domain daily send cap (defense-in-depth)
--
-- Per-mailbox ramp caps (src/lib/gmail/ramp.ts) already bound how much any one
-- inbox sends, so a domain's daily volume is implicitly capped at the sum of its
-- mailboxes' caps. This adds an OPTIONAL hard ceiling on top: a single number
-- that limits cold sends per day across ALL of a domain's mailboxes, regardless
-- of how many it has. Useful when a domain accumulates many mailboxes (the
-- SMTP tier, Phase 4) and you want to keep total domain volume below the naive
-- per-mailbox sum — a high per-domain volume is itself a reputation risk.
--
--   sending_domains.max_daily_sends
--     NULL (default) → no domain-level cap; per-mailbox ramp caps still apply
--                      (unchanged behavior for every existing domain).
--     N              → the run-native-sequences dispatcher stops sending from a
--                      domain once it has sent N cold emails today (across all
--                      its mailboxes), even mid-sequence.
--
-- The dispatcher skips ALL domain-cap bookkeeping when no domain has a cap set,
-- so this is zero-overhead until used.
--
-- Apply by hand in the Supabase SQL editor (project exedxjrifprqgftyuroc).
-- =============================================

SET search_path TO public;

ALTER TABLE sending_domains
  ADD COLUMN max_daily_sends INT;

COMMENT ON COLUMN sending_domains.max_daily_sends IS
  'Optional hard ceiling on cold sends/day across ALL of this domain''s mailboxes (defense-in-depth over per-mailbox ramp caps). NULL = no domain-level cap.';
