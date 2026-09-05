// Loads a GmailClient from an org's stored service-account credentials.
// Shared by the mailbox admin routes and the send/poll cron workers so the
// credential lookup lives in exactly one place.

import { createAdminClient } from "@/lib/supabase/admin";
import { GmailClient, GmailConfigError, GmailTransientError } from "./client";

type AdminClient = ReturnType<typeof createAdminClient>;

export async function loadGmailClientForOrg(
  admin: AdminClient,
  organizationId: string,
): Promise<GmailClient> {
  const { data, error } = await admin
    .from("organizations")
    .select("gmail_service_account_email, gmail_service_account_key")
    .eq("id", organizationId)
    .maybeSingle();
  // A failed READ is not "not configured": reporting it as a config error sent
  // the owner hunting in Settings for a key that was there all along
  // (SEND_RUNTIME_AUDIT.md SEND-31). Transient so the callers retry next tick.
  if (error) {
    throw new GmailTransientError(`Could not read the org's Gmail credentials: ${error.message}`);
  }
  const org = data as {
    gmail_service_account_email: string | null;
    gmail_service_account_key: string | null;
  } | null;
  if (!org?.gmail_service_account_email || !org.gmail_service_account_key) {
    throw new GmailConfigError(
      "Native email is not configured: add a Google service account under Settings → Integrations.",
    );
  }
  return new GmailClient(
    org.gmail_service_account_email,
    org.gmail_service_account_key,
  );
}
