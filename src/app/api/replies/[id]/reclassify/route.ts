// POST /api/replies/[id]/reclassify — admin/VA override of a reply's
// final_class. Used to correct needs_review items or to train future
// classifier calibration.
//
// Side effects:
//   - Sets lead_replies.final_class to the new class.
//   - Bumps status from 'new' → 'classified' so the reply clears the
//     "waiting on classifier" queue; other statuses are preserved.
//   - Writes audit columns (migration 00028): reclassified_by, _at, _from.
//   - Does NOT re-fire the client notification — reclassifications are
//     oversight-layer changes, not new signals.
//
// Access: owner/VA in the reply's organization only. Client users cannot
// reclassify their own replies.

import { NextRequest, NextResponse } from "next/server";
import { createClient as createServerClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import type { LeadReply, ReplyClass } from "@/types/app";

// Full taxonomy — mirror of the ReplyClass union in src/types/app.ts.
// Drift breaks admin reclassify validation.
const VALID_CLASSES: ReplyClass[] = [
  "true_interest",
  "meeting_booked",
  "qualifying_question",
  "objection_price",
  "objection_timing",
  "referral_forward",
  "wrong_person_no_referral",
  "ooo",
  "not_interested",
  "unsubscribe",
  "needs_review",
];

interface RouteParams {
  params: Promise<{ id: string }>;
}

interface ReclassifyBody {
  final_class?: string;
}

export async function POST(req: NextRequest, { params }: RouteParams) {
  const { id } = await params;
  if (!id) {
    return NextResponse.json({ error: "Missing reply id" }, { status: 400 });
  }

  // --- Parse body ---
  let body: ReclassifyBody;
  try {
    body = (await req.json()) as ReclassifyBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const newClass = body.final_class;
  if (!newClass || !VALID_CLASSES.includes(newClass as ReplyClass)) {
    return NextResponse.json(
      { error: `final_class must be one of: ${VALID_CLASSES.join(", ")}` },
      { status: 400 }
    );
  }
  const finalClass = newClass as ReplyClass;

  // --- Auth: owner/VA only ---
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const role = user.app_metadata?.role;
  if (role !== "owner" && role !== "va") {
    return NextResponse.json(
      { error: "Reclassify requires owner or VA role." },
      { status: 403 }
    );
  }
  const userOrgId = user.app_metadata?.organization_id;

  const admin = createAdminClient();

  // --- Load the reply for org check + previous class capture ---
  const { data: row, error: loadErr } = await admin
    .from("lead_replies")
    .select("id, organization_id, status, final_class")
    .eq("id", id)
    .maybeSingle();
  if (loadErr) {
    return NextResponse.json({ error: loadErr.message }, { status: 500 });
  }
  if (!row) {
    return NextResponse.json({ error: "Reply not found" }, { status: 404 });
  }
  const reply = row as Pick<LeadReply, "id" | "organization_id" | "status" | "final_class">;

  if (reply.organization_id !== userOrgId) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Idempotency: same-class reclassify is a no-op. Surfacing 200 with a
  // flag lets the UI distinguish "saved" from "nothing to do".
  if (reply.final_class === finalClass) {
    return NextResponse.json({
      success: true,
      unchanged: true,
      final_class: finalClass,
    });
  }

  // --- Persist ---
  // Bump 'new' → 'classified'; all other statuses stay put (a reclassify
  // on a sent/resolved/expired row shouldn't re-open the workflow).
  const nextStatus = reply.status === "new" ? "classified" : reply.status;
  const reclassifiedAt = new Date().toISOString();

  const { error: updateErr } = await admin
    .from("lead_replies")
    .update({
      final_class: finalClass,
      status: nextStatus,
      reclassified_by: user.id,
      reclassified_at: reclassifiedAt,
      reclassified_from: reply.final_class,
    })
    .eq("id", id);

  if (updateErr) {
    console.error("[replies/reclassify] update failed:", updateErr);
    return NextResponse.json({ error: "Failed to reclassify" }, { status: 500 });
  }

  return NextResponse.json({
    success: true,
    unchanged: false,
    final_class: finalClass,
    reclassified_from: reply.final_class,
    reclassified_at: reclassifiedAt,
    status: nextStatus,
  });
}
