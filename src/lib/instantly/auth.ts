import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import type { User } from "@supabase/supabase-js";
import type { SupabaseClient } from "@supabase/supabase-js";

// Shared gate for every Instantly channel API route. Validates the request
// is from a logged-in owner/VA, resolves the org's Instantly API key (with
// env-var fallback for local dev), and hands back a ready-to-use admin DB
// client. Mirrors src/lib/scrapio/auth.ts.
//
// Returns `{ error }` (a NextResponse to short-circuit with) or the full
// context object. Pattern lets the caller do:
//
//   const ctx = await requireInstantlyContext();
//   if ("error" in ctx) return ctx.error;
//   const { apiKey, organizationId, admin, user } = ctx;
export async function requireInstantlyContext(): Promise<
  | { error: NextResponse }
  | {
      user: User;
      organizationId: string;
      apiKey: string;
      admin: SupabaseClient;
    }
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
      error: NextResponse.json(
        { error: "Owner or VA role required" },
        { status: 403 },
      ),
    };
  }
  const organizationId = user.app_metadata?.organization_id as
    | string
    | undefined;
  if (!organizationId) {
    return {
      error: NextResponse.json(
        { error: "No organization on user" },
        { status: 400 },
      ),
    };
  }

  const admin = createAdminClient();
  const { data: org } = await admin
    .from("organizations")
    .select("instantly_api_key")
    .eq("id", organizationId)
    .maybeSingle();
  const apiKey =
    (org as { instantly_api_key: string | null } | null)?.instantly_api_key ||
    process.env.INSTANTLY_API_KEY ||
    "";
  if (!apiKey) {
    return {
      error: NextResponse.json(
        {
          error:
            "Instantly API key not set. Save it in /admin/settings/api first.",
        },
        { status: 400 },
      ),
    };
  }

  return { user, organizationId, apiKey, admin };
}
