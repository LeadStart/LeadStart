// PATCH  /api/admin/seed-inboxes/[id] — pause/resume, relabel, or set the
//                                       rotation role of a seed. Resuming
//                                       clears a stale read error. Credentials
//                                       (`auth`) are NOT patchable — change an
//                                       IMAP password by removing + re-adding;
//                                       reconnect a Microsoft seed.
// DELETE /api/admin/seed-inboxes/[id] — remove a seed. Past results keep the
//                                       seed's address (FK is SET NULL), so
//                                       history stays readable.
// Owner only. Migrations 00068 + 00085.

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import type { SeedInbox } from "@/types/app";

// Browser-safe columns — never expose the `auth` credential column.
const SEED_SELECT =
  "id, organization_id, email_address, label, provider, role, status, last_error, last_error_at, created_at, updated_at";

interface RouteParams {
  params: Promise<{ id: string }>;
}

async function requireOwner() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  }
  if (user.app_metadata?.role !== "owner") {
    return { error: NextResponse.json({ error: "Owner role required" }, { status: 403 }) };
  }
  const organizationId = user.app_metadata?.organization_id as string | undefined;
  if (!organizationId) {
    return { error: NextResponse.json({ error: "No organization on user" }, { status: 400 }) };
  }
  return { organizationId };
}

interface PatchBody {
  status?: string;
  label?: string | null;
  role?: string | null;
}

export async function PATCH(req: NextRequest, { params }: RouteParams) {
  const auth = await requireOwner();
  if (auth.error) return auth.error;
  const { organizationId } = auth;
  const { id } = await params;

  let body: PatchBody;
  try {
    body = (await req.json()) as PatchBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const update: Record<string, unknown> = {};
  if (body.status !== undefined) {
    if (!["active", "paused"].includes(body.status)) {
      return NextResponse.json({ error: "Invalid status" }, { status: 400 });
    }
    update.status = body.status;
    if (body.status === "active") {
      update.last_error = null;
      update.last_error_at = null;
    }
  }
  if (body.label !== undefined) update.label = body.label?.trim() || null;
  if (body.role !== undefined) {
    if (body.role !== null && !["veteran", "fresh"].includes(body.role)) {
      return NextResponse.json({ error: "Invalid seed role" }, { status: 400 });
    }
    update.role = body.role ?? null;
  }
  if (Object.keys(update).length === 0) {
    return NextResponse.json({ error: "Nothing to update" }, { status: 400 });
  }

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("seed_inboxes")
    .update(update)
    .eq("id", id)
    .eq("organization_id", organizationId)
    .select(SEED_SELECT)
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data) return NextResponse.json({ error: "Seed inbox not found" }, { status: 404 });
  return NextResponse.json({ seed: data as SeedInbox });
}

export async function DELETE(_req: NextRequest, { params }: RouteParams) {
  const auth = await requireOwner();
  if (auth.error) return auth.error;
  const { organizationId } = auth;
  const { id } = await params;

  const admin = createAdminClient();
  const { error } = await admin
    .from("seed_inboxes")
    .delete()
    .eq("id", id)
    .eq("organization_id", organizationId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ deleted: true });
}
