// POST /api/admin/campaigns/[id]/activate — flip a draft campaign to
// active. For the local channels (native email / LinkedIn) there is no
// upstream sequencer to start, so this is a local status change; the cron
// workers only dispatch campaigns with status='active'.
// Owner or VA.

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import type { SourceChannel } from "@/types/app";
import { runActivationPreflight } from "@/lib/deliverability/preflight";
import { gatherLaunchReadiness } from "@/lib/campaigns/launch-readiness";

// checkDomainAuth in the pre-flight uses node:dns.
export const runtime = "nodejs";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: campaignId } = await params;

  // Optional { acknowledge_warnings } — a body-less POST (every existing
  // caller) parses to {} and behaves exactly as before.
  let ackWarnings = false;
  try {
    const body = (await req.json()) as { acknowledge_warnings?: boolean };
    ackWarnings = body?.acknowledge_warnings === true;
  } catch {
    ackWarnings = false;
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const role = user.app_metadata?.role;
  if (role !== "owner" && role !== "va") {
    return NextResponse.json({ error: "Owner or VA role required" }, { status: 403 });
  }

  const admin = createAdminClient();
  const { data: campaign } = await admin
    .from("campaigns")
    .select("id, organization_id, client_id, source_channel, status")
    .eq("id", campaignId)
    .maybeSingle();
  const c = campaign as
    | {
        id: string;
        organization_id: string;
        client_id: string | null;
        source_channel: SourceChannel;
        status: string | null;
      }
    | null;
  if (!c) return NextResponse.json({ error: "Campaign not found" }, { status: 404 });
  if (c.organization_id !== user.app_metadata?.organization_id) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  if (
    c.source_channel !== "native_email" &&
    c.source_channel !== "linkedin"
  ) {
    return NextResponse.json(
      { error: "Activate is only for native email and LinkedIn campaigns." },
      { status: 400 },
    );
  }
  // Activate is strictly draft → active. 'completed' is terminal, and a
  // paused campaign is restarted via /resume, not here.
  if (c.status !== "draft") {
    return NextResponse.json(
      {
        error:
          c.status === "active"
            ? "Campaign is already active."
            : `Only draft campaigns can be activated (this one is ${c.status}${c.status === "paused" ? " — use Resume instead" : ""}).`,
      },
      { status: 400 },
    );
  }

  // Hard launch-readiness gate for native email — the SAME rule that drives the
  // campaign detail badges + disables the Launch button (src/lib/campaigns/
  // launch-readiness.ts): a client assigned, a connected sending mailbox, and an
  // email step with a subject line. Server-enforced so the gate can't be bypassed.
  if (c.source_channel === "native_email") {
    const readiness = await gatherLaunchReadiness(admin, {
      id: c.id,
      client_id: c.client_id,
    });
    if (!readiness.canLaunch) {
      return NextResponse.json(
        {
          error: `Not ready to launch — ${readiness.blockers
            .map((b) => b.label.toLowerCase())
            .join("; ")}.`,
          blockers: readiness.blockers,
        },
        { status: 400 },
      );
    }

    // Advisory pre-flight (warn-with-override): surface copy / auth / placement
    // concerns the first time, then activate on the acknowledged re-submit.
    // Never blocks — the hard blocks above already did their job.
    if (!ackWarnings) {
      const preflightWarnings = await runActivationPreflight(admin, campaignId);
      if (preflightWarnings.length > 0) {
        return NextResponse.json({ warnings: preflightWarnings }, { status: 409 });
      }
    }
  }

  const { error: updateError } = await admin
    .from("campaigns")
    .update({ status: "active" })
    .eq("id", campaignId);
  if (updateError) {
    return NextResponse.json({ error: updateError.message }, { status: 500 });
  }

  return NextResponse.json({ success: true, status: "active" });
}
