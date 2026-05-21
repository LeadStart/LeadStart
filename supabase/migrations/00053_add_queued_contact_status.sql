-- =============================================
-- Migration 00053: Add 'queued' value to contact_status enum
--
-- Earlier flow used 'uploaded' as soon as a contact was queued for
-- Salesforge enrollment, which is a lie — at queue time the contact
-- only has a row in salesforge_enrollment_queue with status='pending';
-- the dispatcher hasn't actually pushed it to Salesforge yet.
--
-- New lifecycle:
--   new        — local row, not assigned to any campaign or pending push
--   queued     — has a pending salesforge_enrollment_queue row, waiting
--                for the daily 5am Pacific dispatcher cron
--   uploaded   — dispatcher pushed to Salesforge workspace + sequence
--   active     — sequence actively sending (set by analytics sync once
--                we see real send activity)
--   replied    — inbound reply received
--   bounced / unsubscribed — terminal lifecycle states
--
-- Wired by:
--   - /api/admin/contacts/push-to-campaign: sets status='queued' on
--     contacts whose enrollment queue rows it just created
--   - /api/cron/dispatch-salesforge-enrollments: already flips to
--     'uploaded' on successful push (unchanged)
-- =============================================

SET search_path TO public;

-- Postgres 12+ allows ALTER TYPE ... ADD VALUE inside a transaction.
-- The new value cannot be referenced in the same transaction, but no
-- subsequent statement in this migration references 'queued' so it's
-- safe.
ALTER TYPE contact_status ADD VALUE IF NOT EXISTS 'queued';
