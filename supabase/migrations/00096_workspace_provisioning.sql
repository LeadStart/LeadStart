-- =============================================
-- Migration 00096: Google Workspace provisioning (Phase 3)
--
-- Adds the columns the automated domain + inbox provisioning flow needs
-- (docs/plans/deliverability-infrastructure-plan.md, Phase 3), plus a one-time
-- repair of a latent bug from 00081.
--
--   organizations.google_admin_email        — the Workspace super-admin the
--                                              service account impersonates for
--                                              the Admin SDK / Site Verification /
--                                              Licensing APIs (Gmail sends
--                                              impersonate the mailbox itself; the
--                                              Directory API requires an admin
--                                              subject, which Gmail sending does not)
--   organizations.google_license_product_id — optional Workspace license SKU. When
--   organizations.google_license_sku_id        both are NULL the licensing step is
--                                              skipped (the tenant auto-licenses new
--                                              users, the common default).
--   sending_domains.provisioning             — the multi-step provisioning state
--                                              machine (shape: ProvisioningState in
--                                              src/types/app.ts). NULL for domains
--                                              not in the workspace flow.
--
-- BUG REPAIR (§3): POST /api/admin/mailboxes never set native_mailboxes.domain_id,
-- so every mailbox added by hand since 00081 has a NULL domain_id and is invisible
-- to manage-mailbox-lifecycle, the domain health rollup, and the drain filter. The
-- same idempotent backfill from 00081 §3 re-links them. (The app route is also
-- fixed to set domain_id going forward; this catches the rows already created.)
--
-- All additive + idempotent. Apply by hand in the Supabase SQL editor
-- (project exedxjrifprqgftyuroc). No RLS changes: sending_domains + organizations
-- policies from 00081 / earlier already cover the new columns.
-- =============================================

SET search_path TO public;

-- 1) Workspace admin subject + optional licensing SKU.
ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS google_admin_email TEXT,
  ADD COLUMN IF NOT EXISTS google_license_product_id TEXT,
  ADD COLUMN IF NOT EXISTS google_license_sku_id TEXT;

-- 2) Multi-step provisioning state on the domain.
ALTER TABLE sending_domains
  ADD COLUMN IF NOT EXISTS provisioning JSONB;

-- 3) Re-run the 00081 §3 mailbox→domain backfill for rows the app route missed.
-- Both statements are idempotent: the INSERT skips existing (org, domain) rows,
-- the UPDATE fills only NULL domain_id. Harmless to run when everything is
-- already linked. split_part(email,'@',2) + lower() matches domainOf() in
-- src/lib/deliverability/check.ts.
INSERT INTO sending_domains (organization_id, domain, tier, lifecycle_status, registrar)
SELECT DISTINCT
  m.organization_id,
  lower(split_part(m.email_address, '@', 2)),
  'gmail',
  'active',
  'manual'
FROM native_mailboxes m
WHERE m.email_address LIKE '%@%'
ON CONFLICT (organization_id, domain) DO NOTHING;

UPDATE native_mailboxes m
SET domain_id = d.id
FROM sending_domains d
WHERE d.organization_id = m.organization_id
  AND d.domain = lower(split_part(m.email_address, '@', 2))
  AND m.domain_id IS NULL;

COMMENT ON COLUMN organizations.google_admin_email IS
  'Workspace super-admin the service account impersonates for the Admin SDK / Site Verification / Licensing APIs (domain + inbox provisioning). Gmail sends impersonate the mailbox itself and do not need this.';
COMMENT ON COLUMN sending_domains.provisioning IS
  'Multi-step Google Workspace provisioning state machine (ProvisioningState in src/types/app.ts). NULL for domains not in the workspace flow. Advanced by the advance-domain-provisioning cron + the Check-now route.';
