// POST /app/api/webhooks/resend — Resend delivery webhook receiver.
//
// Subscribes to Resend's email.delivered / email.bounced / email.complained
// events so we can distinguish "Resend accepted our send" (notified_at,
// written at send time) from "the client's inbox actually received it"
// (notification_delivered_at) or "the send silently bounced"
// (notification_bounced_at). Without this, a notification that Resend
// accepted but the client's mail server rejected leaves the hot-lead
// pipeline looking fine from our side while the client never sees it.
//
// Security: Resend signs webhooks using Svix's scheme — headers
// svix-id / svix-timestamp / svix-signature. We compute HMAC-SHA256 of
// `${id}.${timestamp}.${rawBody}` with the signing secret (base64 payload
// of RESEND_WEBHOOK_SECRET's whsec_… prefix) and compare in constant
// time against each candidate signature in svix-signature. Events older
// than 5 min are rejected to thwart replay.
//
// No-op behavior: until RESEND_WEBHOOK_SECRET is set in the environment,
// every request is rejected with 401. That's the safe default — better
// to drop events than to trust unverified webhook input.

import { NextRequest, NextResponse } from "next/server";
import { after } from "next/server";
import crypto from "node:crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { recordWebhookAuthFailure } from "@/lib/notifications/webhook-auth-alerts";
import { enqueueOwnerAlert } from "@/lib/notifications/owner-alerts";

const REPLAY_WINDOW_MS = 5 * 60 * 1000;

