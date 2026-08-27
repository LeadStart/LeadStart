import { NextResponse } from "next/server";
import type { User, SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

// Shared gate for the admin manual-task (LinkedIn to-dos) API routes. Same shape
// as requireEnrichmentContext (401 no user, 403 unless owner/va, 400 no org) but
// without the Apify-token lookup those routes carry. Returns a SERVICE-ROLE admin
// client — the routes re-check organization_id on every read/write themselves.
export async function requireManualTaskContext(): Promise<
  | { error: NextResponse }
  | { user: User; organizationId: string; admin: SupabaseClient }
> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  }

  const role = user.app_metadata?.role;
  if (role !== "owner" && role !== "va") {
    return {
      error: NextResponse.json({ error: "Owner or VA role required" }, { status: 403 }),
    };
  }

  const organizationId = user.app_metadata?.organization_id as string | undefined;
  if (!organizationId) {
    return {
      error: NextResponse.json({ error: "No organization on user" }, { status: 400 }),
    };
  }

  return { user, organizationId, admin: createAdminClient() };
}
