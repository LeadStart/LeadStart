// Loads the Workspace admin-subject clients from an org's stored Google
// credentials (migration 00096). Mirrors src/lib/gmail/org.ts — the credential
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
  directory: DirectoryClient;
  siteVerification: SiteVerificationClient;
  licensing: LicensingClient;
  /** Configured license SKU, or null when the tenant auto-licenses (skip the step). */
  licensingDefaults: { productId: string; skuId: string } | null;
}

export async function loadWorkspaceAdminForOrg(
  admin: AdminClient,
  organizationId: string,
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
  if (!o.google_admin_email) {
    throw new GoogleConfigError(
      "No Google admin email is set. Add a Workspace super-admin in Settings, Integrations — the Directory API impersonates an admin, not a mailbox.",
    );
  }

  const sa = new GoogleServiceAccount(
    o.gmail_service_account_email,
    o.gmail_service_account_key,
  );
  const adminEmail = o.google_admin_email;

  return {
    sa,
    adminEmail,
    directory: new DirectoryClient(sa, adminEmail),
    siteVerification: new SiteVerificationClient(sa, adminEmail),
    licensing: new LicensingClient(sa, adminEmail),
    licensingDefaults:
      o.google_license_product_id && o.google_license_sku_id
        ? { productId: o.google_license_product_id, skuId: o.google_license_sku_id }
        : null,
  };
}
