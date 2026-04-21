// POST /api/replies/[id]/outcome — log the post-contact disposition on a
// reply (called_booked, called_vm, called_no_answer, emailed, no_contact).
//
// Replaces the direct RLS UPDATE that the client dossier used to do. Going
// through an API route gives us server-side validation, audit stamping
// (outcome_logged_by from the session), and a clean place to hook in
// follow-up work later (e.g. webhook-out, CRM sync).
//
// Access: the client_user who owns the reply, or any owner/VA in the
// reply's organization. Status transition: anything except 'emailed' moves
// the row to 'resolved' (the send path sets 'sent' separately when the
// client chose the portal composer).

import { NextRequest, NextResponse } from "next/server";
import { createClient as createServerClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import type { LeadReply, ReplyOutcome } from "@/types/app";

const VALID_OUTCOMES: ReplyOutcome[] = [
  "called_booked",
  "called_vm",
  "called_no_answer",
  "emailed",
  "no_contact",
];

interface RouteParams {
  params: Promise<{ id: string }>;
}

interface OutcomeBody {
  outcome?: string;
  outcome_notes?: string | null;
}

export async function POST(req: NextRequest, { params }: RouteParams) {
  const { id } = await params;
  if (!id) {
    return NextResponse.json({ error: "Missing reply id" }, { status: 400 });
  }

  // --- Parse body ---
  let body: OutcomeBody;
  try {
    body = (await req.json()) as OutcomeBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const outcome = body.outcome;
  if (!outcome || !VALID_OUTCOMES.includes(outcome as ReplyOutcome)) {
    return NextResponse.json(
      {
        error: `outcome must be one of: ${VALID_OUTCOMES.join(", ")}`,
      },
      { status: 400 }
    );
  }
  const outcomeValue = outcome as ReplyOutcome;
  const outcomeNotes = body.outcome_notes?.trim() || null;

  // --- Auth ---
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const admin = createAdminClient();

  // --- Load the reply for access check + current status ---
  const { data: row, error: loadErr } = await admin
    .from("lead_replies")
    .select("id, organization_id, client_id, status")
    .eq("id", id)
    .maybeSingle();
  if (loadErr) {
    return NextResponse.json({ error: loadErr.message }, { status: 500 });
  }
  if (!row) {
    return NextResponse.json({ error: "Reply not found" }, { status: 404 });
  }
  const reply = row as Pick<LeadReply, "id" | "organization_id" | "client_id" | "status">;

  // --- Access check ---
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
    if (!link) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
  }

  // --- Compute next status ---
  // 'emailed' keeps the current status (the send path owns 'sent' for
  // portal-composed replies). Every other disposition resolves the row.
  // Matches the pre-#9 inline behavior so we don't change UX on rewire.
  const nextStatus = outcomeValue === "emailed" ? reply.status : "resolved";

  // --- Persist ---
  const outcomeLoggedAt = new Date().toISOString();
  const { error: updateErr } = await admin
    .from("lead_replies")
    .update({
      outcome: outcomeValue,
      outcome_notes: outcomeNotes,
      outcome_logged_at: outcomeLoggedAt,
      outcome_logged_by: user.id,
      status: nextStatus,
    })
    .eq("id", id);

  if (updateErr) {
    console.error("[replies/outcome] update failed:", updateErr);
    return NextResponse.json({ error: "Failed to save outcome" }, { status: 500 });
  }

  return NextResponse.json({
    success: true,
    outcome: outcomeValue,
    outcome_notes: outcomeNotes,
    outcome_logged_at: outcomeLoggedAt,
    status: nextStatus,
  });
}
