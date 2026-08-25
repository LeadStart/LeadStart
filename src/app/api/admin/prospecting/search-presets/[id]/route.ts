// Rename (PATCH) or delete a saved LinkedIn search preset. Owner/VA only, org-scoped.

import { NextRequest, NextResponse } from "next/server";
import { createClient as createServerClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

async function authOrgId(): Promise<{ organizationId: string } | { error: NextResponse }> {
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
  return { organizationId };
}

// Rename a preset. Body: { name }. Rejects a name that collides (case-insensitive)
// with a DIFFERENT preset, mirroring the upsert-by-name invariant in POST.
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const ctx = await authOrgId();
  if ("error" in ctx) return ctx.error;
  const { organizationId } = ctx;

  const body = (await request.json().catch(() => ({}))) as { name?: unknown };
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) return NextResponse.json({ error: "A name is required" }, { status: 400 });
  if (name.length > 80) return NextResponse.json({ error: "Name is too long (max 80)" }, { status: 400 });

  const { id } = await params;
  const admin = createAdminClient();

  const { data: existing } = await admin
    .from("linkedin_search_presets")
    .select("id, name")
    .eq("organization_id", organizationId);
  const clash = ((existing ?? []) as { id: string; name: string }[]).find(
    (r) => r.id !== id && r.name.toLowerCase() === name.toLowerCase(),
  );
  if (clash) {
    return NextResponse.json({ error: "A saved search with that name already exists" }, { status: 409 });
  }

  const { data, error } = await admin
    .from("linkedin_search_presets")
    .update({ name, updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("organization_id", organizationId)
    .select("id")
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const ctx = await authOrgId();
  if ("error" in ctx) return ctx.error;

  const { id } = await params;
  const admin = createAdminClient();
  const { error } = await admin
    .from("linkedin_search_presets")
    .delete()
    .eq("id", id)
    .eq("organization_id", ctx.organizationId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
