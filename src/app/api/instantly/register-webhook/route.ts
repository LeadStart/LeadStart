// One-time Instantly webhook registration.
//
// Owner-only POST. Computes the webhook URL from NEXT_PUBLIC_APP_URL
// (which varies per Vercel env), posts to /api/v2/webhooks via the org's
// Instantly API key, and stores the returned id on
// organizations.instantly_webhook_id so the admin UI can disable the
// button afterwards.
//
// Idempotency is UI-driven: if instantly_webhook_id is already set, we
// short-circuit and return the existing id. Re-registering would just
// create a duplicate subscription on Instantly's side.

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { InstantlyClient } from "@/lib/instantly/client";

export async function POST(request: NextRequest) {
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

  const organizationId = user.app_metadata?.organization_id;
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
      { status: 400 }
    );
  }

  // --- Build the webhook URL ---
  // NEXT_PUBLIC_APP_URL already includes the /app basePath (see
  // src/lib/api-url.ts). The webhook handler validates ?secret=... against
  // WEBHOOK_SECRET, so we pass it in the URL rather than relying on
  // Instantly's signing (which isn't uniformly supported across their
  // webhook delivery paths).
  const appUrl = process.env.NEXT_PUBLIC_APP_URL;
  if (!appUrl) {
    return NextResponse.json(
      { error: "NEXT_PUBLIC_APP_URL is not set — cannot determine webhook target." },
      { status: 500 }
    );
  }
  if (!/^https?:\/\//.test(appUrl)) {
    return NextResponse.json(
      { error: "NEXT_PUBLIC_APP_URL must be absolute (include http:// or https://)." },
      { status: 500 }
    );
  }
  if (/localhost|127\.0\.0\.1/.test(appUrl)) {
    return NextResponse.json(
      {
        error:
          "Refusing to register a localhost webhook URL. Instantly can't reach it. Deploy to staging or production first.",
      },
      { status: 400 }
    );
  }

  const webhookSecret = process.env.WEBHOOK_SECRET;
  const webhookUrl = webhookSecret
    ? `${appUrl.replace(/\/$/, "")}/api/webhooks/instantly?secret=${encodeURIComponent(webhookSecret)}`
    : `${appUrl.replace(/\/$/, "")}/api/webhooks/instantly`;

  // --- Call Instantly ---
  let created;
  try {
    const instantly = new InstantlyClient(org.instantly_api_key);
    created = await instantly.createWebhook({
      event_type: "all_events",
      url: webhookUrl,
      secret: webhookSecret, // some Instantly accounts sign with this; handler accepts either path
      name: "LeadStart — reply routing",
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[register-webhook] Instantly createWebhook failed:", err);
    return NextResponse.json(
      { error: `Instantly rejected the registration: ${message}` },
      { status: 502 }
    );
  }

  // --- Persist the webhook id ---
  const { error: updateError } = await admin
    .from("organizations")
    .update({ instantly_webhook_id: created.id })
    .eq("id", org.id);
  if (updateError) {
    console.error("[register-webhook] Failed to store webhook id:", updateError);
    return NextResponse.json(
      {
        // Still surface the id so the admin can record it manually if the
        // DB write fails — the subscription IS live on Instantly's side.
        error: "Registered with Instantly but failed to record id locally.",
        webhook_id: created.id,
      },
      { status: 500 }
    );
  }

  return NextResponse.json({
    success: true,
    already_registered: false,
    webhook_id: created.id,
    url: webhookUrl,
  });
}
