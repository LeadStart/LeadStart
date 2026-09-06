// POST /api/replies/[id]/note: save the client's free-text note on a lead.
// Body: { note: string }. A blank/whitespace-only note clears it (stored NULL).
//
// This is a STANDALONE note, distinct from outcome_notes (which is tied to a
// call/email disposition). It is rendered on both the client portal inbox
// dossier and the internal admin inbox, so the client and their LeadStart team
// share one running note per lead.
//
// Access mirrors the outcome/exclude routes: the client_user who owns the
// reply, or any owner/VA in the reply's organization. The write goes through
// the service-role client after that check, so it doesn't depend on RLS.

import { NextRequest, NextResponse } from "next/server";
import { createClient as createServerClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import type { LeadReply } from "@/types/app";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function POST(req: NextRequest, { params }: RouteParams) {
  const { id } = await params;
  if (!id) return NextResponse.json({ error: "Missing reply id" }, { status: 400 });

  let body: { note?: unknown };
  try {
    body = (await req.json()) as { note?: unknown };
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (body.note !== undefined && body.note !== null && typeof body.note !== "string") {
    return NextResponse.json({ error: "note must be a string" }, { status: 400 });
  }
  const note = typeof body.note === "string" ? body.note.trim() || null : null;

  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();
  const { data: row, error: loadErr } = await admin
    .from("lead_replies")
    .select("id, organization_id, client_id")
    .eq("id", id)
    .maybeSingle();
  if (loadErr) return NextResponse.json({ error: loadErr.message }, { status: 500 });
  if (!row) return NextResponse.json({ error: "Reply not found" }, { status: 404 });
  const reply = row as Pick<LeadReply, "id" | "organization_id" | "client_id">;

  const role = user.app_metadata?.role;
  const userOrgId = user.app_metadata?.organization_id;
  if (role === "owner" || role === "va") {
    if (reply.organization_id !== userOrgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
  } else {
    const { data: link } = await admin
      .from("client_users")
      .select("client_id")
      .eq("user_id", user.id)
      .eq("client_id", reply.client_id)
      .maybeSingle();
    if (!link) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { error: updateErr } = await admin
    .from("lead_replies")
    .update({ client_note: note })
    .eq("id", id);
  if (updateErr) {
    console.error("[replies/note] update failed:", updateErr);
    return NextResponse.json({ error: "Failed to save note" }, { status: 500 });
  }

  return NextResponse.json({ success: true, client_note: note });
}
