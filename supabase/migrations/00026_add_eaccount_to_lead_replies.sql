-- =============================================
-- Migration: add eaccount column to lead_replies
-- The hosted Instantly mailbox that received the prospect's reply.
-- Passed back to POST /api/v2/emails/reply as the sending account.
-- Instantly's Email object has this as a first-class field; we store it
-- explicitly rather than inferring from to_address_email_list[0].
-- =============================================

ALTER TABLE public.lead_replies
  ADD COLUMN IF NOT EXISTS eaccount TEXT;

-- Useful for admin views that slice by hosted mailbox ("which inbox is
-- getting the most hot replies?"). Partial because most queries filter
-- on non-null eaccount.
CREATE INDEX IF NOT EXISTS idx_lead_replies_eaccount
  ON public.lead_replies(client_id, eaccount)
  WHERE eaccount IS NOT NULL;
