// Orchestrator: run the three-layer classifier on a lead_replies row and
// — if the final_class is a hot one for this client — fire the
// notification email.
//
// Called from the webhook handler via Next.js `after()` so it runs after
// we've already returned 200 to Instantly. Inputs are just the reply id +
// an admin Supabase client; everything else is derived.
//
// Idempotent: re-invocations on a row that already has final_class set
// are a no-op. Safe for Instantly retries.

import type { createAdminClient } from "@/lib/supabase/admin";
import type { Client, LeadReply, ReplyClass } from "@/types/app";
import { runKeywordPrefilter } from "./keyword-prefilter";
import { decideFinalClass } from "./decide";
import { classifyReply, type ClassifierOutput } from "@/lib/ai/classifier";
import { sendHotLeadNotification } from "@/lib/notifications/send-hot-lead";
import { MissingAnthropicKeyError } from "@/lib/ai/client";

export interface RunReplyPipelineResult {
  skipped: boolean;              // true if row missing, already classified, or body missing
  skippedReason?: string;
  finalClass?: ReplyClass;
  notified?: boolean;            // true if sendHotLeadNotification ran successfully
  notifySkippedReason?: string;  // populated when we decided NOT to notify
}

/**
 * Run classification + (optional) notification for a single lead_replies row.
 *
 * @param replyId - lead_replies.id
 * @param admin - service-role Supabase client
 */
export async function runReplyPipeline(
  replyId: string,
  admin: ReturnType<typeof createAdminClient>
): Promise<RunReplyPipelineResult> {
  // --- 1. Fetch the row ---
  const { data: replyData, error: replyError } = await admin
    .from("lead_replies")
    .select("*")
    .eq("id", replyId)
    .maybeSingle();

  if (replyError || !replyData) {
    return { skipped: true, skippedReason: "reply_not_found" };
  }
  const reply = replyData as unknown as LeadReply;

  // Idempotency: a prior invocation already classified this row.
  if (reply.final_class) {
    return {
      skipped: true,
      skippedReason: "already_classified",
      finalClass: reply.final_class,
    };
  }

  // We need a body to classify. If the tag arrived before reply_received,
  // wait — the webhook that adds body_text will re-fire the pipeline.
  if (!reply.body_text || !reply.body_text.trim()) {
    return { skipped: true, skippedReason: "no_body_yet" };
  }

  // --- 2. Fetch the client (needed for persona + notify prefs) ---
  const { data: clientData, error: clientError } = await admin
    .from("clients")
    .select("*")
    .eq("id", reply.client_id)
    .maybeSingle();
  if (clientError || !clientData) {
    return { skipped: true, skippedReason: "client_not_found" };
  }
  const client = clientData as unknown as Client;

  // --- 3. Three-layer classification ---
  const prefilter = runKeywordPrefilter(reply.body_text, reply.from_address);

  // Claude can fail (API down, rate-limit, key missing). decide.ts handles
  // null claude gracefully by falling back to prefilter or needs_review.
  let claude: ClassifierOutput | null = null;
  try {
    claude = await classifyReply({
      body: reply.body_text,
      instantly_category: reply.instantly_category,
      prefilter,
      persona_name: client.persona_name,
    });
  } catch (err) {
    if (err instanceof MissingAnthropicKeyError) {
      console.warn("[pipeline] ANTHROPIC_API_KEY missing — running without Claude");
    } else {
      console.error("[pipeline] Claude classifier failed:", err);
    }
  }

  const decision = decideFinalClass({
    instantly_category: reply.instantly_category,
    prefilter,
    claude,
  });

  // --- 4. Write classification back to the row ---
  const { error: updateError } = await admin
    .from("lead_replies")
    .update({
      keyword_flags: prefilter.flags,
      claude_class: decision.claude_class,
      claude_confidence: decision.claude_confidence,
      claude_reason: decision.reason,
      referral_contact: decision.referral_contact,
      final_class: decision.final_class,
      classified_at: new Date().toISOString(),
      status: "classified",
    })
    .eq("id", replyId);

  if (updateError) {
    console.error("[pipeline] Failed to write classification:", updateError);
    return { skipped: true, skippedReason: "classification_write_failed" };
  }

  // --- 5. Notify if hot ---
  const autoNotify = client.auto_notify_classes || [];
  const shouldNotify = autoNotify.includes(decision.final_class);

  if (!shouldNotify) {
    return {
      skipped: false,
      finalClass: decision.final_class,
      notified: false,
      notifySkippedReason: "class_not_in_auto_notify",
    };
  }

  if (!client.notification_email) {
    return {
      skipped: false,
      finalClass: decision.final_class,
      notified: false,
      notifySkippedReason: "no_notification_email",
    };
  }

  // Re-fetch the row so sendHotLeadNotification has the freshly-classified
  // fields (final_class, referral_contact, etc.). One extra query beats
  // hand-constructing a LeadReply from the decide output.
  const { data: classifiedData } = await admin
    .from("lead_replies")
    .select("*")
    .eq("id", replyId)
    .maybeSingle();
  if (!classifiedData) {
    return {
      skipped: false,
      finalClass: decision.final_class,
      notified: false,
      notifySkippedReason: "row_vanished_before_notify",
    };
  }

  try {
    const result = await sendHotLeadNotification(
      {
        reply: classifiedData as unknown as LeadReply,
        clientNotificationEmail: client.notification_email,
        clientNotificationCcEmails: client.notification_cc_emails ?? [],
      },
      admin
    );
    return {
      skipped: false,
      finalClass: decision.final_class,
      notified: !result.skipped,
      notifySkippedReason: result.skipped ? "already_notified" : undefined,
    };
  } catch (err) {
    console.error("[pipeline] Notification failed:", err);
    return {
      skipped: false,
      finalClass: decision.final_class,
      notified: false,
      notifySkippedReason: "notification_error",
    };
  }
}
