-- Findymail API key + cached credit balance on the organization, for the
-- catch-all email validation enrichment step (a pay-on-hit finder that recovers
-- deliverable emails on catch-all domains pattern_mv + Million Verifier are blind
-- to). Purely additive + idempotent.
--
-- Security: no per-column REVOKE / grant work is needed. Migration 00096
-- role-gated the organizations SELECT policy to owner/va, so this secret column
-- is already unreadable by client-portal sessions. Server code reads it via the
-- service role (bypasses RLS). Mirrors how millionverifier_api_key is handled.
--
-- Unlike the Million Verifier gate, Findymail is NOT a send gate — a failure just
-- skips the recovery step for a run — so it needs only the key + a cached credit
-- balance for the Settings "Test connection" readout, not the error-streak /
-- suppression columns MV carries.

SET search_path TO public;

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS findymail_api_key TEXT,
  ADD COLUMN IF NOT EXISTS findymail_credits INTEGER,
  ADD COLUMN IF NOT EXISTS findymail_credits_checked_at TIMESTAMPTZ;
