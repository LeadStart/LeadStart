import { NextResponse } from "next/server";
import type { User, SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

// Shared gate for every Decision-Maker enrichment API route. Validates the
// request is from a logged-in owner/VA, resolves the org's Anthropic +
// (optional) Perplexity keys with env-var fallback, and hands back a
// ready-to-use admin DB client.
//
// Mirrors requireProspectingContext (src/lib/scrapio/auth.ts) — same
// discriminated-union return shape so callers can do:
//
//   const ctx = await requireDecisionMakerContext();
//   if ("error" in ctx) return ctx.error;
//   const { anthropicKey, perplexityKey, organizationId, admin, user } = ctx;
//
// Anthropic is required (400 if missing); Perplexity is optional and
// returned as null when not configured. Routes that need Layer 2 should
// check perplexityKey themselves and decide whether to fall back to
// Claude's built-in web_search tool.

export async function requireDecisionMakerContext(): Promise<
  | { error: NextResponse }
  | {
      user: User;
      organizationId: string;
      anthropicKey: string;
      perplexityKey: string | null;
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
    .select("anthropic_api_key, perplexity_api_key")
    .eq("id", organizationId)
    .maybeSingle();

  const orgKeys = org as
    | { anthropic_api_key: string | null; perplexity_api_key: string | null }
    | null;

  const anthropicKey =
    orgKeys?.anthropic_api_key || process.env.ANTHROPIC_API_KEY || "";
  const perplexityKey =
    orgKeys?.perplexity_api_key || process.env.PERPLEXITY_API_KEY || null;

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
    perplexityKey: perplexityKey || null,
    admin,
  };
}
