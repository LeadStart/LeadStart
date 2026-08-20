-- Track soft (transient) bounces on native_sends WITHOUT suppressing the contact.
--
-- A soft bounce (4.x.x DSN) is a temporary failure Gmail retries on its own, so
-- it must NOT flip the contact to 'bounced' (that would wrongly kill a reachable
-- lead — see the soft-bounce branch in poll-native-replies). But a rising
-- soft-bounce rate is an early throttling / greylisting signal worth surfacing
-- in inbox health, so we stamp when the most recent soft bounce for a send was
-- observed and let the health scorer count it as a low-weight, warn-only signal.
--
-- Nullable, no backfill: existing rows simply read as "no soft bounce observed",
-- which is the correct default. The inbox-health cron counts rows where
-- soft_bounced_at is set within the scoring window.

ALTER TABLE native_sends
  ADD COLUMN IF NOT EXISTS soft_bounced_at timestamptz;

COMMENT ON COLUMN native_sends.soft_bounced_at IS
  'When the most recent soft (4.x.x) bounce for this send was observed. Does NOT change status (soft bounces are not suppressed); feeds the inbox-health soft-bounce signal.';
