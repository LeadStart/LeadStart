-- =============================================
-- Migration 00058: per-campaign send window (native email)
--
-- The native email sender (run-native-sequences) currently gates every send
-- on one hardcoded window — Mon–Fri 8am–5pm America/New_York (src/lib/gmail/
-- ramp.ts SEND_WINDOW). That's wrong the moment two campaigns want different
-- hours or timezones: a Pacific operator sending on the ET window lands mail
-- at 5am–2pm local.
--
-- These four nullable columns let each campaign override the window. NULL on
-- any column means "use the global default" (so existing campaigns and other
-- channels are unchanged), and the worker resolves a full window per campaign
-- from whatever is set. Kept as plain columns (not JSONB) because the shape is
-- fixed and small, and the worker reads them every tick.
--
--   send_timezone      IANA tz, e.g. 'America/Los_Angeles'  (default ET)
--   send_start_hour    0–23 inclusive, first hour sends may fire (default 8)
--   send_end_hour      1–24 exclusive, sends stop before this hour (default 17)
--   send_weekdays_only true = Mon–Fri only (default true)
-- =============================================

SET search_path TO public;

ALTER TABLE campaigns
  ADD COLUMN IF NOT EXISTS send_timezone TEXT,
  ADD COLUMN IF NOT EXISTS send_start_hour INT,
  ADD COLUMN IF NOT EXISTS send_end_hour INT,
  ADD COLUMN IF NOT EXISTS send_weekdays_only BOOLEAN;

ALTER TABLE campaigns
  ADD CONSTRAINT campaigns_send_hours_valid CHECK (
    (send_start_hour IS NULL OR (send_start_hour >= 0 AND send_start_hour <= 23))
    AND (send_end_hour IS NULL OR (send_end_hour >= 1 AND send_end_hour <= 24))
    AND (send_start_hour IS NULL OR send_end_hour IS NULL OR send_start_hour < send_end_hour)
  );
