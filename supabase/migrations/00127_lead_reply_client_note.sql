-- A free-text note the client leaves on a specific lead/reply from their inbox
-- dossier. Unlike outcome_notes (which is gated behind logging a call/email
-- disposition), this is a standalone, always-editable note that BOTH the client
-- portal and the internal admin inbox render, so the client and their LeadStart
-- team share one running note per lead.
--
-- Client-authored via POST /api/replies/[id]/note, which does a service-role
-- UPDATE after an "owning client_user OR owner/VA in org" access check, so no
-- RLS change is needed (both detail pages already SELECT their own replies).
--
-- Additive + idempotent; existing rows keep NULL (no note yet).

SET search_path TO public;

ALTER TABLE lead_replies ADD COLUMN IF NOT EXISTS client_note TEXT;
