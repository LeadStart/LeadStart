// Loads the Workspace admin-subject clients from an org's stored Google
// credentials (migration 00097). Mirrors src/lib/gmail/org.ts: the credential
// lookup lives in one place, shared by the provisioning route + cron.
//
// Auth model: the SAME service account that sends Gmail (DWD) is used, but the
// Admin SDK / Site Verification / Licensing APIs require a super-admin subject
// (google_admin_email) rather than a mailbox. The org's admin authorizes the
// added scopes on the same client ID once (see docs/native-email-runbook.md).

import type { createAdminClient } from "@/lib/supabase/admin";
import { GoogleServiceAccount, GoogleConfigError } from "./auth";
import { DirectoryClient } from "./directory";
import { SiteVerificationClient } from "./site-verification";
import { LicensingClient } from "./licensing";

type AdminClient = ReturnType<typeof createAdminClient>;

export interface WorkspaceAdminClients {
  sa: GoogleServiceAccount;
  adminEmail: string;
  /** The google_workspaces row used, or null when falling back to the org's admin email. */
  workspaceId: string | null;
  directory: DirectoryClient;
  siteVerification: SiteVerificationClient;
  licensing: LicensingClient;
  /** Configured license SKU, or null when the tenant auto-licenses (skip the step). */
  licensingDefaults: { productId: string; skuId: string } | null;
}

/**
 * Build the Workspace admin-subject clients for an org, targeting a specific
 * Workspace when given (migration 00098). Resolution order:
 *   opts.workspaceId → that google_workspaces row;
 *   else the org's default (is_default, then oldest) Workspace row;
 *   else the legacy single organizations.google_admin_email (pre-multi fallback).
 * The service account (organizations.gmail_service_account_*) is shared across
 * every Workspace; only the impersonated admin_email + license SKU differ.
 */
export async function loadWorkspaceAdminForOrg(
  admin: AdminClient,
  organizationId: string,
  opts?: { workspaceId?: string | null },
): Promise<WorkspaceAdminClients> {
  const { data } = await admin
    .from("organizations")
    .select(
      "gmail_service_account_email, gmail_service_account_key, google_admin_email, google_license_product_id, google_license_sku_id",
    )
    .eq("id", organizationId)
    .maybeSingle();

  const o = (data ?? {}) as {
    gmail_service_account_email?: string | null;
    gmail_service_account_key?: string | null;
    google_admin_email?: string | null;
    google_license_product_id?: string | null;
    google_license_sku_id?: string | null;
  };

  if (!o.gmail_service_account_email || !o.gmail_service_account_key) {
    throw new GoogleConfigError(
      "Google service account is not configured. Add the service-account email + key in Settings, Integrations.",
    );
  }

  // Resolve which Workspace tenant to impersonate.
  type WsRow = {
    id: string;
    admin_email: string;
    license_product_id: string | null;
    license_sku_id: string | null;
  };
  let ws: WsRow | null = null;
  if (opts?.workspaceId) {
    const { data: wsData } = await admin
      .from("google_workspaces")
      .select("id, admin_email, license_product_id, license_sku_id")
      .eq("id", opts.workspaceId)
      .eq("organization_id", organizationId)
      .maybeSingle();
    if (!wsData) {
      throw new GoogleConfigError("That Workspace was not found for this organization.");
    }
    ws = wsData as WsRow;
  } else {
    const { data: wsData } = await admin
      .from("google_workspaces")
      .select("id, admin_email, license_product_id, license_sku_id")
      .eq("organization_id", organizationId)
      .order("is_default", { ascending: false })
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    ws = (wsData as WsRow) ?? null;
  }

  const adminEmail = ws?.admin_email ?? o.google_admin_email ?? null;
  const licenseProduct = ws?.license_product_id ?? o.google_license_product_id ?? null;
  const licenseSku = ws?.license_sku_id ?? o.google_license_sku_id ?? null;
  if (!adminEmail) {
    throw new GoogleConfigError(
      "No Google Workspace is configured. Add one (its super-admin email) in Settings, Integrations: the Directory API impersonates an admin, not a mailbox.",
    );
  }

  const sa = new GoogleServiceAccount(
    o.gmail_service_account_email,
    o.gmail_service_account_key,
  );

  return {
    sa,
    adminEmail,
    workspaceId: ws?.id ?? null,
    directory: new DirectoryClient(sa, adminEmail),
    siteVerification: new SiteVerificationClient(sa, adminEmail),
    licensing: new LicensingClient(sa, adminEmail),
    licensingDefaults:
      licenseProduct && licenseSku
        ? { productId: licenseProduct, skuId: licenseSku }
        : null,
  };
}
