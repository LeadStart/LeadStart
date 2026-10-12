import { NextResponse } from "next/server";
import type { User, SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

// Shared gate for every Decision-Maker enrichment API route. Validates the
// request is from a logged-in owner/VA, resolves the org's Anthropic key with
// env-var fallback, and hands back a ready-to-use admin DB client.
//
// Mirrors requireProspectingContext (src/lib/scrapio/auth.ts): same
// discriminated-union return shape so callers can do:
//
//   const ctx = await requireDecisionMakerContext();
//   if ("error" in ctx) return ctx.error;
//   const { anthropicKey, organizationId, admin, user } = ctx;
//
// Anthropic is required (400 if missing): it runs both layers, the Layer 1
// site read (Haiku 4.5) and the Layer 2 web search (Haiku 5.5; it replaced
// Perplexity on 2026-10-11).

export async function requireDecisionMakerContext(): Promise<
  | { error: NextResponse }
  | {
      user: User;
      organizationId: string;
      anthropicKey: string;
      admin: SupabaseClient;
    }
> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return {
      error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    };
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

  const organizationId = user.app_metadata?.organization_id as string | undefined;
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
    .select("anthropic_api_key")
    .eq("id", organizationId)
    .maybeSingle();

  const orgKeys = org as { anthropic_api_key: string | null } | null;

  const anthropicKey =
    orgKeys?.anthropic_api_key || process.env.ANTHROPIC_API_KEY || "";

  if (!anthropicKey) {
    return {
      error: NextResponse.json(
        {
          error:
            "Anthropic API key not set. Save it in /admin/settings/api first.",
        },
        { status: 400 },
      ),
    };
  }

  return {
    user,
    organizationId,
    anthropicKey,
    admin,
  };
}
