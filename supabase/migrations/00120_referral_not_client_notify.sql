-- 00111_referral_not_client_notify.sql
--
-- Referral replies are owner-facing, never a client "call now" signal, so they
-- must not trigger the client hot-lead email. This migration aligns the stored
-- notify config with that decision (owner call, 2026-08-31):
--
--   1. Drop referral_forward from the column DEFAULT so NEW clients no longer
--      opt into referral emails out of the box.
--   2. Strip referral_forward from EXISTING clients' auto_notify_classes arrays
--      (migration 00025 seeded the 4-class default, so existing rows carry it).
--
-- Belt-and-suspenders: src/lib/replies/pipeline.ts also gates the client email
-- on HOT_REPLY_CLASSES (which no longer contains referral_forward), so a stale
-- array can't leak a referral email even before this runs. This migration makes
-- the stored data honest and fixes the default.
--
-- Idempotent: re-running is a no-op (array_remove on an absent element does
-- nothing; the DEFAULT is set to a fixed literal).

ALTER TABLE clients
  ALTER COLUMN auto_notify_classes
  SET DEFAULT '{true_interest, meeting_booked, qualifying_question}';

UPDATE clients
SET auto_notify_classes = array_remove(auto_notify_classes, 'referral_forward')
WHERE 'referral_forward' = ANY(auto_notify_classes);
