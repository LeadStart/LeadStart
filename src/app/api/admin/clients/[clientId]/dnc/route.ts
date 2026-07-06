// GET/POST/DELETE /api/admin/clients/[clientId]/dnc
//
// Owner-only management of a client's do-not-contact list (dnc_entries,
// migration 00059). Entries are scoped to this client_id, so they suppress
// only this client's campaigns. Opt-out replies auto-populate the list via the
// reply pipeline; this route is the manual add / remove / view surface.

import { NextRequest, NextResponse } from "next/server";
import { createClient as createServerClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

interface RouteParams {
  params: Promise<{ clientId: string }>;
}

type Ctx =
  | { error: NextResponse }
  | {
      admin: ReturnType<typeof createAdminClient>;
      client: { id: string; organization_id: string; name: string };
      userId: string;
    };

async function requireOwnerClient(clientId: string): Promise<Ctx> {
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  if (user.app_metadata?.role !== "owner") {
    return { error: NextResponse.json({ error: "Owner role required" }, { status: 403 }) };
  }
  const admin = createAdminClient();
  const { data: clientRow } = await admin
    .from("clients")
    .select("id, organization_id, name")
    .eq("id", clientId)
    .maybeSingle();
  const client = clientRow as { id: string; organization_id: string; name: string } | null;
  if (!client) return { error: NextResponse.json({ error: "Client not found" }, { status: 404 }) };
  if (client.organization_id !== user.app_metadata?.organization_id) {
    return { error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
  }
  return { admin, client, userId: user.id };
}

export async function GET(_req: NextRequest, { params }: RouteParams) {
  const { clientId } = await params;
  const ctx = await requireOwnerClient(clientId);
  if ("error" in ctx) return ctx.error;
  const { data } = await ctx.admin
    .from("dnc_entries")
    .select("id, email, reason, source_channel, notes, created_at")
    .eq("organization_id", ctx.client.organization_id)
    .eq("client_id", clientId)
    .order("created_at", { ascending: false });
  return NextResponse.json({ entries: data ?? [] });
}

export async function POST(req: NextRequest, { params }: RouteParams) {
  const { clientId } = await params;
  const ctx = await requireOwnerClient(clientId);
  if ("error" in ctx) return ctx.error;
  let body: { email?: string; notes?: string };
  try {
    body = (await req.json()) as { email?: string; notes?: string };
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const email = (body.email ?? "").trim().toLowerCase();
  if (!email || !email.includes("@")) {
    return NextResponse.json({ error: "A valid email is required" }, { status: 400 });
  }
  const { error } = await ctx.admin.from("dnc_entries").upsert(
    {
      organization_id: ctx.client.organization_id,
      client_id: clientId,
      email,
      reason: "manual",
      notes: (body.notes ?? "").trim() || null,
      created_by: ctx.userId,
    },
    { onConflict: "organization_id,client_id,email", ignoreDuplicates: true },
  );
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: NextRequest, { params }: RouteParams) {
  const { clientId } = await params;
  const ctx = await requireOwnerClient(clientId);
  if ("error" in ctx) return ctx.error;
  const id = req.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });
  const { error } = await ctx.admin
    .from("dnc_entries")
    .delete()
    .eq("id", id)
    .eq("organization_id", ctx.client.organization_id)
    .eq("client_id", clientId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
