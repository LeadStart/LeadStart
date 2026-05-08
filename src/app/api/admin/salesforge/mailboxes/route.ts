// GET /api/admin/salesforge/mailboxes
//
// Returns the list of Salesforge sending mailboxes for the org's
// configured workspace. Used by the sequence creator UI to populate
// the "Assign mailboxes" picker. Owner only.

import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { SalesforgeClient } from "@/lib/salesforge/client";

export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (user.app_metadata?.role !== "owner") {
    return NextResponse.json({ error: "Owner role required" }, { status: 403 });
  }

  const organizationId = user.app_metadata?.organization_id;
  if (!organizationId) {
    return NextResponse.json({ error: "No organization on user" }, { status: 400 });
  }

  const admin = createAdminClient();
  const { data: orgData } = await admin
    .from("organizations")
    .select("salesforge_api_key, salesforge_workspace_id")
    .eq("id", organizationId)
    .maybeSingle();
  const org = orgData as
    | { salesforge_api_key: string | null; salesforge_workspace_id: string | null }
    | null;
  if (!org?.salesforge_api_key || !org.salesforge_workspace_id) {
    return NextResponse.json(
      { error: "Salesforge API key or workspace not configured." },
      { status: 400 },
    );
  }

  try {
    const client = new SalesforgeClient(org.salesforge_api_key);
    const mailboxes = await client.listMailboxes(org.salesforge_workspace_id);
    return NextResponse.json({ mailboxes });
  } catch (err) {
    return NextResponse.json(
      { error: `Failed to load mailboxes: ${err instanceof Error ? err.message : String(err)}` },
      { status: 502 },
    );
  }
}
