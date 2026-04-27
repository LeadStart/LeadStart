// GET /api/admin/clients/[clientId]/linkedin/connect-callback —
// browser-facing landing page Unipile redirects to after the operator
// finishes hosted auth. Reads ?account_id=, persists it to the client
// row, and redirects back to the client detail page.
//
// Security: server-side session check + the user's organization_id
// must match the client's. The clientId is encoded in the URL path,
// so no HMAC is needed for this v0 — re-verifying ownership is enough.
//
// Errors redirect (don't return JSON) since this is a browser-facing
// GET; surfacing a JSON blob would just show {} to the operator.

import { NextRequest, NextResponse } from "next/server";
import { createClient as createServerClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { appUrl } from "@/lib/api-url";

interface RouteParams {
  params: Promise<{ clientId: string }>;
}

function failedRedirect(req: NextRequest, clientId: string, reason: string) {
  return NextResponse.redirect(
    new URL(
      appUrl(`/admin/clients/${clientId}?linkedin=failed&reason=${reason}`),
      req.nextUrl.origin,
    ),
  );
}

export async function GET(req: NextRequest, { params }: RouteParams) {
  const { clientId } = await params;
  const accountId = req.nextUrl.searchParams.get("account_id");

  if (!accountId) {
    return failedRedirect(req, clientId, "missing_account_id");
  }

  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.redirect(
      new URL(
        appUrl(`/login?next=${appUrl(`/admin/clients/${clientId}`)}`),
        req.nextUrl.origin,
      ),
    );
  }
  if (user.app_metadata?.role !== "owner") {
    return failedRedirect(req, clientId, "forbidden");
  }

  const admin = createAdminClient();
  const { data: clientRow } = await admin
    .from("clients")
    .select("id, organization_id")
    .eq("id", clientId)
    .maybeSingle();
  const c = clientRow as { id: string; organization_id: string } | null;
  if (!c) {
    return failedRedirect(req, clientId, "not_found");
  }
  if (c.organization_id !== user.app_metadata?.organization_id) {
    return failedRedirect(req, clientId, "forbidden");
  }

  const { error: updateErr } = await admin
    .from("clients")
    .update({
      unipile_account_id: accountId,
      unipile_account_status: "connected",
    })
    .eq("id", clientId);

  if (updateErr) {
    console.error(
      `[admin/clients/${clientId}/linkedin/connect-callback] update failed:`,
      updateErr,
    );
    return failedRedirect(req, clientId, "save_failed");
  }

  return NextResponse.redirect(
    new URL(
      appUrl(`/admin/clients/${clientId}?linkedin=connected`),
      req.nextUrl.origin,
    ),
  );
}
