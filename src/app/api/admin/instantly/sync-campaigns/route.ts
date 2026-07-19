// POST /api/admin/instantly/sync-campaigns — pull the org's Instantly
// campaigns and mirror them as LeadStart campaigns rows (source_channel=
// 'instantly'). Owner or VA.
//
// The "link existing" model: campaigns are authored + sent inside Instantly;
// this makes them visible in LeadStart so leads can be pushed, replies
// ingested, and analytics rolled up. New rows land as orphans (client_id
// NULL) — the owner links each to a client on the campaign detail page.
//
// Re-sync is safe: we upsert on (organization_id, instantly_campaign_id) and
// deliberately OMIT client_id from the payload so an already-linked campaign
// keeps its client (PostgREST only updates the columns we send). name + status
// refresh from Instantly on every sync.

import { NextResponse } from "next/server";
import { requireInstantlyContext } from "@/lib/instantly/auth";
import { InstantlyClient } from "@/lib/instantly/client";
import type { CampaignStatus } from "@/types/app";

// Instantly returns status as a small integer: 0=draft, 1=active, 2=paused,
// 3=completed.
function mapStatus(status: number): CampaignStatus {
  switch (status) {
    case 1:
      return "active";
    case 2:
      return "paused";
    case 3:
      return "completed";
    default:
      return "draft";
  }
}

export async function POST() {
  const ctx = await requireInstantlyContext();
  if ("error" in ctx) return ctx.error;
  const { apiKey, organizationId, admin } = ctx;

  let campaigns;
  try {
    campaigns = await new InstantlyClient(apiKey).getAllCampaigns();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: `Instantly campaign list failed: ${message}` },
      { status: 502 },
    );
  }

  if (campaigns.length === 0) {
    return NextResponse.json({
      synced: 0,
      note: "No campaigns found in the Instantly workspace.",
    });
  }

  const rows = campaigns.map((c) => ({
    organization_id: organizationId,
    instantly_campaign_id: c.id,
    name: c.name,
    status: mapStatus(c.status),
    source_channel: "instantly" as const,
  }));

  const { error } = await admin
    .from("campaigns")
    .upsert(rows, {
      onConflict: "organization_id,instantly_campaign_id",
      ignoreDuplicates: false,
    });
  if (error) {
    console.error("[admin/instantly/sync-campaigns] upsert failed:", error);
    return NextResponse.json({ error: `Sync failed: ${error.message}` }, { status: 500 });
  }

  return NextResponse.json({ synced: campaigns.length });
}
