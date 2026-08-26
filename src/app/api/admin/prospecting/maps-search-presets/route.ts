// Saved Google Maps search presets — list (org + global) + save (upsert by name).
// Owner/VA only, org-scoped writes. Global (org-NULL) presets are read-only here
// (the future landing-page tier, seeded by service role). Mirrors search-presets.

import { NextRequest, NextResponse } from "next/server";
import { createClient as createServerClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

async function context() {
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  const role = user.app_metadata?.role;
  const organizationId = user.app_metadata?.organization_id as string | undefined;
  if (!organizationId || (role !== "owner" && role !== "va")) {
    return { error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
  }
  return { user, organizationId, admin: createAdminClient() };
}

// (Not exported: App Router route modules may only export handlers/config.)
function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

export async function GET() {
  const ctx = await context();
  if ("error" in ctx) return ctx.error;
  // Org presets + global (org-NULL) presets.
  const { data, error } = await ctx.admin
    .from("maps_search_presets")
    .select("id, organization_id, name, slug, description, config, created_at")
    .or(`organization_id.eq.${ctx.organizationId},organization_id.is.null`)
    .eq("kind", "google_maps")
    .order("created_at", { ascending: false });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  const presets = ((data ?? []) as { organization_id: string | null }[]).map((p) => ({
    ...p,
    is_global: p.organization_id === null,
  }));
  return NextResponse.json({ presets });
}

export async function POST(request: NextRequest) {
  const ctx = await context();
  if ("error" in ctx) return ctx.error;

  const body = (await request.json().catch(() => ({}))) as {
    name?: unknown;
    description?: unknown;
    config?: unknown;
  };
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const description = typeof body.description === "string" ? body.description.trim().slice(0, 280) : null;
  const config = body.config && typeof body.config === "object" ? body.config : null;
  if (!name) return NextResponse.json({ error: "A name is required" }, { status: 400 });
  if (name.length > 80) return NextResponse.json({ error: "Name is too long (max 80)" }, { status: 400 });
  if (!config) return NextResponse.json({ error: "config is required" }, { status: 400 });

  const now = new Date().toISOString();
  // Upsert by case-insensitive name within the org (a few presets per org).
  const { data: existing } = await ctx.admin
    .from("maps_search_presets")
    .select("id, name, slug")
    .eq("organization_id", ctx.organizationId);
  const rows = (existing ?? []) as { id: string; name: string; slug: string }[];
  const match = rows.find((r) => r.name.toLowerCase() === name.toLowerCase());

  if (match) {
    const { error } = await ctx.admin
      .from("maps_search_presets")
      .update({ name, description, config, updated_at: now })
      .eq("id", match.id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ id: match.id, slug: match.slug, updated: true });
  }

  // Unique slug within the org (append -2, -3, … on collision).
  const base = slugify(name) || "preset";
  const taken = new Set(rows.map((r) => r.slug));
  let slug = base;
  for (let i = 2; taken.has(slug); i++) slug = `${base}-${i}`;

  const { data, error } = await ctx.admin
    .from("maps_search_presets")
    .insert({ organization_id: ctx.organizationId, created_by: ctx.user.id, name, slug, description, config })
    .select("id, slug")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ id: (data as { id: string }).id, slug: (data as { slug: string }).slug, created: true });
}
