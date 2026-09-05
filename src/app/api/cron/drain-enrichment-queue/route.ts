import { NextRequest, NextResponse } from "next/server";
import { checkCronAuth } from "@/lib/security/cron-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { enqueueEnrichment } from "@/lib/apify/enqueue-enrichment";

// GET /api/cron/drain-enrichment-queue: every minute.
//
// The queue-behind drain. Imports made while an enrichment run was already
// active for the org are stamped contacts.enrich_queued_at (enqueue-enrichment).
// This drains ONE org per tick: pick the org with the oldest queued contact,
// and if it now has no active run, start a run for its queued contacts.

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const MAX_CONTACTS = 2000;

export async function GET(request: NextRequest) {
  const authError = checkCronAuth(request);
  if (authError) return authError;

  const admin = createAdminClient();

  // Oldest queued contact → the org we drain this tick.
  const { data: head } = await admin
    .from("contacts")
    .select("organization_id")
    .not("enrich_queued_at", "is", null)
    .order("enrich_queued_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (!head) return NextResponse.json({ status: "idle" });

  const organizationId = (head as { organization_id: string }).organization_id;

  // Still busy → leave it queued for a later tick.
  const { data: active } = await admin
    .from("enrichment_runs")
    .select("id")
    .eq("organization_id", organizationId)
    .in("status", ["pending", "running"])
    .limit(1);
  if (active && active.length > 0) {
    return NextResponse.json({ status: "org_busy", organization_id: organizationId });
  }

  const { data: queued } = await admin
    .from("contacts")
    .select("id")
    .eq("organization_id", organizationId)
    .not("enrich_queued_at", "is", null)
    .limit(MAX_CONTACTS);
  const contactIds = ((queued as { id: string }[] | null) ?? []).map((r) => r.id);
  if (contactIds.length === 0) return NextResponse.json({ status: "idle" });

  // Attribute the auto-run to the org owner.
  const { data: owner } = await admin
    .from("profiles")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("role", "owner")
    .limit(1)
    .maybeSingle();
  const userId = (owner as { id: string } | null)?.id;
  if (!userId) {
    // No owner to attribute a run to: clear the stamps so we don't spin on it.
    await admin
      .from("contacts")
      .update({ enrich_queued_at: null })
      .eq("organization_id", organizationId)
      .not("enrich_queued_at", "is", null);
    return NextResponse.json({ status: "no_owner", organization_id: organizationId });
  }

  const result = await enqueueEnrichment(admin, { organizationId, userId, contactIds });
  return NextResponse.json({ status: "drained", organization_id: organizationId, result });
}
