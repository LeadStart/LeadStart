// GET /api/admin/campaigns/[id]/probe-status
//
// Feeds the campaign builder's placement-probe card: for each mailbox in the
// campaign's sending pool, the latest CAMPAIGN-copy placement test of THIS
// campaign (any status), plus how many seeds are available. Read-only; owner
// or VA (so the card renders on the VA-facing detail page). No probe is started
// here: the run affordance links to Admin → Mailboxes.

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import type { PlacementTest } from "@/types/app";

export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: campaignId } = await params;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const role = user.app_metadata?.role;
  if (role !== "owner" && role !== "va") {
    return NextResponse.json({ error: "Owner or VA role required" }, { status: 403 });
  }
  const organizationId = user.app_metadata?.organization_id as string | undefined;
  if (!organizationId) return NextResponse.json({ error: "No organization" }, { status: 400 });

  const admin = createAdminClient();

  const { data: campaign } = await admin
    .from("campaigns")
    .select("id, organization_id")
    .eq("id", campaignId)
    .maybeSingle();
  const c = campaign as { id: string; organization_id: string } | null;
  if (!c) return NextResponse.json({ error: "Campaign not found" }, { status: 404 });
  if (c.organization_id !== organizationId) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Pool mailboxes.
  const { data: pool } = await admin
    .from("campaign_mailboxes")
    .select("mailbox_id")
    .eq("campaign_id", campaignId);
  const mailboxIds = ((pool ?? []) as { mailbox_id: string }[]).map((r) => r.mailbox_id);

  const [{ data: mbRows }, { count: seedCount }, { data: testRows }] = await Promise.all([
    mailboxIds.length > 0
      ? admin.from("native_mailboxes").select("id, email_address").in("id", mailboxIds)
      : Promise.resolve({ data: [] as { id: string; email_address: string }[] }),
    admin
      .from("seed_inboxes")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", organizationId)
      .eq("status", "active"),
    admin
      .from("placement_tests")
      .select("*")
      .eq("campaign_id", campaignId)
      .eq("probe", "campaign")
      .order("started_at", { ascending: false }),
  ]);

  // Newest campaign-probe test per mailbox (rows ordered newest-first).
  const latestByMailbox = new Map<string, PlacementTest>();
  for (const t of (testRows ?? []) as PlacementTest[]) {
    if (!latestByMailbox.has(t.mailbox_id)) latestByMailbox.set(t.mailbox_id, t);
  }

  const mailboxes = ((mbRows ?? []) as { id: string; email_address: string }[]).map((m) => ({
    mailbox_id: m.id,
    email: m.email_address,
    test: latestByMailbox.get(m.id) ?? null,
  }));

  return NextResponse.json({ seeds_available: seedCount ?? 0, mailboxes });
}
