// POST /api/admin/clients/[clientId]/linkedin/connect-start —
// owner-only. Generates a Unipile hosted-auth link the operator visits
// to connect this client's LinkedIn account. Returns { url }; the UI
// performs a full-page nav so the success_redirect_url lands the same
// browser session back at our connect-callback handler.

import { NextRequest, NextResponse } from "next/server";
import { createClient as createServerClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { UnipileClient } from "@/lib/unipile/client";
import { appUrl } from "@/lib/api-url";

interface RouteParams {
  params: Promise<{ clientId: string }>;
}

export async function POST(req: NextRequest, { params }: RouteParams) {
  const { clientId } = await params;

  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (user.app_metadata?.role !== "owner") {
    return NextResponse.json({ error: "Owner role required" }, { status: 403 });
  }

  const admin = createAdminClient();
  const { data: clientRow } = await admin
    .from("clients")
    .select("id, organization_id")
    .eq("id", clientId)
    .maybeSingle();
  const c = clientRow as { id: string; organization_id: string } | null;
  if (!c) {
    return NextResponse.json({ error: "Client not found" }, { status: 404 });
  }
  if (c.organization_id !== user.app_metadata?.organization_id) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { data: org } = await admin
    .from("organizations")
    .select("unipile_api_key, unipile_dsn")
    .eq("id", c.organization_id)
    .maybeSingle();
  const o = org as
    | { unipile_api_key: string | null; unipile_dsn: string | null }
    | null;
  if (!o?.unipile_api_key || !o?.unipile_dsn) {
    return NextResponse.json(
      {
        error:
          "Unipile is not configured for this organization. Add the API key and DSN in Settings → Integrations.",
      },
      { status: 400 },
    );
  }

  const origin = req.nextUrl.origin;
  const successUrl = `${origin}${appUrl(`/api/admin/clients/${clientId}/linkedin/connect-callback`)}`;
  const failureUrl = `${origin}${appUrl(`/admin/clients/${clientId}?linkedin=failed`)}`;
  const expiresOn = new Date(Date.now() + 60 * 60 * 1000).toISOString();

  try {
    const client = new UnipileClient(o.unipile_api_key, o.unipile_dsn);
    const link = await client.createHostedAuthLink({
      type: "create",
      expiresOn,
      providers: "LINKEDIN",
      api_url: o.unipile_dsn,
      success_redirect_url: successUrl,
      failure_redirect_url: failureUrl,
      name: clientId,
    });
    return NextResponse.json({ url: link.url });
  } catch (err) {
    console.error(
      `[admin/clients/${clientId}/linkedin/connect-start] Unipile call failed:`,
      err,
    );
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json(
      { error: `Could not start LinkedIn connect: ${message}` },
      { status: 502 },
    );
  }
}
