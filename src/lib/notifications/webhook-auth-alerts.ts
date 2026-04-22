// D1 — 401 alerting on webhook endpoints.
//
// Called from /api/webhooks/instantly and /api/webhooks/resend whenever a
// request is rejected with 401 for a reason that represents a real auth
// failure (bad_secret / invalid_signature) — NOT missing env. Missing env
// is an operator config error and would flood this table; it's handled
// inline at the handler with console.error + 401.
//
// Flow per call:
//   1. Log the failure into webhook_auth_failures (ip + user_agent from headers).
//   2. COUNT rows for this endpoint in the last 10 minutes.
//   3. If count >= 5 AND the cooldown for this endpoint has elapsed
//      (webhook_alert_checkpoints.last_alert_sent_at older than 1h ago),
//      fire a single alert email to OWNER_ALERT_EMAIL via the C1 throttled
//      Resend wrapper. Upsert the checkpoint on send-success.
//
// Per SAFETY-TODO Phase D1: alerts do NOT go through the retry queue. A
// failed alert is fine to drop — the underlying problem re-triggers the
// alert on the next failure within the 10min window.
//
// Race: two concurrent threshold crossings can both pass the cooldown
// check and send duplicate alerts (checkpoint is only written after send).
// This is accepted — duplicates in a burst are less bad than a dropped
// alert from a checkpoint-first / send-failure sequence.

import { isIP } from "node:net";
import type { NextRequest } from "next/server";
import type { createAdminClient } from "@/lib/supabase/admin";
import {
  sendViaResend,
  MissingResendKeyError,
  RateLimitedError,
  TransientResendError,
  PermanentResendError,
} from "./resend-client";

const THRESHOLD = 5;
const WINDOW_MINUTES = 10;
const COOLDOWN_MS = 60 * 60 * 1000;

export type WebhookAuthEndpoint =
  | "/api/webhooks/instantly"
  | "/api/webhooks/resend";

export interface WebhookAuthFailureInput {
  admin: ReturnType<typeof createAdminClient>;
  endpoint: WebhookAuthEndpoint;
  reason: string;
  request: NextRequest;
}

function parseClientIp(request: NextRequest): string | null {
  const xff = request.headers.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first && isIP(first) !== 0) return first;
  }
  const xri = request.headers.get("x-real-ip")?.trim();
  if (xri && isIP(xri) !== 0) return xri;
  return null;
}

export async function recordWebhookAuthFailure(
  input: WebhookAuthFailureInput,
): Promise<void> {
  const { admin, endpoint, reason, request } = input;
  const ip = parseClientIp(request);
  const userAgent = request.headers.get("user-agent") ?? null;

  const { error: insertError } = await admin
    .from("webhook_auth_failures")
    .insert({ endpoint, reason, ip, user_agent: userAgent });

  if (insertError) {
    console.error(
      `[webhook-auth-alert] failed to log auth failure for ${endpoint}:`,
      insertError,
    );
    return;
  }

  const sinceIso = new Date(Date.now() - WINDOW_MINUTES * 60 * 1000).toISOString();
  const { count: failureCount, error: countError } = await admin
    .from("webhook_auth_failures")
    .select("id", { count: "exact", head: true })
    .eq("endpoint", endpoint)
    .gte("created_at", sinceIso);

  if (countError) {
    console.error(
      `[webhook-auth-alert] count failed for ${endpoint}:`,
      countError,
    );
    return;
  }
  if ((failureCount ?? 0) < THRESHOLD) return;

  const { data: checkpoint, error: checkpointError } = await admin
    .from("webhook_alert_checkpoints")
    .select("last_alert_sent_at")
    .eq("endpoint", endpoint)
    .maybeSingle();

  if (checkpointError) {
    console.error(
      `[webhook-auth-alert] checkpoint lookup failed for ${endpoint}:`,
      checkpointError,
    );
    // Fall through — prefer a possible duplicate alert to a missed one.
  }

  const lastAlertIso =
    (checkpoint as { last_alert_sent_at: string } | null)?.last_alert_sent_at ??
    null;
  const lastAlertMs = lastAlertIso ? Date.parse(lastAlertIso) : null;
  if (lastAlertMs !== null && Date.now() - lastAlertMs < COOLDOWN_MS) return;

  const { data: rows, error: rowsError } = await admin
    .from("webhook_auth_failures")
    .select("created_at, ip, user_agent")
    .eq("endpoint", endpoint)
    .gte("created_at", sinceIso)
    .order("created_at", { ascending: true });

  if (rowsError || !rows) {
    console.error(
      `[webhook-auth-alert] summary fetch failed for ${endpoint}:`,
      rowsError,
    );
    return;
  }

  const count = failureCount ?? rows.length;
  const firstAt = (rows[0] as { created_at: string } | undefined)?.created_at ?? null;
  const lastAt =
    (rows[rows.length - 1] as { created_at: string } | undefined)?.created_at ??
    null;
  const ipStrings = rows
    .map((r) => (r as { ip: string | null }).ip)
    .filter((v): v is string => !!v);
  const uaStrings = rows
    .map((r) => (r as { user_agent: string | null }).user_agent)
    .filter((v): v is string => !!v);
  const topIps = topN(ipStrings, 5);
  const topUAs = topN(uaStrings, 5);

  const cooldownExpiryIso = new Date(Date.now() + COOLDOWN_MS).toISOString();
  const subject = `[LeadStart alert] ${count} auth failures on ${endpoint} in last 10min`;
  const html = buildAlertHtml({
    endpoint,
    reason,
    count,
    firstAt,
    lastAt,
    topIps,
    topUAs,
    cooldownExpiryIso,
  });

  const ownerEmail = process.env.OWNER_ALERT_EMAIL;
  if (!ownerEmail) {
    console.error(
      `[webhook-auth-alert] OWNER_ALERT_EMAIL is not set — alert path inert for ${endpoint} (count=${count}). Set the env to enable email alerts.`,
    );
    // Do NOT stamp checkpoint: once the env is configured, the next failure
    // should trigger a real alert immediately rather than wait for cooldown.
    return;
  }

  const fromAddress =
    process.env.EMAIL_FROM || "LeadStart <info@no-reply.leadstart.io>";

  try {
    await sendViaResend({
      from: fromAddress,
      to: ownerEmail,
      subject,
      html,
    });
  } catch (err) {
    const cls =
      err instanceof MissingResendKeyError
        ? "MissingResendKey"
        : err instanceof RateLimitedError
          ? "RateLimited"
          : err instanceof TransientResendError
            ? "Transient"
            : err instanceof PermanentResendError
              ? "Permanent"
              : "Unknown";
    console.error(
      `[webhook-auth-alert] Resend send failed (${cls}) for ${endpoint}; checkpoint NOT updated so next failure can retry the alert:`,
      err,
    );
    return;
  }

  const { error: upsertError } = await admin
    .from("webhook_alert_checkpoints")
    .upsert(
      { endpoint, last_alert_sent_at: new Date().toISOString() },
      { onConflict: "endpoint" },
    );
  if (upsertError) {
    console.error(
      `[webhook-auth-alert] Alert sent but checkpoint upsert failed for ${endpoint} (cooldown may not apply):`,
      upsertError,
    );
  }
}

