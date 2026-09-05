// Saved LinkedIn search presets: list + save (upsert by name).
// Owner/VA only, org-scoped. The admin client bypasses RLS; org scoping is
// enforced in code (mirrors the other prospecting routes).

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

export async function GET() {
  const ctx = await context();
  if ("error" in ctx) return ctx.error;
  const { data, error } = await ctx.admin
    .from("linkedin_search_presets")
    .select("id, name, config, created_at")
    .eq("organization_id", ctx.organizationId)
    .order("created_at", { ascending: false });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ presets: data ?? [] });
}

export async function POST(request: NextRequest) {
  const ctx = await context();
  if ("error" in ctx) return ctx.error;

  const body = (await request.json().catch(() => ({}))) as { name?: unknown; config?: unknown };
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const config = body.config && typeof body.config === "object" ? body.config : null;
  if (!name) return NextResponse.json({ error: "A name is required" }, { status: 400 });
  if (name.length > 80) return NextResponse.json({ error: "Name is too long (max 80)" }, { status: 400 });
  if (!config) return NextResponse.json({ error: "config is required" }, { status: 400 });

  const now = new Date().toISOString();
  // Upsert by case-insensitive name: a few presets per org, so match in code
  // rather than lean on the functional unique index for onConflict.
  const { data: existing } = await ctx.admin
    .from("linkedin_search_presets")
    .select("id, name")
    .eq("organization_id", ctx.organizationId);
  const match = ((existing ?? []) as { id: string; name: string }[]).find(
    (r) => r.name.toLowerCase() === name.toLowerCase(),
  );

  if (match) {
    const { error } = await ctx.admin
      .from("linkedin_search_presets")
      .update({ name, config, updated_at: now })
      .eq("id", match.id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ id: match.id, updated: true });
  }

  const { data, error } = await ctx.admin
    .from("linkedin_search_presets")
    .insert({ organization_id: ctx.organizationId, created_by: ctx.user.id, name, config })
    .select("id")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ id: (data as { id: string }).id, created: true });
}
