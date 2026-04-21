// POST /api/replies/[id]/draft — generate or regenerate the Sonnet draft
// shown in the client's "Reply via portal" composer.
//
// Caps at 5 total Sonnet calls per reply (via lead_replies.draft_regenerations).
// Refuses classes the drafter can't meaningfully handle (unsubscribe, not_interested,
// ooo, wrong_person_no_referral, needs_review). Writes draft_body / draft_subject /
// draft_model / draft_token_usage / draft_generated_at on success so a client
// re-opening the dossier sees the prior draft without another Sonnet call.
//
// Access: client_users matching lead_replies.client_id, or admin/VA in the
// reply's organization.

import { NextRequest, NextResponse } from "next/server";
import { createClient as createServerClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { draftReply, isDraftableClass } from "@/lib/ai/drafter";
import { MissingAnthropicKeyError } from "@/lib/ai/client";
import type { LeadReply } from "@/types/app";

const MAX_REGENERATIONS = 5;

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function POST(_req: NextRequest, { params }: RouteParams) {
  const { id } = await params;
  if (!id) {
    return NextResponse.json({ error: "Missing reply id" }, { status: 400 });
  }

  // --- Auth ---
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const admin = createAdminClient();

  // --- Load reply + client in one round-trip ---
  const { data: row, error: loadErr } = await admin
    .from("lead_replies")
    .select(
      "*, client:client_id(id, name, persona_name, persona_title, brand_voice, signature_block, notification_email)"
    )
    .eq("id", id)
    .maybeSingle();

  if (loadErr) {
    return NextResponse.json({ error: loadErr.message }, { status: 500 });
  }
  if (!row) {
    return NextResponse.json({ error: "Reply not found" }, { status: 404 });
  }

  const reply = row as LeadReply & {
    client: {
      id: string;
      name: string;
      persona_name: string | null;
      persona_title: string | null;
      brand_voice: string | null;
      signature_block: string | null;
      notification_email: string | null;
    } | null;
  };

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

  // --- Preconditions ---
  if (!isDraftableClass(reply.final_class)) {
    return NextResponse.json(
      {
        error:
          "This reply class doesn't support drafting. Only hot/warm inbound replies get composer drafts.",
      },
      { status: 400 }
    );
  }
  if (reply.status === "sent" || reply.status === "resolved" || reply.status === "expired") {
    return NextResponse.json(
      { error: `Reply is ${reply.status} — composer is closed.` },
      { status: 409 }
    );
  }
  if (reply.draft_regenerations >= MAX_REGENERATIONS) {
    return NextResponse.json(
      {
        error: `Reached the ${MAX_REGENERATIONS}-draft cap. Edit the existing draft and send, or contact your account owner.`,
      },
      { status: 429 }
    );
  }
  if (!reply.client?.persona_name) {
    return NextResponse.json(
      {
        error:
          "This client has no persona configured yet. Ask an admin to set Persona name + title before drafting.",
      },
      { status: 412 }
    );
  }

  // --- Draft ---
  let draft;
  try {
    draft = await draftReply({
      final_class: reply.final_class as import("@/lib/ai/drafter").DraftableClass,
      claude_reason: reply.claude_reason,
      lead_name: reply.lead_name,
      lead_company: reply.lead_company,
      inbound_subject: reply.subject,
      inbound_body: reply.body_text || "",
      persona_name: reply.client.persona_name,
      persona_title: reply.client.persona_title,
      brand_voice: reply.client.brand_voice,
      signature_block: reply.client.signature_block,
      referral_contact: reply.referral_contact,
    });
  } catch (err) {
    if (err instanceof MissingAnthropicKeyError) {
      return NextResponse.json({ error: err.message }, { status: 500 });
    }
    const message = err instanceof Error ? err.message : String(err);
    console.error("[replies/draft] Sonnet call failed:", err);
    return NextResponse.json(
      { error: `Drafter failed: ${message}` },
      { status: 502 }
    );
  }

  // --- Persist ---
  const nextRegenerations = reply.draft_regenerations + 1;
  const { error: updateErr } = await admin
    .from("lead_replies")
    .update({
      draft_subject: draft.output.subject,
      draft_body: draft.output.body_text,
      draft_model: draft.model,
      draft_token_usage: draft.token_usage,
      draft_generated_at: new Date().toISOString(),
      draft_regenerations: nextRegenerations,
    })
    .eq("id", id);

  if (updateErr) {
    console.error("[replies/draft] Failed to persist draft:", updateErr);
    return NextResponse.json(
      { error: "Draft generated but failed to save. Try again." },
      { status: 500 }
    );
  }

  return NextResponse.json({
    subject: draft.output.subject,
    body_text: draft.output.body_text,
    regenerations_used: nextRegenerations,
    regenerations_remaining: MAX_REGENERATIONS - nextRegenerations,
  });
}
