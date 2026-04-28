// POST /api/admin/campaigns/linkedin — create a LinkedIn sequence campaign.
// Owner-only. Inserts a campaigns row (source_channel='linkedin',
// instantly_campaign_id=null) plus campaign_steps rows in one logical
// transaction; if step inserts fail, rolls back the campaign too so we
// don't leave half-built sequences in the table.

import { NextRequest, NextResponse } from "next/server";
import { createClient as createServerClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import type { SequenceStepKind } from "@/types/app";

const VALID_KINDS: SequenceStepKind[] = [
  "connect_request",
  "message",
  "inmail",
  "like_post",
  "profile_visit",
];

interface StepInput {
  step_index: number;
  kind: SequenceStepKind;
  wait_days: number;
  body_template: string | null;
}

interface CreateBody {
  name?: string;
  client_id?: string;
  unipile_account_id?: string | null;
  steps?: StepInput[];
}

export async function POST(req: NextRequest) {
  let body: CreateBody;
  try {
    body = (await req.json()) as CreateBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

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

  const name = (body.name ?? "").trim();
  const clientId = body.client_id;
  const accountId = body.unipile_account_id ?? null;
  const steps = Array.isArray(body.steps) ? body.steps : [];

  if (!name) {
    return NextResponse.json({ error: "Name is required" }, { status: 400 });
  }
  if (!clientId) {
    return NextResponse.json({ error: "client_id is required" }, { status: 400 });
  }
  if (steps.length === 0) {
    return NextResponse.json(
      { error: "At least one step is required" },
      { status: 400 },
    );
  }

  for (const s of steps) {
    if (!VALID_KINDS.includes(s.kind)) {
      return NextResponse.json(
        { error: `Invalid step kind: ${s.kind}` },
        { status: 400 },
      );
    }
    if (typeof s.wait_days !== "number" || s.wait_days < 0 || s.wait_days > 365) {
      return NextResponse.json(
        { error: "wait_days must be between 0 and 365" },
        { status: 400 },
      );
    }
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

  const { data: created, error: createError } = await admin
    .from("campaigns")
    .insert({
      organization_id: c.organization_id,
      client_id: c.id,
      instantly_campaign_id: null,
      name,
      status: "draft",
      source_channel: "linkedin",
      unipile_account_id: accountId,
    })
    .select("id")
    .single();

  if (createError || !created) {
    console.error("[admin/campaigns/linkedin] insert failed:", createError);
    return NextResponse.json(
      { error: "Could not create campaign" },
      { status: 500 },
    );
  }

  const campaignId = (created as { id: string }).id;

  const stepRows = steps
    .map((s, i) => ({
      campaign_id: campaignId,
      step_index: typeof s.step_index === "number" ? s.step_index : i,
      kind: s.kind,
      wait_days: s.wait_days,
      body_template: (s.body_template ?? "").trim() || null,
    }))
    .sort((a, b) => a.step_index - b.step_index);

  const { error: stepsError } = await admin
    .from("campaign_steps")
    .insert(stepRows);

  if (stepsError) {
    console.error(
      `[admin/campaigns/linkedin] step insert failed; rolling back campaign ${campaignId}:`,
      stepsError,
    );
    await admin.from("campaigns").delete().eq("id", campaignId);
    return NextResponse.json(
      { error: "Could not save sequence steps" },
      { status: 500 },
    );
  }

  return NextResponse.json({ id: campaignId, name });
}
