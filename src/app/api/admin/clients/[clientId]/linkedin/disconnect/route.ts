// POST /api/admin/clients/[clientId]/linkedin/disconnect — owner-only.
// Clears the Unipile binding on this client (account_id null + status
// 'disconnected'). Does NOT call Unipile to delete the remote account
// — keeping it lets us reconnect without a fresh OAuth dance, and the
// user can revoke from LinkedIn directly if they want a hard reset.

import { NextRequest, NextResponse } from "next/server";
import { createClient as createServerClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

interface RouteParams {
  params: Promise<{ clientId: string }>;
}

export async function POST(_req: NextRequest, { params }: RouteParams) {
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

  const { error: updateErr } = await admin
    .from("clients")
    .update({
      unipile_account_id: null,
      unipile_account_status: "disconnected",
    })
    .eq("id", clientId);

  if (updateErr) {
    console.error(
      `[admin/clients/${clientId}/linkedin/disconnect] update failed:`,
      updateErr,
    );
    return NextResponse.json(
      { error: "Failed to disconnect" },
      { status: 500 },
    );
  }

  return NextResponse.json({ success: true });
}
