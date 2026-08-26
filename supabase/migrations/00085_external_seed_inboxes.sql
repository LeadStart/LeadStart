-- =============================================
-- Migration 00085: External seed inboxes — provider expansion + credentials
--
-- Extends the 00068 placement rig beyond Workspace/DWD. Three providers:
--   google_workspace  — unchanged: org-level SA + DWD reads (auth stays NULL)
--   microsoft_graph   — per-seed OAuth refresh token (Graph Mail.Read);
--                       Microsoft basic auth dies 2026-04-30, so OAuth only
--   imap              — app-password IMAP (Yahoo, consumer Gmail, generic).
--                       Consumer Gmail deliberately rides IMAP, NOT OAuth:
--                       gmail.readonly is a restricted scope — unverified
--                       production apps are blocked, verification is an annual
--                       CASA assessment, and testing-mode refresh tokens die
--                       in 7 days (weekly reconnect = broken automation).
--
-- Seeds remain READ-ONLY receivers: never mark read, never move, never reply.
-- (Numbered 00085: 00081-00084 were claimed by the deliverability-infrastructure
-- initiative the same day. The seed_inboxes provider CHECK below is unrelated to
-- 00081's widened native_mailboxes_provider_check.)
-- Apply by hand (scripts/supabase-sql.mjs --file) to project exedxjrifprqgftyuroc.
-- =============================================

SET search_path TO public;

-- 1) Provider vocabulary (00068 reserved these; no 'google_oauth' — see header).
ALTER TABLE seed_inboxes DROP CONSTRAINT seed_inboxes_provider_check;
ALTER TABLE seed_inboxes ADD CONSTRAINT seed_inboxes_provider_check
  CHECK (provider IN ('google_workspace', 'microsoft_graph', 'imap'));

-- 2) Per-seed credentials, plaintext per the 00056 stance (the Gmail SA PEM
-- already lives that way on organizations). Shape by provider:
--   microsoft_graph: { "refresh_token": "...", "connected_at": "<iso>" }
--                    (rotated refresh tokens are written back on every refresh)
--   imap:            { "host": "...", "port": 993, "username": "...", "password": "..." }
--   google_workspace: NULL — reads use the org-level DWD service account.
ALTER TABLE seed_inboxes ADD COLUMN auth JSONB;

-- 3) Rotation roles: one long-lived 'veteran' + one quarterly-rotated 'fresh'
-- per provider. NULL = untracked (imported sending mailboxes). Age is
-- now() - created_at — rotation always creates a NEW row, so no extra
-- provisioned_at column is needed.
ALTER TABLE seed_inboxes ADD COLUMN role TEXT
  CHECK (role IN ('veteran', 'fresh'));

-- 4) Column-level hardening: seed tokens must never reach a browser session.
-- RLS cannot hide a column, so revoke table-wide SELECT from the client roles
-- and grant back everything EXCEPT auth. Server code (API routes, runner,
-- cron) uses the service-role client and is unaffected. CAVEAT: any future
-- BROWSER-side supabase select on seed_inboxes that includes auth fails with
-- 42501 — none exists today (the UI goes through GET /api/admin/seed-inboxes).
REVOKE SELECT ON seed_inboxes FROM authenticated, anon;
GRANT SELECT (id, organization_id, email_address, label, provider, role,
              status, last_error, last_error_at, created_at, updated_at)
  ON seed_inboxes TO authenticated;

-- 5) Microsoft OAuth app (org-level app credentials; the per-seed refresh
-- token lives on the seed row). Same trust boundary as the other org keys.
-- NOTE: like every org secret, these are visible to the admin browser via the
-- settings page's select("*") — accepted house pattern (00056).
ALTER TABLE organizations ADD COLUMN ms_oauth_client_id TEXT;
ALTER TABLE organizations ADD COLUMN ms_oauth_client_secret TEXT;

COMMENT ON COLUMN seed_inboxes.auth IS
  'Per-seed read credentials (plaintext, house stance 00056). microsoft_graph: {refresh_token, connected_at}; imap: {host, port, username, password}; NULL for google_workspace. Never served to browsers (column grant + API strips it).';
COMMENT ON COLUMN seed_inboxes.role IS
  'Seed rotation role: veteran = long-lived reputation reference; fresh = rotated quarterly (UI nudges at >90 days). NULL = untracked.';
COMMENT ON COLUMN organizations.ms_oauth_client_id IS
  'Entra app registration (multi-tenant + personal accounts) used by the seed-inbox Microsoft connect flow. Client secrets expire (max 24 months) — reconnects fail with AADSTS7000222 when stale.';
