import { NextResponse } from "next/server";
import type { User, SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

// Resolve the org's Apify token (with env fallback for local dev). Mirrors the
// scrapio/decision-maker key resolution.
export async function loadApifyToken(
  admin: SupabaseClient,
  organizationId: string,
): Promise<string | null> {
  const { data: org } = await admin
    .from("organizations")
    .select("apify_api_key")
    .eq("id", organizationId)
    .maybeSingle();
  const key =
    (org as { apify_api_key: string | null } | null)?.apify_api_key ||
    process.env.APIFY_API_TOKEN ||
    "";
  return key || null;
}

// Shared gate for the Contacts → Enrich API routes. Same shape as
// requireDecisionMakerContext (401 no user, 403 unless owner/va, 400 no org),
// but does NOT 400 on a missing key — the start route decides whether the
// requested phases need one, and the read routes need none.
export async function requireEnrichmentContext(): Promise<
  | { error: NextResponse }
  | {
      user: User;
      organizationId: string;
      admin: SupabaseClient;
      apifyToken: string | null;
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
      error: NextResponse.json({ error: "Owner or VA role required" }, { status: 403 }),
    };
  }

  const organizationId = user.app_metadata?.organization_id as string | undefined;
  if (!organizationId) {
    return {
      error: NextResponse.json({ error: "No organization on user" }, { status: 400 }),
    };
  }

  const admin = createAdminClient();
  const apifyToken = await loadApifyToken(admin, organizationId);

  return { user, organizationId, admin, apifyToken };
}
