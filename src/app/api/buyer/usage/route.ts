// GET /api/buyer/usage — the buyer's token consumption history: the money events
// from their ledger (purchases + spends), newest first. Holds/releases are escrow
// mechanics (the dashboard shows "on hold" separately), so they're excluded here.
// Service-role, scoped to the buyer's org.

import { NextResponse } from "next/server";
import { createClient as createServerClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

const LIMIT = 30;

export async function GET() {
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (user.app_metadata?.role !== "buyer") return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const organizationId = user.app_metadata?.organization_id as string | undefined;
  if (!organizationId) return NextResponse.json({ error: "No organization" }, { status: 400 });

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("token_ledger")
    .select("id, entry_type, tokens, search_kind, search_id, notes, created_at")
    .eq("organization_id", organizationId)
    .in("entry_type", ["credit", "charge"])
    .order("created_at", { ascending: false })
    .limit(LIMIT);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ entries: data ?? [] });
}
