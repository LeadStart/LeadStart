-- A campaign's saved reply for its hot leads (owner request 2026-09-29).
--
-- When a lead from this campaign replies, the admin inbox's reply box starts
-- with this text. The owner writes it once per campaign; {{tokens}} fill in per
-- lead from the lead's contact, the same way campaign emails fill them. For TuBe
-- campaigns, {{report_link}} is that prospect's own report link
-- (contacts.custom_fields.report_link): a PDF attached to a reply landed in spam
-- on 2026-09-29, so hot leads get the link instead.
--
-- Nothing is generated: the words are the owner's; a person reads the filled-in
-- reply before sending it. NULL = the reply box starts empty (with the signature).

ALTER TABLE public.campaigns
  ADD COLUMN IF NOT EXISTS reply_template TEXT;

COMMENT ON COLUMN public.campaigns.reply_template IS
  'Owner-written saved reply for this campaign''s hot leads; {{tokens}} fill per lead (e.g. {{report_link}}). Pre-fills the admin inbox reply box. NULL = none.';
