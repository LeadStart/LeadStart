import "server-only";
import type { createAdminClient } from "@/lib/supabase/admin";
import { sendViaResend } from "@/lib/notifications/resend-client";
import { buildLowBalanceEmail, LOW_BALANCE_SUBJECT } from "@/lib/email/low-balance";

// Buyer low-balance alert. Called after a buyer settle (finalizeOutcomes): if the
// buyer's available balance has dropped below the configured threshold and we have
// not already alerted them since their last top-up, email them once and stamp
// organizations.low_balance_alerted_at. A top-up clears the stamp (handleTokenTopup),
// so the next crossing re-alerts. Fully gated + never throws (it rides inside the
// enrichment cron): a missing threshold, a non-buyer org, no recipient, or a send
// failure all resolve to a quiet no-op.

type Admin = ReturnType<typeof createAdminClient>;

export async function maybeSendLowBalanceAlert(admin: Admin, organizationId: string): Promise<void> {
  try {
    // Buyer orgs only, and only if not already alerted this crossing.
    const { data: orgRow } = await admin
      .from("organizations")
      .select("kind, low_balance_alerted_at")
      .eq("id", organizationId)
      .maybeSingle();
    const org = orgRow as { kind?: string | null; low_balance_alerted_at?: string | null } | null;
    if (!org || org.kind !== "buyer" || org.low_balance_alerted_at) return;

    // Threshold (null / 0 = the alert is off).
    const { data: cfg } = await admin
      .from("token_pricing_config")
      .select("low_balance_threshold_tokens")
      .eq("singleton", true)
      .maybeSingle();
    const threshold = (cfg as { low_balance_threshold_tokens?: number | null } | null)?.low_balance_threshold_tokens;
    if (threshold == null || !(threshold > 0)) return;

    // Still above the line? Nothing to do.
    const { data: bal } = await admin
      .from("token_balances")
      .select("available")
      .eq("organization_id", organizationId)
      .maybeSingle();
    const available = Number((bal as { available?: number | null } | null)?.available ?? 0);
    if (available >= threshold) return;

    // Recipient: the buyer user on this org.
    const { data: profRow } = await admin
      .from("profiles")
      .select("email, full_name")
      .eq("organization_id", organizationId)
      .eq("role", "buyer")
      .limit(1)
      .maybeSingle();
    const prof = profRow as { email?: string | null; full_name?: string | null } | null;
    const to = prof?.email?.trim();
    if (!to) return;

    const base = process.env.NEXT_PUBLIC_APP_URL || "https://leadstart-ebon.vercel.app/app";
    const html = buildLowBalanceEmail({
      name: prof?.full_name?.trim() || "",
      available,
      threshold: Number(threshold),
      portalUrl: `${base.replace(/\/$/, "")}/buyer`,
    });
    await sendViaResend({
      from: process.env.EMAIL_FROM || "LeadStart <info@no-reply.leadstart.io>",
      to,
      subject: LOW_BALANCE_SUBJECT,
      html,
    });

    // Stamp only after a successful send, so a transient failure retries next settle.
    await admin
      .from("organizations")
      .update({ low_balance_alerted_at: new Date().toISOString() })
      .eq("id", organizationId);
  } catch (e) {
    console.error("[maybeSendLowBalanceAlert] failed for org", organizationId, e);
  }
}
