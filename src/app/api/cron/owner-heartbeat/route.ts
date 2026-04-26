// GET /app/api/cron/owner-heartbeat — runs once daily (vercel.json: 0 13 * * *,
// = 09:00 ET in EDT / 08:00 ET in EST). Sends a status email to every owner
// profile so the operator knows the alert pipeline is alive.
//
// Why daily-only: the heartbeat is a beacon, not a dashboard. If we sent it
// hourly, you'd ignore it; if you ignore it, the "I notice when it stops"
// signal stops working. Once a day is enough to detect a multi-day outage.
//
// Sends directly via sendViaResend (NOT through the owner_alerts queue).
// Heartbeats are routine and shouldn't get coalesced into alert digests.

import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { buildHeartbeat } from "@/lib/notifications/owner-heartbeat";
import { getOwnerRecipients } from "@/lib/notifications/owner-alerts";
import {
  sendViaResend,
  MissingResendKeyError,
  RateLimitedError,
  TransientResendError,
  PermanentResendError,
} from "@/lib/notifications/resend-client";

export async function GET(request: NextRequest) {
  if (
    process.env.CRON_SECRET &&
    request.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`
  ) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const admin = createAdminClient();
  const recipients = await getOwnerRecipients(admin);
  if (recipients.length === 0) {
    return NextResponse.json({
      sent: false,
      reason: "no_owner_recipients",
    });
  }

  const { subject, html, verdict } = await buildHeartbeat(admin);

  if (!process.env.RESEND_API_KEY) {
    return NextResponse.json({
      sent: false,
      reason: "missing_resend_key",
      verdict,
    });
  }

  try {
    await sendViaResend({
      from: process.env.EMAIL_FROM || "LeadStart <info@no-reply.leadstart.io>",
      to: recipients,
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
    console.error(`[owner-heartbeat] Send failed (${cls}):`, err);
    return NextResponse.json(
      { sent: false, reason: `resend_failed:${cls}`, verdict },
      { status: 500 },
    );
  }

  return NextResponse.json({
    sent: true,
    recipients,
    verdict,
    subject,
  });
}
