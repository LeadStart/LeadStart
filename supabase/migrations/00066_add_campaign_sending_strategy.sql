-- =============================================
-- Migration 00066: per-campaign sending strategy (native email)
--
-- Chooses how a native campaign spends its FIXED daily send budget (the sum of
-- its inboxes' warmup caps) between BRAND-NEW first-touches and FOLLOW-UPS. This
-- does not change how many emails a campaign can send in a day (that is set by
-- inbox count x per-inbox warmup cap) — only which emails win the day's slots.
--
--   'finish_first' (default, and the behavior every campaign has today) —
--     follow-ups win the day's send slots ahead of new first-touches, and new
--     leads are additionally throttled by daily_new_leads_cap. Every in-flight
--     contact is walked through the whole sequence before the queue reaches deep
--     into new people. Steady, predictable nurture; slow reach.
--
--   'reach_first' — new first-touches win the day's send slots ahead of
--     follow-ups, and daily_new_leads_cap no longer limits the RATE: email #1
--     goes out as fast as the warmed inboxes allow, bounded only by the
--     per-inbox warmup ceiling. Follow-ups fill the remaining capacity. Fast
--     top-of-funnel coverage; best for time-sensitive first touches (e.g. a
--     "congrats on closing" intro whose relevance decays).
--
-- daily_new_leads_cap = 0 still pauses new leads in BOTH strategies (an explicit
-- off switch), so switching to reach_first never overrides a deliberate pause.
--
-- NULL = inherit the code default (src/lib/gmail/ramp.ts DEFAULT_SENDING_STRATEGY
-- = 'finish_first'), so every existing campaign keeps today's behavior until an
-- owner switches it. Mirrors the nullable-column-with-code-default shape of the
-- per-campaign send window (00058) and new-leads cap (00064).
-- =============================================

SET search_path TO public;

ALTER TABLE campaigns
  ADD COLUMN IF NOT EXISTS sending_strategy TEXT;

ALTER TABLE campaigns
  ADD CONSTRAINT campaigns_sending_strategy_valid CHECK (
    sending_strategy IS NULL OR sending_strategy IN ('finish_first', 'reach_first')
  );
