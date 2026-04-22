-- Collapse the three "called_*" outcomes into a single `called`.
--
-- The original taxonomy distinguished called_booked / called_vm /
-- called_no_answer. In practice that nuance is better captured in
-- outcome_notes — the hot signal we need from the outcome column is
-- binary: did they actually call? Simpler options = faster logging
-- = more complete data.

BEGIN;

-- 1. Drop the inline CHECK from 00025 so we can update rows freely.
ALTER TABLE lead_replies
  DROP CONSTRAINT IF EXISTS lead_replies_outcome_check;

-- 2. Migrate existing rows: anything called_* becomes plain called.
UPDATE lead_replies
   SET outcome = 'called'
 WHERE outcome IN ('called_booked', 'called_vm', 'called_no_answer');

-- 3. Re-add the constraint with the new, narrower domain.
ALTER TABLE lead_replies
  ADD CONSTRAINT lead_replies_outcome_check
  CHECK (outcome IS NULL OR outcome IN ('called', 'emailed', 'no_contact'));

COMMIT;
