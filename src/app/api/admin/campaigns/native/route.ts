// POST /api/admin/campaigns/native — create a native email sequence
// campaign. Owner-only. Inserts a campaigns row (source_channel=
// 'native_email'), its campaign_steps (all kind='email'; step 0 carries the
// subject, later steps thread as "Re:"), and the campaign_mailboxes rotation
// pool — rolling back the campaign if any dependent insert fails.

import { NextRequest, NextResponse } from "next/server";
import { createClient as createServerClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

interface StepInput {
  step_index: number;
  wait_days: number;
  subject_template?: string | null;
  body_template?: string | null;
}

interface CreateBody {
  name?: string;
  client_id?: string;
  mailbox_ids?: string[];
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
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (user.app_metadata?.role !== "owner") {
    return NextResponse.json({ error: "Owner role required" }, { status: 403 });
  }

  const name = (body.name ?? "").trim();
  const clientId = body.client_id;
  const mailboxIds = Array.isArray(body.mailbox_ids)
    ? [...new Set(body.mailbox_ids.filter((v) => typeof v === "string" && v))]
    : [];
  const steps = Array.isArray(body.steps) ? body.steps : [];

  if (!name) return NextResponse.json({ error: "Name is required" }, { status: 400 });
  if (!clientId) return NextResponse.json({ error: "client_id is required" }, { status: 400 });
  if (steps.length === 0) {
    return NextResponse.json({ error: "At least one step is required" }, { status: 400 });
  }
  if (mailboxIds.length === 0) {
    return NextResponse.json({ error: "Select at least one sending mailbox" }, { status: 400 });
  }

  // Normalize + validate steps. Step 0 must have a subject; every step needs
  // a body. Later steps may omit the subject (they thread as "Re:").
  const sorted = [...steps].sort(
    (a, b) => (a.step_index ?? 0) - (b.step_index ?? 0),
  );
  for (let i = 0; i < sorted.length; i++) {
    const s = sorted[i];
    if (typeof s.wait_days !== "number" || s.wait_days < 0 || s.wait_days > 365) {
      return NextResponse.json({ error: "wait_days must be between 0 and 365" }, { status: 400 });
    }
    if (!(s.body_template ?? "").trim()) {
      return NextResponse.json({ error: `Step ${i + 1} is missing an email body` }, { status: 400 });
    }
    if (i === 0 && !(s.subject_template ?? "").trim()) {
      return NextResponse.json({ error: "The first step needs a subject line" }, { status: 400 });
    }
  }

  const admin = createAdminClient();

  const { data: clientRow } = await admin
    .from("clients")
    .select("id, organization_id")
    .eq("id", clientId)
    .maybeSingle();
  const c = clientRow as { id: string; organization_id: string } | null;
  if (!c) return NextResponse.json({ error: "Client not found" }, { status: 404 });
  if (c.organization_id !== user.app_metadata?.organization_id) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Only accept mailboxes that belong to this org.
  const { data: mbRows } = await admin
    .from("native_mailboxes")
    .select("id")
    .in("id", mailboxIds)
    .eq("organization_id", c.organization_id);
  const validMailboxIds = ((mbRows as { id: string }[] | null) ?? []).map((r) => r.id);
  if (validMailboxIds.length === 0) {
    return NextResponse.json({ error: "No valid mailboxes selected" }, { status: 400 });
  }

  const { data: created, error: createError } = await admin
    .from("campaigns")
    .insert({
      organization_id: c.organization_id,
      client_id: c.id,
      name,
      status: "draft",
      source_channel: "native_email",
    })
    .select("id")
    .single();
  if (createError || !created) {
    console.error("[admin/campaigns/native] insert failed:", createError);
    return NextResponse.json({ error: "Could not create campaign" }, { status: 500 });
  }
  const campaignId = (created as { id: string }).id;

  const stepRows = sorted.map((s, i) => ({
    campaign_id: campaignId,
    step_index: i,
    kind: "email" as const,
    wait_days: s.wait_days,
    subject_template: i === 0 ? (s.subject_template ?? "").trim() : (s.subject_template ?? "").trim() || null,
    body_template: (s.body_template ?? "").trim(),
  }));

  const { error: stepsError } = await admin.from("campaign_steps").insert(stepRows);
  if (stepsError) {
    console.error(`[admin/campaigns/native] step insert failed; rolling back ${campaignId}:`, stepsError);
    await admin.from("campaigns").delete().eq("id", campaignId);
    return NextResponse.json({ error: "Could not save sequence steps" }, { status: 500 });
  }

  const poolRows = validMailboxIds.map((mailbox_id) => ({
    campaign_id: campaignId,
    mailbox_id,
  }));
  const { error: poolError } = await admin.from("campaign_mailboxes").insert(poolRows);
  if (poolError) {
    console.error(`[admin/campaigns/native] mailbox pool insert failed; rolling back ${campaignId}:`, poolError);
    await admin.from("campaigns").delete().eq("id", campaignId);
    return NextResponse.json({ error: "Could not save mailbox pool" }, { status: 500 });
  }

  return NextResponse.json({ id: campaignId, name });
}
