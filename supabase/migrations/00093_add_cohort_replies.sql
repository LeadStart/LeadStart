-- 00093_add_cohort_replies.sql
--
-- Per-contact (cohort) reply rate: adds the numerator column the KPI
-- calculator needs to report reply rate as "of the contacts first emailed,
-- what share replied" instead of "replies ÷ emails sent".
--
-- campaign_snapshots is a per-DAY rollup that buckets replies by the day they
-- ARRIVED, so it cannot express cohort attribution on its own. This column
-- stores, for each snapshot_date, the count of DISTINCT contacts (deduped by
-- email across the whole campaign) whose FIRST-touch send went out on that day
-- and who have since replied at least once. Summed over any window it yields a
-- true cohort rate; summed over all days it equals total repliers ÷ total
-- contacts. Deduping by email across the campaign also fixes the cross-day
-- double-count that summing per-day unique_replies produced.
--
-- Written by the sync-analytics cron (src/app/api/cron/sync-analytics). Safe,
-- additive, backfilled to 0 — the next cron tick recomputes real values.

alter table campaign_snapshots
  add column if not exists cohort_replies integer not null default 0;

comment on column campaign_snapshots.cohort_replies is
  'Distinct contacts (deduped by email across the campaign) whose first-touch send was on snapshot_date and who have replied at least once. Numerator for the per-contact (cohort) reply rate. Written by the sync-analytics cron.';
