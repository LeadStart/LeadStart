// POST /api/admin/inboxes/delete — permanently delete a sending mailbox
// from Instantly. Owner only (matches the campaign delete pattern — anything
// destructive routes through the same gate). Email is taken from the request
// body to sidestep the path-segment encoding mess that comes with raw email
// addresses (`@`, `.`, `+`).
//
// We don't store inboxes in Supabase — the next page load re-pulls accounts
// straight from Instantly, so there's no local row to clean up.

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { InstantlyClient } from "@/lib/instantly/client";

export async function POST(req: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (user.app_metadata?.role !== "owner") {
    return NextResponse.json({ error: "Owner role required" }, { status: 403 });
  }

  const body = await req.json().catch(() => ({}));
  const email = typeof body?.email === "string" ? body.email.trim() : "";
  if (!email) {
    return NextResponse.json({ error: "email is required" }, { status: 400 });
  }

  const orgId = user.app_metadata?.organization_id;
  if (!orgId) {
    return NextResponse.json({ error: "No organization on user" }, { status: 400 });
  }

  const admin = createAdminClient();
  const { data: org } = await admin
    .from("organizations")
    .select("instantly_api_key")
    .eq("id", orgId)
    .maybeSingle();
  const apiKey = (org as { instantly_api_key: string | null } | null)?.instantly_api_key;
  if (!apiKey) {
    return NextResponse.json(
      { error: "Instantly API key not set on organization." },
      { status: 400 },
    );
  }

  try {
    const client = new InstantlyClient(apiKey);
    await client.deleteAccount(email);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[admin/inboxes/delete] Instantly call failed for ${email}:`, err);
    return NextResponse.json(
      { error: `Instantly rejected the delete: ${message}` },
      { status: 502 },
    );
  }

  return NextResponse.json({ success: true, deleted: email });
}
