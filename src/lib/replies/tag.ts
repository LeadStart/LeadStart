// Correlate an Instantly `lead_*` webhook event with the matching
// lead_replies row (or create a placeholder if the tag arrived before
// the reply content).
//
// Instantly fires classification tags (lead_interested, lead_wrong_person,
// etc.) as separate webhook events from reply_received. They can arrive
// in either order and are joined by (organization_id, instantly_message_id)
// — the same unique key we dedupe reply_received on. If the reply_received
// has already landed, we just write instantly_category. If it hasn't, we
// create a shell row so the classifier has something to update when the
// content eventually arrives.
//
// Side-effecting: writes to Supabase via the admin client. Returns the
// resulting row id + a flag telling the caller whether the pipeline is
// ready to run (both content and tag present).

import type { createAdminClient } from "@/lib/supabase/admin";
import type { RawWebhookPayload } from "./ingest";

export interface CorrelateTagContext {
  organization_id: string;
  client_id: string | null;     // may be null if campaign is unlinked
  campaign_id: string | null;   // DB campaign id, for placeholder rows
  instantly_campaign_id: string | null;
}

export interface CorrelateTagResult {
  replyId: string | null;       // null when we couldn't correlate (no message_id)
  bothSignalsPresent: boolean;  // true when content (body_text) + tag now both live on the row
  created: boolean;             // true when we created a new placeholder row
}

/** Extract the stable Instantly identifiers used to join tag ↔ reply. */
function extractIdsFromPayload(payload: RawWebhookPayload): {
  message_id: string | null;
  instantly_email_id: string | null;
} {
  const getStr = (k: string): string | null => {
    const v = payload[k];
    return typeof v === "string" && v.trim() ? v.trim() : null;
  };
  return {
    message_id: getStr("message_id"),
    instantly_email_id: getStr("instantly_email_id"),
  };
}

/**
 * Correlate a lead_* tag event to its lead_replies row.
 *
 * Flow:
 *   1. Pull message_id + instantly_email_id off the payload.
 *   2. Look up an existing row by (organization_id, instantly_message_id),
 *      falling back to (organization_id, instantly_email_id) if message_id
 *      is missing.
 *   3. If found → patch instantly_category + report whether body is present.
 *   4. If not found AND we have a client_id → create a placeholder with just
 *      the tag. client_id is required because lead_replies.client_id is NOT NULL.
 *   5. If not found AND client_id is null → bail out (caller will log and move on).
 */
export async function correlateTag(
  payload: RawWebhookPayload,
  ctx: CorrelateTagContext,
  admin: ReturnType<typeof createAdminClient>
): Promise<CorrelateTagResult> {
  const eventType = typeof payload.event_type === "string" ? payload.event_type : null;
  if (!eventType || !eventType.startsWith("lead_")) {
    return { replyId: null, bothSignalsPresent: false, created: false };
  }

  const { message_id, instantly_email_id } = extractIdsFromPayload(payload);

  // --- Try to find an existing row ---
  type ExistingRow = {
    id: string;
    body_text: string | null;
    instantly_category: string | null;
  };
  let existing: ExistingRow | null = null;

  if (message_id) {
    const { data } = await admin
      .from("lead_replies")
      .select("id, body_text, instantly_category")
      .eq("organization_id", ctx.organization_id)
      .eq("instantly_message_id", message_id)
      .maybeSingle();
    existing = (data as ExistingRow | null) ?? null;
  }

  if (!existing && instantly_email_id) {
    const { data } = await admin
      .from("lead_replies")
      .select("id, body_text, instantly_category")
      .eq("organization_id", ctx.organization_id)
      .eq("instantly_email_id", instantly_email_id)
      .maybeSingle();
    existing = (data as ExistingRow | null) ?? null;
  }

  // --- Found existing: patch the tag ---
  if (existing) {
    // Don't clobber a more specific tag already on the row (e.g. two tag
    // events firing). First-writer-wins.
    if (!existing.instantly_category) {
      await admin
        .from("lead_replies")
        .update({ instantly_category: eventType })
        .eq("id", existing.id);
    }
    const bothSignalsPresent = Boolean(existing.body_text);
    return { replyId: existing.id, bothSignalsPresent, created: false };
  }

  // --- No existing row: create placeholder if we can ---
  // Placeholder needs client_id (NOT NULL) and at least one dedupe key.
  if (!ctx.client_id || (!message_id && !instantly_email_id)) {
    return { replyId: null, bothSignalsPresent: false, created: false };
  }

  // lead_email is NOT NULL on the table. The tag event doesn't always
  // carry it; fall back to `email` then `lead_email`, and if both are
  // missing we can't create the row.
  const leadEmail =
    (typeof payload.lead_email === "string" && payload.lead_email.trim()) ||
    (typeof payload.email === "string" && payload.email.trim()) ||
    null;
  if (!leadEmail) {
    return { replyId: null, bothSignalsPresent: false, created: false };
  }

  const { data, error } = await admin
    .from("lead_replies")
    .insert({
      organization_id: ctx.organization_id,
      client_id: ctx.client_id,
      campaign_id: ctx.campaign_id,
      instantly_campaign_id: ctx.instantly_campaign_id,
      instantly_message_id: message_id,
      instantly_email_id,
      lead_email: leadEmail,
      instantly_category: eventType,
      raw_payload: payload as Record<string, unknown>,
      status: "new",
    })
    .select("id")
    .single();

  if (error || !data) {
    // Unique-constraint race: another webhook for the same message_id
    // just beat us in. Re-run the lookup so we still return a usable id.
    if (message_id) {
      const { data: retry } = await admin
        .from("lead_replies")
        .select("id, body_text, instantly_category")
        .eq("organization_id", ctx.organization_id)
        .eq("instantly_message_id", message_id)
        .maybeSingle();
      if (retry) {
        const row = retry as { id: string; body_text: string | null };
        return {
          replyId: row.id,
          bothSignalsPresent: Boolean(row.body_text),
          created: false,
        };
      }
    }
    return { replyId: null, bothSignalsPresent: false, created: false };
  }

  return { replyId: (data as { id: string }).id, bothSignalsPresent: false, created: true };
}