interface ResendWebhookPayload {
  type?: string;
  data?: {
    email_id?: string;
    to?: string | string[];
    bounce?: {
      // Resend marks Permanent for hard bounces, Transient for soft.
      // Field absent on older payloads — see classifyBounce() below.
      type?: string;
      subType?: string;
      message?: string;
    };
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

interface BounceClassification {
  isHardBounce: boolean;
  subtype: string | null;
  message: string | null;
}

/**
 * Decide whether a bounce event is hard (alertable) or soft (Resend will
 * retry — stay quiet). Conservative default: if Resend doesn't include a
 * bounce.type, treat as hard so the operator hears about it. The
 * alternative — silently swallow ambiguous events — is the failure mode
 * this whole feature is trying to fix.
 */
function classifyBounce(payload: ResendWebhookPayload): BounceClassification {
  const bounce = payload.data?.bounce;
  const rawType = bounce?.type?.toLowerCase() ?? null;
  const isHardBounce =
    rawType === null ||
    rawType === "permanent" ||
    rawType === "hard" ||
    rawType === "undetermined";
  return {
    isHardBounce,
    subtype: bounce?.subType ?? null,
    message: bounce?.message ?? null,
  };
}

function recipientFromPayload(payload: ResendWebhookPayload): string | null {
  const to = payload.data?.to;
  if (typeof to === "string") return to;
  if (Array.isArray(to) && to.length > 0) return to[0];
  return null;
}

function verifySvixSignature(input: {
  rawBody: string;
  svixId: string | null;
  svixTimestamp: string | null;
  svixSignature: string | null;
  secret: string;
}): boolean {
  const { rawBody, svixId, svixTimestamp, svixSignature, secret } = input;
  if (!svixId || !svixTimestamp || !svixSignature) return false;

  // Replay-window check. Svix timestamps are seconds since epoch.
  const tsSeconds = Number(svixTimestamp);
  if (!Number.isFinite(tsSeconds)) return false;
  const tsMs = tsSeconds * 1000;
  if (Math.abs(Date.now() - tsMs) > REPLAY_WINDOW_MS) return false;

  // Secret shape: whsec_<base64>. Decode to get the raw HMAC key.
  const secretBase64 = secret.startsWith("whsec_")
    ? secret.slice("whsec_".length)
    : secret;
  let secretBytes: Buffer;
  try {
    secretBytes = Buffer.from(secretBase64, "base64");
  } catch {
    return false;
  }
  if (secretBytes.length === 0) return false;

  const signedContent = `${svixId}.${svixTimestamp}.${rawBody}`;
  const expected = crypto
    .createHmac("sha256", secretBytes)
    .update(signedContent)
    .digest("base64");

  // svix-signature format: "v1,<base64> v1,<base64>" (space-separated for
  // key rotation). Any matching element counts.
  const candidates = svixSignature.split(" ");
  for (const candidate of candidates) {
    const [version, sig] = candidate.split(",");
    if (version !== "v1" || !sig) continue;
    const expectedBuf = Buffer.from(expected);
    const sigBuf = Buffer.from(sig);
    if (
      expectedBuf.length === sigBuf.length &&
      crypto.timingSafeEqual(expectedBuf, sigBuf)
    ) {
      return true;
    }
  }
  return false;
}

export async function POST(request: NextRequest) {
  const secret = process.env.RESEND_WEBHOOK_SECRET;
  if (!secret) {
    return NextResponse.json(
      { error: "Webhook not configured" },
      { status: 401 },
    );
  }

  // Read body as text first — signature verification needs the exact raw
  // bytes. Re-parse as JSON after verification succeeds.
  const rawBody = await request.text();

  const valid = verifySvixSignature({
    rawBody,
    svixId: request.headers.get("svix-id"),
    svixTimestamp: request.headers.get("svix-timestamp"),
    svixSignature: request.headers.get("svix-signature"),
    secret,
  });
  if (!valid) {
    // D1: log + alert on sustained invalid-signature bursts. Missing-env
    // 401 above intentionally does NOT log (operator config error would
    // flood the table; handled inline with 401 + no side effects).
    after(async () => {
      try {
        await recordWebhookAuthFailure({
          admin: createAdminClient(),
          endpoint: "/api/webhooks/resend",
          reason: "invalid_signature",
          request,
        });
      } catch (err) {
        console.error(
          "[webhooks/resend] recordWebhookAuthFailure threw:",
          err,
        );
      }
    });
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  let payload: ResendWebhookPayload;
  try {
    payload = JSON.parse(rawBody) as ResendWebhookPayload;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const eventType = payload.type;
  const emailId = payload.data?.email_id;
  if (!eventType || !emailId) {
    // Not an event we care about — respond 200 so Resend doesn't retry.
    return NextResponse.json({ ignored: true, reason: "missing_fields" });
  }

  const admin = createAdminClient();
  const nowIso = new Date().toISOString();

  // Map event type → column updates. Complaints (spam reports) count the
  // same as bounces for delivery-state purposes: the client's inbox did
  // NOT show our mail, so we shouldn't trust the send.
  let leadReplyUpdate: Record<string, string> | null = null;
  let kpiReportUpdate: Record<string, string | null> | null = null;
  if (eventType === "email.delivered") {
    leadReplyUpdate = { notification_delivered_at: nowIso };
    kpiReportUpdate = { delivered_at: nowIso };
  } else if (
    eventType === "email.bounced" ||
    eventType === "email.complained"
  ) {
    leadReplyUpdate = { notification_bounced_at: nowIso };
    kpiReportUpdate = {
      bounced_at: nowIso,
      bounce_type: eventType === "email.complained" ? "complaint" : "bounce",
    };
  }

  if (!leadReplyUpdate || !kpiReportUpdate) {
    return NextResponse.json({ ignored: true, event_type: eventType });
  }

  // Try lead_replies first — that's the high-volume path. If we don't match,
  // fall through to kpi_reports. Either match (or none) is normal: the same
  // email_id can only live in one of the two tables.
  const { data: leadMatches, error: leadError } = await admin
    .from("lead_replies")
    .update(leadReplyUpdate)
    .eq("notification_email_id", emailId)
    .select("id, client_id");

  if (leadError) {
    console.error(
      `[webhooks/resend] lead_replies update failed for email ${emailId}:`,
      leadError,
    );
    return NextResponse.json({ error: leadError.message }, { status: 500 });
  }

  const leadMatched = (leadMatches?.length ?? 0) > 0;

  const { data: reportMatches, error: reportError } = leadMatched
    ? { data: [], error: null }
    : await admin
        .from("kpi_reports")
        .update(kpiReportUpdate)
        .eq("resend_email_id", emailId)
        .select("id, client_id");

  if (reportError) {
    console.error(
      `[webhooks/resend] kpi_reports update failed for email ${emailId}:`,
      reportError,
    );
    return NextResponse.json({ error: reportError.message }, { status: 500 });
  }

  const reportMatched = (reportMatches?.length ?? 0) > 0;

  // Severity filter for the owner alert: hard bounces and complaints only.
  // Soft bounces fall through to the digest as informational? — no: by user
  // policy soft bounces stay silent (Resend retries internally; we don't
  // want digest noise on transient inbox-full / greylist events).
  if (eventType === "email.bounced" || eventType === "email.complained") {
    const recipient = recipientFromPayload(payload);
    const { isHardBounce, subtype, message } = classifyBounce(payload);
    const isComplaint = eventType === "email.complained";

    if (isHardBounce || isComplaint) {
      const matchKind = leadMatched
        ? "hot_lead_notification"
        : reportMatched
          ? "kpi_report"
          : "unknown";
      const alertKind = isComplaint ? "email_complaint" : "email_hard_bounce";
      const subjectVerb = isComplaint ? "Complaint received" : "Hard bounce";
      const subject = `${subjectVerb} on ${matchKind} email${recipient ? ` to ${recipient}` : ""}`;
      after(async () => {
        try {
          await enqueueOwnerAlert({
            admin,
            kind: alertKind,
            subject,
            summary:
              `${subjectVerb} for ${matchKind} email` +
              (recipient ? ` to ${recipient}` : "") +
              (message ? `: ${message}` : "."),
            context: {
              email_id: emailId,
              recipient: recipient ?? "(unknown)",
              event_type: eventType,
              bounce_type: subtype ?? "(not provided)",
              match_kind: matchKind,
              row_id:
                (leadMatches?.[0] as { id?: string } | undefined)?.id ??
                (reportMatches?.[0] as { id?: string } | undefined)?.id ??
                "(no row matched)",
            },
          });
        } catch (err) {
          console.error("[webhooks/resend] enqueueOwnerAlert threw:", err);
        }
      });
    }
  }

  return NextResponse.json({
    event_type: eventType,
    email_id: emailId,
    matched_lead_replies: leadMatches?.length ?? 0,
    matched_kpi_reports: reportMatches?.length ?? 0,
  });
}
