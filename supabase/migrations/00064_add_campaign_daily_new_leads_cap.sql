-- =============================================
-- Migration 00064: per-campaign daily new-leads cap (native email)
--
-- The native email sender enrolls every imported contact as an active step-0
-- enrollment at once, so the ONLY limit on how many BRAND-NEW people start the
-- sequence each day is the inboxes' combined warmup cap. That couples new-lead
-- velocity to inbox capacity and lets a big import crowd out follow-ups.
--
-- This column caps NEW first-touches (step 0) per campaign per day, independent
-- of inbox capacity. Follow-ups (step 1+) are never limited by it. NULL means
-- "use the global default" (src/lib/gmail/ramp.ts DEFAULT_DAILY_NEW_LEADS_CAP),
-- so existing campaigns and other channels are unchanged. 0 pauses new leads
-- entirely while follow-ups keep flowing.
--
-- Mirrors the per-campaign send-window columns from migration 00058: one small
-- nullable column the worker reads every tick, resolved against a global
-- default in code.
-- =============================================

SET search_path TO public;

ALTER TABLE campaigns
  ADD COLUMN IF NOT EXISTS daily_new_leads_cap INT;

ALTER TABLE campaigns
  ADD CONSTRAINT campaigns_daily_new_leads_cap_valid CHECK (
    daily_new_leads_cap IS NULL OR daily_new_leads_cap >= 0
  );