function topN(
  values: string[],
  n: number,
): Array<{ value: string; count: number }> {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([value, count]) => ({ value, count }));
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function buildAlertHtml(input: {
  endpoint: string;
  reason: string;
  count: number;
  firstAt: string | null;
  lastAt: string | null;
  topIps: Array<{ value: string; count: number }>;
  topUAs: Array<{ value: string; count: number }>;
  cooldownExpiryIso: string;
}): string {
  const { endpoint, reason, count, firstAt, lastAt, topIps, topUAs, cooldownExpiryIso } = input;
  const ipsList = topIps.length
    ? topIps
        .map(
          (r) =>
            `<li><code>${escapeHtml(r.value)}</code> — ${r.count}</li>`,
        )
        .join("")
    : "<li><em>(no IP captured)</em></li>";
  const uasList = topUAs.length
    ? topUAs
        .map(
          (r) =>
            `<li><code>${escapeHtml(r.value)}</code> — ${r.count}</li>`,
        )
        .join("")
    : "<li><em>(no user-agent captured)</em></li>";
  return `
<div style="font-family: system-ui, -apple-system, Segoe UI, sans-serif; color: #111; max-width: 640px;">
  <h2 style="margin:0 0 12px;color:#b91c1c;">Webhook auth failure alert</h2>
  <p style="margin:0 0 12px;">
    <strong>${count}</strong> failed requests hit
    <code>${escapeHtml(endpoint)}</code> in the last 10 minutes
    (reason: <code>${escapeHtml(reason)}</code>).
  </p>
  <table style="border-collapse:collapse;margin:0 0 16px;">
    <tbody>
      <tr><td style="padding:4px 12px 4px 0;color:#555;">First failure</td><td><code>${escapeHtml(firstAt ?? "\u2014")}</code></td></tr>
      <tr><td style="padding:4px 12px 4px 0;color:#555;">Last failure</td><td><code>${escapeHtml(lastAt ?? "\u2014")}</code></td></tr>
      <tr><td style="padding:4px 12px 4px 0;color:#555;">Next alert no earlier than</td><td><code>${escapeHtml(cooldownExpiryIso)}</code></td></tr>
    </tbody>
  </table>
  <h3 style="margin:0 0 6px;font-size:14px;">Top source IPs</h3>
  <ul style="margin:0 0 16px;padding-left:20px;">${ipsList}</ul>
  <h3 style="margin:0 0 6px;font-size:14px;">Top user-agents</h3>
  <ul style="margin:0 0 16px;padding-left:20px;">${uasList}</ul>
  <p style="margin:16px 0 0;color:#555;font-size:13px;">
    Likely causes: a misconfigured WEBHOOK_SECRET deploy, a stale Instantly webhook registration,
    or automated probing. Investigate the <code>webhook_auth_failures</code> table for details.
    No further alerts will fire for this endpoint until the cooldown expires.
  </p>
</div>`.trim();
}
