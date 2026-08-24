import { NextRequest, NextResponse } from "next/server";
import {
  loadEnrichmentSettings,
  normalizeEnrichmentSettings,
  requireEnrichmentContext,
} from "@/lib/apify/auth";

// GET/POST /api/admin/enrichment/settings — read + write the org's enrichment
// waterfall config (organizations.enrichment_settings, migration 00075).
//
// GET returns the stored blob merged over code defaults, so the settings card
// always renders a complete shape. POST body: { settings: Partial<...> } —
// merged over the CURRENT stored settings then clamped/validated, so a partial
// payload never wipes other keys. Same owner/VA gate as the other enrich routes.

export const maxDuration = 15;

export async function GET() {
  const ctx = await requireEnrichmentContext();
  if ("error" in ctx) return ctx.error;
  const settings = await loadEnrichmentSettings(ctx.admin, ctx.organizationId);
  return NextResponse.json({ settings });
}

export async function POST(request: NextRequest) {
  const ctx = await requireEnrichmentContext();
  if ("error" in ctx) return ctx.error;
  const { admin, organizationId } = ctx;

  const body = (await request.json().catch(() => null)) as { settings?: unknown } | null;
  if (!body || typeof body.settings !== "object" || body.settings === null) {
    return NextResponse.json({ error: "Body must be { settings: { ... } }" }, { status: 400 });
  }

  const current = await loadEnrichmentSettings(admin, organizationId);
  const next = normalizeEnrichmentSettings(body.settings, current);

  const { error } = await admin
    .from("organizations")
    .update({ enrichment_settings: next })
    .eq("id", organizationId);
  if (error) {
    // e.g. migration 00075 not applied yet — surface instead of claiming saved.
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ settings: next });
}
