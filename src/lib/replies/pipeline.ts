// Orchestrator: run the two-layer classifier on a lead_replies row and
// (if the final_class is a hot one for this client) fire the
// notification email.
//
// Called from the webhook handler via Next.js `after()` so it runs after
// we've already returned 200 to the upstream provider. Inputs are just
// the reply id + an admin Supabase client; everything else is derived.
//
// Idempotent: re-invocations on a row that already has final_class set
// are a no-op. Safe for webhook retries.

import type { createAdminClient } from "@/lib/supabase/admin";
import type { Client, LeadReply, ReplyClass } from "@/types/app";
import { HOT_REPLY_CLASSES } from "@/types/app";
import { runKeywordPrefilter } from "./keyword-prefilter";
import { decideFinalClass } from "./decide";
import { classifyReply, type ClassifierOutput } from "@/lib/ai/classifier";
import { sendHotLeadNotification } from "@/lib/notifications/send-hot-lead";
import { sendHotLeadPush } from "@/lib/notifications/web-push";
import { deliverReplyAutomations } from "@/lib/notifications/internal-automations";
import { MissingAnthropicKeyError } from "@/lib/ai/client";
import { suppressUnsubscribe } from "./suppression";

// Two-layer classification (owner decision, 2026-08-31): the deterministic
// prefilter is Layer 1 (still the sole authority on the compliance hard-
// overrides unsubscribe/ooo, via decide.ts), and Claude Haiku is Layer 2, the
// nuanced arbiter for everything else. decide.ts merges both. Flip this to
// false to fall back to keyword-only (decide.ts degrades gracefully to the
// prefilter suggestion, else needs_review).
const USE_CLAUDE_CLASSIFIER = true;

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
  // wait: the webhook that adds body_text will re-fire the pipeline.
  if (!reply.body_text || !reply.body_text.trim()) {
    return { skipped: true, skippedReason: "no_body_yet" };
  }

  // --- 2. Fetch the client (needed for persona + notify prefs) ---
  // Orphan replies (client_id IS NULL) skip this step and land on the
  // "classify but don't notify" path at step 5. The webhook-time lazy-
  // create of an orphan campaign (B2) produces these rows; B3's link UI
  // will later populate client_id and kick off notification via the retry
  // cron.
  let client: Client | null = null;
  if (reply.client_id) {
    const { data: clientData, error: clientError } = await admin
      .from("clients")
      .select("*")
      .eq("id", reply.client_id)
      .maybeSingle();
    if (clientError || !clientData) {
      return { skipped: true, skippedReason: "client_not_found" };
    }
    client = clientData as unknown as Client;
  }

  // --- 3. Classification (keyword prefilter is primary; Claude off) ---
  const prefilter = runKeywordPrefilter(reply.body_text, reply.from_address);

  let claude: ClassifierOutput | null = null;
  if (USE_CLAUDE_CLASSIFIER) {
    // decide.ts handles a null claude gracefully (falls back to the prefilter
    // suggestion, else needs_review), so any failure here is non-fatal.
    try {
      claude = await classifyReply({
        body: reply.body_text,
        prefilter,
        persona_name: client?.persona_name ?? null,
      });
    } catch (err) {
      if (err instanceof MissingAnthropicKeyError) {
        console.warn("[pipeline] ANTHROPIC_API_KEY missing, running without Claude");
      } else {
        console.error("[pipeline] Claude classifier failed:", err);
      }
    }
  }

  const decision = decideFinalClass({
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

  // --- 4b. Suppression on opt-out ---
  // Delegated to the shared helper (src/lib/replies/suppression.ts) so the admin
  // reclassify route honors a manually-corrected opt-out identically: writes a
  // per-client DNC entry, plus the legacy global contact flip for non-native
  // channels. Best-effort + idempotent.
  if (decision.final_class === "unsubscribe") {
    await suppressUnsubscribe(admin, {
      organization_id: reply.organization_id,
      client_id: reply.client_id,
      lead_email: reply.lead_email,
      source_channel: reply.source_channel,
      reply_id: reply.id,
    });
  }

  // Hot-but-uncertain: the classifier parked this in needs_review, but a hot
  // signal sat underneath, either Claude's own class before the low-confidence
  // demotion, or the deterministic prefilter's suggestion. Rather than let a
  // possible hot lead rot silently in the inbox (needs_review is non-urgent and
  // never re-runs), ping the owner/VA to triage it fast (owner call 2026-08-31).
  const underlyingHot =
    (decision.claude_class !== null &&
      HOT_REPLY_CLASSES.includes(decision.claude_class)) ||
    (prefilter.suggested_class !== null &&
      HOT_REPLY_CLASSES.includes(prefilter.suggested_class as ReplyClass));
  const hotUncertain = decision.final_class === "needs_review" && underlyingHot;

  // --- 4c. Internal automations (org-level Slack / webhook / teammate email) ---
  // Event-triggered delivery of the "internal automation" notify targets an org
  // configures under Settings → Integrations (migration 00087). Independent of
  // the per-client hot-lead email below: this fires for every classified reply
  // (orphan-client rows included) whose class matches the org's notify_on gate,
  // even when the client has no notification_email. Best-effort + fully
  // self-guarded: it never throws, so it can't affect classification or the
  // hot-lead path. Idempotent via the already_classified early-return above.
  await deliverReplyAutomations({
    admin,
    organizationId: reply.organization_id,
    reply,
    client,
    finalClass: decision.final_class,
    triage: hotUncertain,
  });

  // Owner/VA fast-triage push for a hot-but-uncertain reply. Owner-facing, fired
  // here BEFORE the orphan/client gates so it reaches the owner even for an
  // orphan reply or a client with no notification_email. Mutually exclusive with
  // the real-hot push in the client-notify block below (hotUncertain requires
  // needs_review; a real-hot class never is), so no double-ping. Self-guarded.
  if (hotUncertain) {
    await sendHotLeadPush({
      admin,
      organizationId: reply.organization_id,
      replyId,
      leadName: reply.lead_name,
      leadCompany: reply.lead_company,
      replySubject: reply.subject,
      replyBodyText: reply.body_text,
      finalClass: decision.final_class,
      kind: "review",
    });
  }

  // --- 5. Notify if hot ---
  // Orphan replies can't be notified because we don't know which client
  // to send to. They sit with notification_status='pending' (the default
  // from migration 00032) + client_id IS NULL, which is the orphan signal
  // B3's link UI uses to pick them up after the campaign gets a client.
  if (!client) {
    return {
      skipped: false,
      finalClass: decision.final_class,
      notified: false,
      notifySkippedReason: "orphan_client",
    };
  }

  // The client hot-lead email fires ONLY for genuinely hot, call-now classes
  // (true_interest / meeting_booked / qualifying_question). referral_forward and
  // the objection classes are owner-facing: a handoff or a price/timing concern
  // is not a "pick up the phone now" signal, and emailing the client on one is
  // exactly the false alarm we're removing. HOT_REPLY_CLASSES is the hard gate;
  // the per-client auto_notify_classes array can only NARROW within it (it can't
  // opt a client into referral/objection emails). Even if a stale row still
  // lists referral_forward (migration 00111 strips those), this guard covers it.
  const autoNotify = client.auto_notify_classes || [];
  const shouldNotify =
    autoNotify.includes(decision.final_class) &&
    HOT_REPLY_CLASSES.includes(decision.final_class);

  if (!shouldNotify) {
    return {
      skipped: false,
      finalClass: decision.final_class,
      notified: false,
      notifySkippedReason: "class_not_in_auto_notify",
    };
  }

  // Admin web-push: fire it here (before the client-email checks below) so the
  // owner is pinged even when the client has no notification_email. Self-guarded
  // (never throws) and no-ops until VAPID keys are set, so it can't affect the
  // hot-lead email path. Awaited so it completes before this serverless fn ends.
  await sendHotLeadPush({
    admin,
    organizationId: reply.organization_id,
    replyId,
    leadName: reply.lead_name,
    leadCompany: reply.lead_company,
    replySubject: reply.subject,
    replyBodyText: reply.body_text,
    finalClass: decision.final_class,
  });

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
