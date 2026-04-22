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
import crypto from "node:crypto";
import { createAdminClient } from "@/lib/supabase/admin";

const REPLAY_WINDOW_MS = 5 * 60 * 1000;

interface ResendWebhookPayload {
  type?: string;
  data?: {
    email_id?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
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

  // Map event type → column. Complaints (spam reports) count the same as
  // bounces for our purposes: the client's inbox did NOT deliver our mail
  // to the user's attention, so we shouldn't trust the notification.
  let update: Record<string, string> | null = null;
  if (eventType === "email.delivered") {
    update = { notification_delivered_at: nowIso };
  } else if (
    eventType === "email.bounced" ||
    eventType === "email.complained"
  ) {
    update = { notification_bounced_at: nowIso };
  }

  if (!update) {
    return NextResponse.json({ ignored: true, event_type: eventType });
  }

  const { data: updated, error: updateError } = await admin
    .from("lead_replies")
    .update(update)
    .eq("notification_email_id", emailId)
    .select("id");

  if (updateError) {
    console.error(
      `[webhooks/resend] update failed for email ${emailId}:`,
      updateError,
    );
    return NextResponse.json({ error: updateError.message }, { status: 500 });
  }

  return NextResponse.json({
    event_type: eventType,
    email_id: emailId,
    matched_rows: updated?.length ?? 0,
  });
}
