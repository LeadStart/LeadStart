// One-time Instantly webhook registration (owner-only).
//
// Computes the receiver URL from NEXT_PUBLIC_APP_URL (which already includes
// the /app basePath — see src/lib/notifications/send-hot-lead.ts), posts to
// Instantly's POST /api/v2/webhooks via the org's API key, and stores the
// returned id on organizations.instantly_webhook_id so the settings UI can
// reflect state.
//
// Idempotent: if instantly_webhook_id is already set we short-circuit and
// return it — re-registering just creates a duplicate subscription on
// Instantly's side.

import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { InstantlyClient } from "@/lib/instantly/client";

export async function POST() {
  // --- Auth: owner-only ---
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (user.app_metadata?.role !== "owner") {
    return NextResponse.json({ error: "Owner role required" }, { status: 403 });
  }
  const organizationId = user.app_metadata?.organization_id as string | undefined;
  if (!organizationId) {
    return NextResponse.json({ error: "No organization on user" }, { status: 400 });
  }

  const admin = createAdminClient();
  const { data: orgData, error: orgError } = await admin
    .from("organizations")
    .select("id, instantly_api_key, instantly_webhook_id")
    .eq("id", organizationId)
    .maybeSingle();
  if (orgError || !orgData) {
    return NextResponse.json({ error: "Organization not found" }, { status: 404 });
  }
  const org = orgData as {
    id: string;
    instantly_api_key: string | null;
    instantly_webhook_id: string | null;
  };

  // Already registered — no-op, return existing id so the UI can reflect state.
  if (org.instantly_webhook_id) {
    return NextResponse.json({
      success: true,
      already_registered: true,
      webhook_id: org.instantly_webhook_id,
    });
  }

  if (!org.instantly_api_key) {
    return NextResponse.json(
      { error: "Instantly API key not set. Save it in the API settings first." },
      { status: 400 },
    );
  }

  // --- Build the receiver URL ---
  const appUrl = process.env.NEXT_PUBLIC_APP_URL;
  if (!appUrl) {
    return NextResponse.json(
      { error: "NEXT_PUBLIC_APP_URL is not set — cannot determine the webhook target." },
      { status: 500 },
    );
  }
  if (!/^https?:\/\//.test(appUrl)) {
    return NextResponse.json(
      { error: "NEXT_PUBLIC_APP_URL must be absolute (include http:// or https://)." },
      { status: 500 },
    );
  }
  if (/localhost|127\.0\.0\.1/.test(appUrl)) {
    return NextResponse.json(
      {
        error:
          "Refusing to register a localhost webhook URL — Instantly can't reach it. Deploy to production first.",
      },
      { status: 400 },
    );
  }

  // The receiver validates ?secret=… against INSTANTLY_WEBHOOK_SECRET when
  // that env var is set (per-channel secret, matching UNIPILE_WEBHOOK_SECRET).
  const secret = process.env.INSTANTLY_WEBHOOK_SECRET;
  const base = appUrl.replace(/\/$/, "");
  const webhookUrl = secret
    ? `${base}/api/webhooks/instantly?secret=${encodeURIComponent(secret)}`
    : `${base}/api/webhooks/instantly`;

  // --- Call Instantly ---
  let created;
  try {
    const instantly = new InstantlyClient(org.instantly_api_key);
    created = await instantly.createWebhook({
      event_type: "all_events",
      target_hook_url: webhookUrl,
      name: "LeadStart — reply routing",
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[instantly/register-webhook] createWebhook failed:", err);
    return NextResponse.json(
      { error: `Instantly rejected the registration: ${message}` },
      { status: 502 },
    );
  }

  // --- Persist the webhook id ---
  const { error: updateError } = await admin
    .from("organizations")
    .update({ instantly_webhook_id: created.id })
    .eq("id", org.id);
  if (updateError) {
    console.error("[instantly/register-webhook] failed to store webhook id:", updateError);
    return NextResponse.json(
      {
        // Surface the id so the owner can record it manually — the
        // subscription IS live on Instantly's side even if this write failed.
        error: "Registered with Instantly but failed to record the id locally.",
        webhook_id: created.id,
      },
      { status: 500 },
    );
  }

  return NextResponse.json({
    success: true,
    already_registered: false,
    webhook_id: created.id,
    url: webhookUrl,
  });
}
