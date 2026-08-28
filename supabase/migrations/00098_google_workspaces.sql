-- =============================================
-- Migration 00098: Multiple Google Workspaces per org
--
-- Until now an org provisioned inboxes into ONE Workspace (the single
-- organizations.google_admin_email). This lets an org hold several labeled
-- Workspace tenants and choose which one a domain's inboxes go into.
--
-- The SAME service account (organizations.gmail_service_account_*) is authorized
-- on each Workspace via domain-wide delegation; what differs per Workspace is the
-- super-admin subject the Admin SDK / Site Verification / Licensing APIs
-- impersonate (admin_email) and its optional license SKU. Adding a Workspace in
-- LeadStart still requires that tenant's admin to authorize the SA's client ID
-- (the DWD step in docs/native-email-runbook.md §2a).
--
-- Admin-client-only, like sending_domains / native_mailboxes — no RLS (clients
-- never read it; the service role is the only accessor). Apply by hand in the
-- Supabase SQL editor (project exedxjrifprqgftyuroc). Additive + idempotent.
-- =============================================

SET search_path TO public;

-- 1) A labeled Workspace tenant the org can provision into.
CREATE TABLE IF NOT EXISTS google_workspaces (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  label TEXT NOT NULL,                     -- friendly name shown in the picker
  admin_email TEXT NOT NULL,               -- Workspace super-admin to impersonate
  license_product_id TEXT,                 -- optional; NULL = tenant auto-licenses
  license_sku_id TEXT,
  is_default BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, admin_email)
);
CREATE INDEX IF NOT EXISTS idx_google_workspaces_org ON google_workspaces (organization_id);

DROP TRIGGER IF EXISTS set_updated_at ON google_workspaces;
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON google_workspaces
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- 2) Which Workspace a domain provisions into (NULL = the org's default).
ALTER TABLE sending_domains
  ADD COLUMN IF NOT EXISTS workspace_id UUID REFERENCES google_workspaces(id) ON DELETE SET NULL;

-- 3) Backfill a default Workspace from the org's existing single admin email, so
-- everything already configured keeps working with zero change.
INSERT INTO google_workspaces (organization_id, label, admin_email, license_product_id, license_sku_id, is_default)
SELECT id, 'Main', google_admin_email, google_license_product_id, google_license_sku_id, true
FROM organizations
WHERE google_admin_email IS NOT NULL
ON CONFLICT (organization_id, admin_email) DO NOTHING;

COMMENT ON TABLE google_workspaces IS
  'Labeled Google Workspace tenants an org can provision inboxes into. Same service account (DWD) across all; admin_email is the per-tenant super-admin the Admin SDK impersonates. sending_domains.workspace_id picks which one (NULL = default).';
