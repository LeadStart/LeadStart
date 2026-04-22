// PATCH /api/clients/[clientId] — owner-only update of per-client reply-routing
// fields (persona, notification email/phone, brand voice, signature,
// auto_notify_classes).
//
// These columns drive the classification + notification pipeline; they're
// separated from the generic client fields (contact_email, notes, etc.) so
// we can keep oversight tight: only owners can touch them, and the full
// whitelist is enforced server-side rather than relying on RLS.

import { NextRequest, NextResponse } from "next/server";
import { createClient as createServerClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import type { ReplyClass } from "@/types/app";

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
  params: Promise<{ clientId: string }>;
}

interface PatchBody {
  notification_email?: string | null;
  phone_number?: string | null;
  auto_notify_classes?: string[];
  persona_name?: string | null;
  persona_title?: string | null;
  persona_linkedin_url?: string | null;
  persona_photo_url?: string | null;
  brand_voice?: string | null;
  signature_block?: string | null;
}

// Trim strings; map empty/whitespace-only to null so the DB keeps nullable
// columns clean instead of storing "".
function normalizeNullableText(v: unknown): string | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v !== "string") return undefined;
  const trimmed = v.trim();
  return trimmed.length === 0 ? null : trimmed;
}

export async function PATCH(req: NextRequest, { params }: RouteParams) {
  const { clientId } = await params;
  if (!clientId) {
    return NextResponse.json({ error: "Missing client id" }, { status: 400 });
  }

  let body: PatchBody;
  try {
    body = (await req.json()) as PatchBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (user.app_metadata?.role !== "owner") {
    return NextResponse.json(
      { error: "Only owners can update reply-routing settings." },
      { status: 403 }
    );
  }
  const userOrgId = user.app_metadata?.organization_id;

  const admin = createAdminClient();
  const { data: clientRow, error: loadErr } = await admin
    .from("clients")
    .select("id, organization_id")
    .eq("id", clientId)
    .maybeSingle();
  if (loadErr) {
    return NextResponse.json({ error: loadErr.message }, { status: 500 });
  }
  if (!clientRow) {
    return NextResponse.json({ error: "Client not found" }, { status: 404 });
  }
  if ((clientRow as { organization_id: string }).organization_id !== userOrgId) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const update: Record<string, unknown> = {};

  const textFields: (keyof PatchBody)[] = [
    "notification_email",
    "phone_number",
    "persona_name",
    "persona_title",
    "persona_linkedin_url",
    "persona_photo_url",
    "brand_voice",
    "signature_block",
  ];
  for (const key of textFields) {
    const normalized = normalizeNullableText(body[key]);
    if (normalized !== undefined) update[key] = normalized;
  }

  if (body.auto_notify_classes !== undefined) {
    if (!Array.isArray(body.auto_notify_classes)) {
      return NextResponse.json(
        { error: "auto_notify_classes must be an array" },
        { status: 400 }
      );
    }
    const invalid = body.auto_notify_classes.filter(
      (c) => !VALID_CLASSES.includes(c as ReplyClass)
    );
    if (invalid.length > 0) {
      return NextResponse.json(
        { error: `Invalid classes: ${invalid.join(", ")}` },
        { status: 400 }
      );
    }
    update.auto_notify_classes = Array.from(new Set(body.auto_notify_classes));
  }

  if (Object.keys(update).length === 0) {
    return NextResponse.json({ success: true, unchanged: true });
  }

  const { error: updateErr } = await admin
    .from("clients")
    .update(update)
    .eq("id", clientId);

  if (updateErr) {
    console.error("[clients/PATCH] update failed:", updateErr);
    return NextResponse.json({ error: "Failed to update client" }, { status: 500 });
  }

  return NextResponse.json({ success: true, updated_fields: Object.keys(update) });
}
