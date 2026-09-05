import type { SupabaseClient } from "@supabase/supabase-js";
import { sendViaResend } from "./resend-client";

// Emails the owner when an Apify-driven run (Contacts enrichment or a LinkedIn
// people-search) repeatedly fails and trips its 3-strike circuit breaker,
// i.e. a real, sustained actor problem, not a transient blip. Mirrors the
// webhook-auth-alert pattern: a 1h cooldown per kind (reusing the existing
// webhook_alert_checkpoints table) so a run failing every tick can't spam the
// inbox, and a direct send to a single address. Swallows its own errors so it
// can never mask the failure it's reporting.

const COOLDOWN_MS = 60 * 60 * 1000;
const RECIPIENT =
  process.env.APIFY_ALERT_EMAIL ||
  process.env.OWNER_ALERT_EMAIL ||
  "daniel.tuccillo92@gmail.com";
const FROM = process.env.EMAIL_FROM || "LeadStart <info@no-reply.leadstart.io>";

export type ActorFailureKind = "enrichment" | "linkedin_search" | "maps_search";

const KIND_LABEL: Record<ActorFailureKind, string> = {
  enrichment: "Contacts enrichment",
  linkedin_search: "LinkedIn people search",
  maps_search: "Google Maps business search",
};

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export async function alertActorFailure(
  admin: SupabaseClient,
  input: {
    kind: ActorFailureKind;
    error: string;
    actor?: string | null;
    context?: Record<string, unknown>;
  },
): Promise<void> {
  try {
    if (!process.env.RESEND_API_KEY) return;
    const key = `apify_actor_failure:${input.kind}`;

    // Cooldown: skip if we already alerted for this kind within the window.
    const { data: cp } = await admin
      .from("webhook_alert_checkpoints")
      .select("last_alert_sent_at")
      .eq("endpoint", key)
      .maybeSingle();
    const lastRaw = (cp as { last_alert_sent_at?: string } | null)?.last_alert_sent_at;
    const last = lastRaw ? Date.parse(lastRaw) : 0;
    if (Number.isFinite(last) && Date.now() - last < COOLDOWN_MS) return;

    const label = KIND_LABEL[input.kind];
    const subject = `⚠️ LeadStart: ${label} is failing (Apify)`;
    const ctxRows = Object.entries(input.context ?? {})
      .map(
        ([k, v]) =>
          `<tr><td style="padding:2px 12px 2px 0;color:#64748b">${esc(k)}</td><td style="padding:2px 0"><code>${esc(String(v))}</code></td></tr>`,
      )
      .join("");
    const html = `
      <div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:540px;color:#334155">
        <h2 style="font-size:16px;margin:0 0 8px;color:#0f172a">${label} keeps failing</h2>
        <p style="font-size:14px;margin:0 0 10px">
          A ${label.toLowerCase()} run tripped its circuit breaker (3 consecutive failures)${input.actor ? `: likely an Apify actor issue with <code>${esc(input.actor)}</code>` : ""}. New runs of this type are paused until it recovers.
        </p>
        <p style="font-size:13px;margin:0 0 10px"><strong>Error:</strong> <code>${esc(input.error.slice(0, 300))}</code></p>
        ${ctxRows ? `<table style="font-size:12px;border-collapse:collapse;margin:0 0 10px">${ctxRows}</table>` : ""}
        <p style="font-size:12px;color:#94a3b8;margin:0">No repeat of this alert for an hour. Check the actor's status on Apify and the run in Contacts.</p>
      </div>`;

    await sendViaResend({ from: FROM, to: RECIPIENT, subject, html });

    // Checkpoint AFTER a successful send, so a failed send re-fires next time.
    await admin
      .from("webhook_alert_checkpoints")
      .upsert({ endpoint: key, last_alert_sent_at: new Date().toISOString() }, { onConflict: "endpoint" });
  } catch (e) {
    console.error("[actor-failure-alert] failed to send:", e);
  }
}
