-- Add report schedule columns to clients table
ALTER TABLE public.clients
  ADD COLUMN report_interval_days INT,
  ADD COLUMN report_schedule_start DATE,
  ADD COLUMN report_last_sent_at TIMESTAMPTZ,
  ADD COLUMN report_recipients TEXT[];

-- report_interval_days: how many days between auto-sends (7, 14, 30, etc.)
-- report_schedule_start: anchor date for the schedule
-- report_last_sent_at: when the cron last sent a report for this client
-- report_recipients: saved email addresses for auto-sends
