-- Allow clients to CC additional teammates on hot-lead notifications and on
-- portal reply sends. `notification_email` stays the primary recipient /
-- CC target; this array holds extra addresses the client wants kept in the
-- loop. Empty array (not NULL) so callers can concat without null-checks.
ALTER TABLE public.clients
  ADD COLUMN notification_cc_emails TEXT[] NOT NULL DEFAULT '{}'::TEXT[];
