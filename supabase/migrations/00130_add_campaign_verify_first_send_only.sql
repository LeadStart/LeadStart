-- 00130_add_campaign_verify_first_send_only.sql
-- Scope flag for the per-campaign Million Verifier send gate (see 00129).
--
-- verify_before_send is the master on/off. When it's on, this flag narrows the
-- gate to the FIRST touch only: step 0 is verified as usual, but follow-ups send
-- without re-verifying. Two use cases: keep credit spend to one check per
-- contact, and never hold/skip a lead mid-sequence over a follow-up re-check
-- (e.g. a cached result that expired after 30 days). Resolution the send path
-- applies (run-native-sequences dispatchEmail):
--   verify_before_send = false                         -> gate off (all sends)
--   verify_before_send = true,  first_send_only = true -> gate on step 0 only
--   verify_before_send = true,  first_send_only = false-> gate on every send
--
-- Additive + NOT NULL DEFAULT false + idempotent: every existing campaign keeps
-- verifying every send (the false default = "not first-only"), so this is inert
-- until a campaign is switched to first-send-only. NOTE: run-native-sequences
-- SELECTs this column, so apply this migration BEFORE deploying the code that
-- reads it (a missing column aborts the send tick).

alter table public.campaigns
  add column if not exists verify_first_send_only boolean not null default false;

comment on column public.campaigns.verify_first_send_only is
  'Million Verifier send-gate scope (migration 00130): when verify_before_send is true AND this is true, the just-in-time gate runs on the first touch (step 0) only and follow-ups send without re-verifying. Ignored when verify_before_send is false. Default false = verify every send. Configurable from the campaign''s Deliverability tab.';
