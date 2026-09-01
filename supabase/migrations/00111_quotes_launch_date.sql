-- Onboarding/billing timing: freeze the launch (first-charge) date on the quote.
--
-- Until now the launch day + first monthly charge were recomputed from "now" in
-- three places (the hosted quote page, the admin preview, and the Stripe
-- trial_end at acceptance), so what a client saw could drift from what they were
-- actually billed, and the admin couldn't see a concrete date before acceptance.
-- We now resolve the date ONCE at send and store it here; every surface reads it.
--
-- launch_date_mode records how it was chosen:
--   'derived' — send date + warming_days, rolled to the next Mon–Fri (the default)
--   'fixed'   — a specific calendar date the admin pinned
--
-- Purely additive + idempotent. Legacy rows keep launch_date NULL and fall back
-- to the old on-the-fly computation, so nothing breaks pre-backfill.

SET search_path TO public;

ALTER TABLE quotes ADD COLUMN IF NOT EXISTS launch_date TIMESTAMPTZ;
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS launch_date_mode TEXT NOT NULL DEFAULT 'derived';

-- Guard the mode values (drop-then-add keeps this idempotent across re-runs).
ALTER TABLE quotes DROP CONSTRAINT IF EXISTS quotes_launch_date_mode_check;
ALTER TABLE quotes ADD CONSTRAINT quotes_launch_date_mode_check
  CHECK (launch_date_mode IN ('derived', 'fixed'));
