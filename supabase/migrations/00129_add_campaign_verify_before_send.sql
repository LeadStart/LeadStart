-- 00129_add_campaign_verify_before_send.sql
-- Per-campaign toggle for the just-in-time Million Verifier send gate.
--
-- The send gate (src/lib/millionverifier/verify-contact.ts, invoked from
-- run-native-sequences) verifies each recipient right before its first send:
-- invalid/disposable are skipped, catch-all/unknown send flagged risky, and a
-- verifier outage HOLDS (fail-closed). It is armed org-wide whenever a Million
-- Verifier key is configured. This column lets an owner opt an individual
-- campaign OUT of that send-time gate (e.g. a list already verified upstream, or
-- a campaign where the credit spend isn't wanted): when false, the sender passes
-- the campaign's contacts through UNVERIFIED, exactly like the no-key case.
--
-- Additive + NOT NULL DEFAULT true + idempotent: every existing campaign keeps
-- verifying, so this is inert until a campaign is explicitly turned off. NOTE:
-- run-native-sequences SELECTs this column, so apply this migration BEFORE
-- deploying the code that reads it (a missing column aborts the send tick).

alter table public.campaigns
  add column if not exists verify_before_send boolean not null default true;

comment on column public.campaigns.verify_before_send is
  'Pre-send email verification gate (migration 00129): when true (default), run-native-sequences verifies each recipient just-in-time via Million Verifier before the first send; when false, this campaign''s sends skip the send-time gate and go out unverified. Only has effect while a Million Verifier key is configured. Read per campaign by the native send path; configurable from the campaign''s Deliverability tab.';
