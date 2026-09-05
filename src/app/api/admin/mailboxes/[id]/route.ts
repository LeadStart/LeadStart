// PATCH  /api/admin/mailboxes/[id]: pause/resume, adjust caps, edit
//                                    display name / client / ramp start.
// DELETE /api/admin/mailboxes/[id]: delete the mailbox's Google Workspace user
//                                    (frees the paid seat) and remove our row,
//                                    cascading its send history / metrics away.
// Owner only.

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { ABSOLUTE_MAX_DAILY_CAP } from "@/lib/gmail/ramp";
import { normalizeTags } from "@/lib/mailboxes/tags";
import { loadWorkspaceAdminForOrg } from "@/lib/google/org";
import { GoogleConfigError } from "@/lib/google/auth";
import type { NativeMailbox } from "@/types/app";

// The DELETE path makes a Google Directory round-trip, so give it headroom.
export const maxDuration = 30;

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
  tags?: unknown;
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
    // Clamp to the absolute per-inbox ceiling: an inbox can never send >20/day.
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
  if (body.tags !== undefined) update.tags = normalizeTags(body.tags);

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

  // Load the mailbox: we need its address (the Google user key) and its domain
  // (to pick the right Workspace tenant).
  const { data: mbRow } = await admin
    .from("native_mailboxes")
    .select("id, email_address, domain_id")
    .eq("id", id)
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (!mbRow) {
    return NextResponse.json({ error: "Mailbox not found" }, { status: 404 });
  }
  const mailbox = mbRow as { id: string; email_address: string; domain_id: string | null };

  // Which Workspace owns this mailbox? Its domain carries the workspace_id; a
  // mailbox not linked to a domain falls back to the org's default Workspace.
  let workspaceId: string | null = null;
  if (mailbox.domain_id) {
    const { data: dom } = await admin
      .from("sending_domains")
      .select("workspace_id")
      .eq("id", mailbox.domain_id)
      .maybeSingle();
    workspaceId = (dom?.workspace_id as string | null) ?? null;
  }

  // Delete the Google Workspace user (frees the paid seat). Mirrors the domain-
  // delete route: a missing Google config is a no-op (nothing to delete there),
  // an already-gone user (404) is fine, and any other Google error we surface
  // while leaving our row in place, so a mailbox never loses its mapping while
  // its Google user still exists.
  let googleDeleted: boolean | null = null;
  let googleError: string | null = null;
  try {
    const workspace = await loadWorkspaceAdminForOrg(admin, organizationId, { workspaceId });
    const res = await workspace.directory.deleteUser(mailbox.email_address);
    googleDeleted = res.deleted;
  } catch (err) {
    if (err instanceof GoogleConfigError) {
      googleDeleted = null; // Google not configured for this org: nothing there.
    } else {
      googleError = err instanceof Error ? err.message : String(err);
    }
  }
  if (googleError) {
    return NextResponse.json(
      {
        error: `Could not delete ${mailbox.email_address} from Google Workspace: ${googleError}. Nothing was removed, try again, or delete the user in Google Admin first.`,
      },
      { status: 502 },
    );
  }

  // The Google user is gone (or was never ours to delete). Delete our row: its
  // native_sends history and campaign_mailboxes links cascade off with it
  // (campaign_enrollments keep, their mailbox pointer nulled).
  const { error: delError } = await admin
    .from("native_mailboxes")
    .delete()
    .eq("id", id)
    .eq("organization_id", organizationId);
  if (delError) return NextResponse.json({ error: delError.message }, { status: 500 });

  return NextResponse.json({ deleted: true, google_deleted: googleDeleted });
}
