-- =============================================
-- Migration 00140: hold unproven addresses + the campaign bounce stop
--
-- PolishPoint (campaign c598d088, launched 2026-10-26) bounced 11 of its first
-- 200 first emails: catch-all addresses 4 of 7, verified ones 7 of 190. The
-- sender was written to send catch-alls ("bounce monitoring + inbox-health
-- auto-pause catch any damage"), and that monitoring couldn't see anything in
-- week one. Owner picks, 2026-11-01: the sender holds catch-all and unknown
-- addresses unless the campaign opts in, and a campaign's new contacts pause by
-- themselves at 3 bad-address bounces in its last 100 first emails.
--
--   campaigns.send_unproven_addresses
--     false (default) = a first email to a catch-all or unknown address is held:
--     the enrollment leaves the line (paused, last_error "Held: unproven
--     address ..."). true = the campaign sends them, flagged risky (the old
--     behaviour). Every existing campaign starts at false on purpose.
--
--   campaigns.bounce_stop_at
--     When the bounce stop last paused this campaign's new contacts
--     (daily_new_leads_cap = 0). The stop only counts first emails sent after
--     it, so resuming starts a clean window instead of tripping again at once.
--
-- Additive only: two columns, no data changed.
-- Apply by hand or through the Management API (project exedxjrifprqgftyuroc).
-- =============================================

SET search_path TO public;

ALTER TABLE campaigns
  ADD COLUMN IF NOT EXISTS send_unproven_addresses BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE campaigns
  ADD COLUMN IF NOT EXISTS bounce_stop_at TIMESTAMPTZ;

COMMENT ON COLUMN campaigns.send_unproven_addresses IS
  'false = first emails to catch-all / unknown addresses are held out of line; true = they send, flagged risky (migration 00140)';
COMMENT ON COLUMN campaigns.bounce_stop_at IS
  'When the bounce stop last paused new contacts; the stop counts only first emails sent after it (migration 00140)';
