import { NextResponse } from "next/server";
import type { User, SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  DEFAULT_ENRICHMENT_SETTINGS,
  ENRICHMENT_WATERFALL_METHODS,
  type EnrichmentSettings,
  type EnrichmentWaterfallMethod,
} from "@/types/app";

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

// Coerce an arbitrary stored/posted blob into a complete, valid EnrichmentSettings
// by merging over `base` (defaults). Unknown/malformed keys fall back rather than
// throw, so a partial PATCH or a shape from an older/newer app version is safe.
export function normalizeEnrichmentSettings(
  input: unknown,
  base: EnrichmentSettings = DEFAULT_ENRICHMENT_SETTINGS,
): EnrichmentSettings {
  const o = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const bool = (v: unknown, fb: boolean): boolean => (typeof v === "boolean" ? v : fb);
  const intClamp = (v: unknown, fb: number, min: number, max: number): number => {
    const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
    if (!Number.isFinite(n)) return fb;
    return Math.min(max, Math.max(min, Math.round(n)));
  };
  const method = (v: unknown, fb: EnrichmentWaterfallMethod): EnrichmentWaterfallMethod =>
    typeof v === "string" && (ENRICHMENT_WATERFALL_METHODS as readonly string[]).includes(v)
      ? (v as EnrichmentWaterfallMethod)
      : fb;
  return {
    waterfall_enabled: bool(o.waterfall_enabled, base.waterfall_enabled),
    size_threshold: intClamp(o.size_threshold, base.size_threshold, 1, 100_000),
    small_method: method(o.small_method, base.small_method),
    large_method: method(o.large_method, base.large_method),
    unknown_method: method(o.unknown_method, base.unknown_method),
    vdrmota_max_leads: intClamp(o.vdrmota_max_leads, base.vdrmota_max_leads, 1, 10),
    accept_catch_all_guesses: bool(o.accept_catch_all_guesses, base.accept_catch_all_guesses),
    scrape_max_pages: intClamp(o.scrape_max_pages, base.scrape_max_pages, 1, 20),
  };
}

// Load an org's enrichment settings, merged over defaults. Never throws — a
// missing column (migration not applied) or missing row yields the defaults.
export async function loadEnrichmentSettings(
  admin: SupabaseClient,
  organizationId: string,
): Promise<EnrichmentSettings> {
  const { data, error } = await admin
    .from("organizations")
    .select("enrichment_settings")
    .eq("id", organizationId)
    .maybeSingle();
  if (error || !data) return { ...DEFAULT_ENRICHMENT_SETTINGS };
  return normalizeEnrichmentSettings(
    (data as { enrichment_settings?: unknown }).enrichment_settings,
  );
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
