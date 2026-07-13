// PATCH  /api/admin/mailboxes/[id] — pause/resume, adjust caps, edit
//                                    display name / client / ramp start.
// DELETE /api/admin/mailboxes/[id] — remove a mailbox (refused if it has
//                                    any send history, to preserve metrics).
// Owner only.

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { ABSOLUTE_MAX_DAILY_CAP } from "@/lib/gmail/ramp";
import type { NativeMailbox } from "@/types/app";

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
  max_daily_cap?: number | null;
  daily_cap_override?: number | null;
  display_name?: string | null;
  client_id?: string | null;
  ramp_started_at?: string;
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
    if (!["active", "paused", "error"].includes(body.status)) {
      return NextResponse.json({ error: "Invalid status" }, { status: 400 });
    }
    update.status = body.status;
    // Clearing an error state also clears the stale message. Resuming also
    // clears the auto-pause marker so the mailbox no longer reads as
    // "paused by the health check".
    if (body.status === "active") {
      update.last_error = null;
      update.last_error_at = null;
      update.health_paused_at = null;
    }
  }
  if (body.max_daily_cap !== undefined && body.max_daily_cap !== null) {
    const cap = Math.floor(body.max_daily_cap);
    if (cap <= 0) return NextResponse.json({ error: "max_daily_cap must be positive" }, { status: 400 });
    // Clamp to the absolute per-inbox ceiling — an inbox can never send >20/day.
    update.max_daily_cap = Math.min(cap, ABSOLUTE_MAX_DAILY_CAP);
  }
  if (body.daily_cap_override !== undefined) {
    // The override bypasses the ramp but is still bounded by the hard ceiling.
    update.daily_cap_override =
      body.daily_cap_override === null
        ? null
        : Math.min(Math.max(0, Math.floor(body.daily_cap_override)), ABSOLUTE_MAX_DAILY_CAP);
  }
  if (body.display_name !== undefined) update.display_name = body.display_name?.trim() || null;
  if (body.client_id !== undefined) update.client_id = body.client_id || null;
  if (body.ramp_started_at !== undefined) update.ramp_started_at = body.ramp_started_at;

  if (Object.keys(update).length === 0) {
    return NextResponse.json({ error: "Nothing to update" }, { status: 400 });
  }

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("native_mailboxes")
    .update(update)
    .eq("id", id)
    .eq("organization_id", organizationId)
    .select("*")
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data) return NextResponse.json({ error: "Mailbox not found" }, { status: 404 });

  return NextResponse.json({ mailbox: data as NativeMailbox });
}

export async function DELETE(_req: NextRequest, { params }: RouteParams) {
  const auth = await requireOwner();
  if (auth.error) return auth.error;
  const { organizationId } = auth;
  const { id } = await params;

  const admin = createAdminClient();

  // Refuse to delete a mailbox that has sent — deleting would cascade away
  // its native_sends history (metrics). Pause it instead. Never-used
  // mailboxes delete cleanly (campaign_mailboxes rows cascade off).
  const { count } = await admin
    .from("native_sends")
    .select("id", { count: "exact", head: true })
    .eq("mailbox_id", id)
    .eq("organization_id", organizationId);
  if ((count ?? 0) > 0) {
    return NextResponse.json(
      { error: "This mailbox has send history — pause it instead of deleting." },
      { status: 409 },
    );
  }

  const { error } = await admin
    .from("native_mailboxes")
    .delete()
    .eq("id", id)
    .eq("organization_id", organizationId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ deleted: true });
}
