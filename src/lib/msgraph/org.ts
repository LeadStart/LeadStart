// Load an org's Microsoft OAuth app credentials (migration 00085).
//
// Mirrors gmail/org.ts: reads the org's ms_oauth_client_id / _secret columns.
// Returns null (never throws) when unconfigured: the caller decides whether a
// missing app is a 400 (the connect route) or a benched seed (the reader).

import type { createAdminClient } from "@/lib/supabase/admin";
import { MsGraphClient } from "./client";

type AdminClient = ReturnType<typeof createAdminClient>;

export interface MsOauthApp {
  clientId: string;
  clientSecret: string;
}

export async function loadMsOauthAppForOrg(
  admin: AdminClient,
  organizationId: string,
): Promise<MsOauthApp | null> {
  const { data } = await admin
    .from("organizations")
    .select("ms_oauth_client_id, ms_oauth_client_secret")
    .eq("id", organizationId)
    .maybeSingle();
  const org = data as { ms_oauth_client_id: string | null; ms_oauth_client_secret: string | null } | null;
  if (!org?.ms_oauth_client_id || !org.ms_oauth_client_secret) return null;
  return { clientId: org.ms_oauth_client_id, clientSecret: org.ms_oauth_client_secret };
}

export function msGraphClientForApp(app: MsOauthApp): MsGraphClient {
  return new MsGraphClient(app.clientId, app.clientSecret);
}
