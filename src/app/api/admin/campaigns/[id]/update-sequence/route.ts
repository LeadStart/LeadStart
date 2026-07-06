// POST /api/admin/campaigns/[id]/update-sequence
//
// Owner-only editor for a native email campaign: replaces its steps and
// updates its per-campaign send window (migration 00058). Mirrors the
// validation in /api/admin/campaigns/native. Steps are replaced wholesale
// (delete + insert) keyed by step_index, so a contact mid-sequence keeps its
// position and simply gets the edited copy for its current index.

import { NextRequest, NextResponse } from "next/server";
import { createClient as createServerClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

interface RouteParams {
  params: Promise<{ id: string }>;
}

interface StepInput {
  wait_days?: number;
  subject_template?: string | null;
  body_template?: string | null;
}

interface Body {
  steps?: StepInput[];
  send_timezone?: string | null;
  send_start_hour?: number | null;
  send_end_hour?: number | null;
  send_weekdays_only?: boolean | null;
}

const KNOWN_TZ = new Set([
  "America/Los_Angeles",
  "America/Denver",
  "America/Phoenix",
  "America/Chicago",
  "America/New_York",
]);

export async function POST(req: NextRequest, { params }: RouteParams) {
  const { id: campaignId } = await params;

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (user.app_metadata?.role !== "owner") {
    return NextResponse.json({ error: "Owner role required" }, { status: 403 });
  }

  const admin = createAdminClient();
  const { data: campaignRow } = await admin
    .from("campaigns")
    .select("id, organization_id, source_channel")
    .eq("id", campaignId)
    .maybeSingle();
  const campaign = campaignRow as
    | { id: string; organization_id: string; source_channel: string }
    | null;
  if (!campaign) return NextResponse.json({ error: "Campaign not found" }, { status: 404 });
  if (campaign.organization_id !== user.app_metadata?.organization_id) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (campaign.source_channel !== "native_email") {
    return NextResponse.json({ error: "Only native email campaigns are editable here" }, { status: 400 });
  }

  // ---- Validate steps ----
  const steps = Array.isArray(body.steps) ? body.steps : [];
  if (steps.length === 0) {
    return NextResponse.json({ error: "At least one step is required" }, { status: 400 });
  }
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    const wait = s.wait_days ?? 0;
    if (typeof wait !== "number" || wait < 0 || wait > 365) {
      return NextResponse.json({ error: `Step ${i + 1}: wait must be 0–365 days` }, { status: 400 });
    }
    if (!(s.body_template ?? "").trim()) {
      return NextResponse.json({ error: `Step ${i + 1} is missing an email body` }, { status: 400 });
    }
    if (i === 0 && !(s.subject_template ?? "").trim()) {
      return NextResponse.json({ error: "The first step needs a subject line" }, { status: 400 });
    }
  }

  // ---- Validate window (each field optional; NULL = inherit default) ----
  const tz = body.send_timezone ?? null;
  if (tz !== null && !KNOWN_TZ.has(tz)) {
    return NextResponse.json({ error: "Unsupported timezone" }, { status: 400 });
  }
  const startH = body.send_start_hour ?? null;
  const endH = body.send_end_hour ?? null;
  if (startH !== null && (startH < 0 || startH > 23)) {
    return NextResponse.json({ error: "Start hour must be 0–23" }, { status: 400 });
  }
  if (endH !== null && (endH < 1 || endH > 24)) {
    return NextResponse.json({ error: "End hour must be 1–24" }, { status: 400 });
  }
  if (startH !== null && endH !== null && startH >= endH) {
    return NextResponse.json({ error: "Start hour must be before end hour" }, { status: 400 });
  }

  // ---- Replace steps ----
  const { error: delErr } = await admin.from("campaign_steps").delete().eq("campaign_id", campaignId);
  if (delErr) {
    return NextResponse.json({ error: "Could not clear existing steps" }, { status: 500 });
  }
  const stepRows = steps.map((s, i) => ({
    campaign_id: campaignId,
    step_index: i,
    kind: "email" as const,
    wait_days: s.wait_days ?? 0,
    subject_template:
      i === 0 ? (s.subject_template ?? "").trim() : (s.subject_template ?? "").trim() || null,
    body_template: (s.body_template ?? "").trim(),
  }));
  const { error: insErr } = await admin.from("campaign_steps").insert(stepRows);
  if (insErr) {
    return NextResponse.json({ error: "Could not save steps" }, { status: 500 });
  }

  // ---- Update send window ----
  const { error: updErr } = await admin
    .from("campaigns")
    .update({
      send_timezone: tz,
      send_start_hour: startH,
      send_end_hour: endH,
      send_weekdays_only: body.send_weekdays_only ?? null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", campaignId);
  if (updErr) {
    return NextResponse.json({ error: "Steps saved, but the send window failed to update" }, { status: 500 });
  }

  return NextResponse.json({ ok: true, steps: stepRows.length });
}
