// POST /api/admin/salesforge/sequences/[id]/register-webhooks
//
// Idempotently registers the 7 reply-pipeline webhooks against an
// existing Salesforge sequence. Used when:
//   - A sequence was created outside our UI (in Salesforge's dashboard)
//     and the LeadStart admin wants the reply pipeline wired up.
//   - The webhook URL changes (e.g. a new WEBHOOK_SECRET deploy) and
//     we want to register the new URL.
//
// `[id]` is the LOCAL campaigns.id (LeadStart's UUID), not the
// salesforge_sequence_id — keeps the URL consistent with other admin
// routes that key off our DB id. Owner only.

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { SalesforgeClient } from "@/lib/salesforge/client";
import { registerSequenceWebhooks } from "@/lib/salesforge/webhooks";

function resolveWebhookUrl(): string | null {
  const secret = process.env.WEBHOOK_SECRET;
  if (!secret) return null;
  const explicit = process.env.NEXT_PUBLIC_APP_URL;
  const vercel = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null;
  const base = explicit || vercel || "http://localhost:3000";
  const cleanBase = base.replace(/\/$/, "");
  return `${cleanBase}/app/api/webhooks/salesforge?secret=${encodeURIComponent(secret)}`;
}

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: campaignId } = await params;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (user.app_metadata?.role !== "owner") {
    return NextResponse.json({ error: "Owner role required" }, { status: 403 });
  }

  const admin = createAdminClient();
  const { data: campaign } = await admin
    .from("campaigns")
    .select("id, organization_id, source_channel, salesforge_sequence_id")
    .eq("id", campaignId)
    .maybeSingle();
  const c = campaign as
    | {
        id: string;
        organization_id: string;
        source_channel: string;
        salesforge_sequence_id: string | null;
      }
    | null;
  if (!c) {
    return NextResponse.json({ error: "Campaign not found" }, { status: 404 });
  }
  if (c.organization_id !== user.app_metadata?.organization_id) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (c.source_channel !== "salesforge") {
    return NextResponse.json(
      { error: `This route is Salesforge-only. Campaign source_channel is ${c.source_channel}.` },
      { status: 400 },
    );
  }
  if (!c.salesforge_sequence_id) {
    return NextResponse.json(
      { error: "Campaign has no salesforge_sequence_id." },
      { status: 400 },
    );
  }

  const { data: orgData } = await admin
    .from("organizations")
    .select("salesforge_api_key, salesforge_workspace_id")
    .eq("id", c.organization_id)
    .maybeSingle();
  const org = orgData as
    | {
        salesforge_api_key: string | null;
        salesforge_workspace_id: string | null;
      }
    | null;
  if (!org?.salesforge_api_key) {
    return NextResponse.json(
      { error: "Salesforge API key not set on organization." },
      { status: 400 },
    );
  }
  if (!org.salesforge_workspace_id) {
    return NextResponse.json(
      { error: "Salesforge workspace not selected on organization." },
      { status: 400 },
    );
  }

  const callbackUrl = resolveWebhookUrl();
  if (!callbackUrl) {
    return NextResponse.json(
      { error: "WEBHOOK_SECRET env var not set; cannot construct callback URL." },
      { status: 500 },
    );
  }

  try {
    const result = await registerSequenceWebhooks({
      client: new SalesforgeClient(org.salesforge_api_key),
      workspaceId: org.salesforge_workspace_id,
      sequenceId: c.salesforge_sequence_id,
      callbackUrl,
    });
    return NextResponse.json({ success: true, ...result });
  } catch (err) {
    return NextResponse.json(
      { error: `registerSequenceWebhooks failed: ${err instanceof Error ? err.message : String(err)}` },
      { status: 502 },
    );
  }
}
