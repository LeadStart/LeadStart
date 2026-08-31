// Opt-out suppression, shared between the classifier pipeline and the admin
// reclassify route, so a manually-corrected opt-out is honored EXACTLY like an
// auto-detected one.
//
// Before this was extracted, only the classifier pipeline wrote suppression on
// final_class='unsubscribe'. If the classifier missed an oddly-phrased opt-out
// and an owner/VA fixed it via the reclassify route, the person was tagged
// 'unsubscribe' but never actually suppressed, so they keep getting mail. That
// is the compliance gap this closes.

import type { createAdminClient } from "@/lib/supabase/admin";
import type { SourceChannel } from "@/types/app";
import { escapeLikePattern } from "@/lib/utils";

export interface SuppressionInput {
  organization_id: string;
  client_id: string | null;
  lead_email: string | null;
  source_channel: SourceChannel;
  reply_id: string;
}

/**
 * Record an opt-out. Writes a per-CLIENT DNC entry so the suppression is scoped
 * to the brand the person replied to (a "stop" to David's outreach blocks
 * David's campaigns, not another client who happens to share the contact); the
 * native sender enforces this list per campaign.client_id before each send.
 *
 * For NON-native channels we ALSO keep the legacy global
 * contacts.status='unsubscribed' flip, because the LinkedIn suppression path
 * still reads it. The native channel relies solely on the per-client DNC list
 * and does NOT set the global flag (that global flip was exactly the
 * "everyone gets blocked" behavior we moved away from).
 *
 * Idempotent (DNC upsert ignores duplicates), best-effort (logs, never throws),
 * and a no-op when there is no email to suppress.
 */
export async function suppressUnsubscribe(
  admin: ReturnType<typeof createAdminClient>,
  input: SuppressionInput,
): Promise<void> {
  if (!input.lead_email) return;
  const email = input.lead_email.trim().toLowerCase();

  const { error: dncError } = await admin.from("dnc_entries").upsert(
    {
      organization_id: input.organization_id,
      client_id: input.client_id,
      email,
      reason: "unsubscribe",
      source_channel: input.source_channel,
      source_reply_id: input.reply_id,
    },
    { onConflict: "organization_id,client_id,email", ignoreDuplicates: true },
  );
  if (dncError) {
    console.error("[suppression] Failed to write DNC entry:", dncError);
  }

  if (input.source_channel !== "native_email") {
    const { error: suppressError } = await admin
      .from("contacts")
      .update({ status: "unsubscribed" })
      .eq("organization_id", input.organization_id)
      .ilike("email", escapeLikePattern(input.lead_email));
    if (suppressError) {
      console.error("[suppression] Failed to mark contact unsubscribed:", suppressError);
    }
  }
}
