// Loads a GmailClient from an org's stored service-account credentials.
// Shared by the mailbox admin routes and the send/poll cron workers so the
// credential lookup lives in exactly one place.

import { createAdminClient } from "@/lib/supabase/admin";
import { GmailClient, GmailConfigError } from "./client";

type AdminClient = ReturnType<typeof createAdminClient>;

export async function loadGmailClientForOrg(
  admin: AdminClient,
  organizationId: string,
): Promise<GmailClient> {
  const { data } = await admin
    .from("organizations")
    .select("gmail_service_account_email, gmail_service_account_key")
    .eq("id", organizationId)
    .maybeSingle();
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
