-- Who a reply sent from LeadStart actually went to. Since 2026-11-06 an owner or
-- VA replying for a client from the admin Inbox can change To / Cc / Bcc (the
-- client's own copy, BCC'd by default, included), so the sent line can no
-- longer be worked out from the client's notification settings. The send route
-- (POST /api/replies/[id]/send) records the real lists on the same atomic
-- claim that marks the row sent, and clears them if the send fails.
--
-- Additive + idempotent; replies sent before this keep NULL (not recorded), and
-- the Inbox and portal fall back to their old wording for those.

SET search_path TO public;

ALTER TABLE lead_replies
  ADD COLUMN IF NOT EXISTS sent_to TEXT[],
  ADD COLUMN IF NOT EXISTS sent_cc TEXT[],
  ADD COLUMN IF NOT EXISTS sent_bcc TEXT[];
