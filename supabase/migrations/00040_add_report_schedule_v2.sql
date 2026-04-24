-- Fixed day/time report schedule — supersedes the elapsed-time schedule
-- (report_interval_days / report_schedule_start). Old columns are retained for
-- back-compat during migration; cron logic reads the new columns.

ALTER TABLE public.clients
  ADD COLUMN report_frequency TEXT CHECK (report_frequency IN ('weekly', 'biweekly', 'monthly')),
  ADD COLUMN report_day_of_week SMALLINT CHECK (report_day_of_week BETWEEN 0 AND 6),
  ADD COLUMN report_day_of_month SMALLINT CHECK (report_day_of_month BETWEEN 1 AND 28 OR report_day_of_month = -1),
  ADD COLUMN report_time_of_day TEXT,
  ADD COLUMN report_timezone TEXT;

-- Backfill existing schedules so nothing breaks after deploy. Historical
-- cadence was "weekly on Friday" for most clients; 10:00 ET is close to the
-- old 15:00 UTC (11 AM EDT / 10 AM EST).
UPDATE public.clients
SET
  report_frequency = CASE
    WHEN report_interval_days = 7 THEN 'weekly'
    WHEN report_interval_days = 14 THEN 'biweekly'
    WHEN report_interval_days = 30 THEN 'monthly'
    ELSE NULL
  END,
  report_day_of_week = CASE
    WHEN report_interval_days IN (7, 14) THEN 5
    ELSE NULL
  END,
  report_day_of_month = CASE
    WHEN report_interval_days = 30 THEN 1
    ELSE NULL
  END,
  report_time_of_day = '10:00',
  report_timezone = 'America/New_York'
WHERE report_interval_days IS NOT NULL
  AND report_frequency IS NULL;

COMMENT ON COLUMN public.clients.report_frequency IS 'Report cadence: weekly | biweekly | monthly. NULL = no auto-send.';
COMMENT ON COLUMN public.clients.report_day_of_week IS 'Day of week for weekly/biweekly (0=Sunday, 6=Saturday).';
COMMENT ON COLUMN public.clients.report_day_of_month IS 'Day of month for monthly (1-28), or -1 for last day.';
COMMENT ON COLUMN public.clients.report_time_of_day IS 'Local time in HH:MM (24h) — evaluated in report_timezone.';
COMMENT ON COLUMN public.clients.report_timezone IS 'IANA timezone (e.g., America/New_York). Handles DST automatically.';
