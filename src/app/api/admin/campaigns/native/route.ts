// POST /api/admin/campaigns/native — create a native email sequence
// campaign. Owner-only. Inserts a campaigns row (source_channel=
// 'native_email'), its campaign_steps (all kind='email'; step 0 carries the
// subject, later steps thread as "Re:"), and the campaign_mailboxes rotation
// pool — rolling back the campaign if any dependent insert fails.

import { NextRequest, NextResponse } from "next/server";
import { createClient as createServerClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  extractCampaignTokens,
  reconcileCampaignVariables,
} from "@/lib/native/tokens";
import { allEmailTemplates, type FlowGraph } from "@/lib/flow/graph";

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
  // The visual Flow builder graph. Persisted verbatim on the campaign; the
  // executed `steps` above are derived from it client-side. Optional so older
  // callers (and linear campaigns) keep working.
  flow_graph?: unknown;
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
  const clientId =
    typeof body.client_id === "string" && body.client_id ? body.client_id : null;
  const mailboxIds = Array.isArray(body.mailbox_ids)
    ? [...new Set(body.mailbox_ids.filter((v) => typeof v === "string" && v))]
    : [];
  const steps = Array.isArray(body.steps) ? body.steps : [];

  // A campaign is created as a DRAFT from just a name. Client, mailboxes, and a
  // complete sequence are all optional here — launch readiness (src/lib/campaigns/
  // launch-readiness.ts) surfaces what's still needed and the activate route
  // hard-gates on it. Only the name is required to save a draft.
  if (!name) return NextResponse.json({ error: "Name is required" }, { status: 400 });

  const orgId = user.app_metadata?.organization_id as string | undefined;
  if (!orgId) {
    return NextResponse.json({ error: "No organization on user" }, { status: 400 });
  }

  // Normalize steps by index. Draft-time: no subject/body requirement yet (launch
  // readiness enforces the first-subject rule); only guard wait_days for integrity.
  const sorted = [...steps].sort(
    (a, b) => (a.step_index ?? 0) - (b.step_index ?? 0),
  );
  for (const s of sorted) {
    if (
      s.wait_days != null &&
      (typeof s.wait_days !== "number" || s.wait_days < 0 || s.wait_days > 365)
    ) {
      return NextResponse.json({ error: "wait_days must be between 0 and 365" }, { status: 400 });
    }
  }

  const admin = createAdminClient();

  // Validate the client only if one was chosen; the org always comes from the user.
  let resolvedClientId: string | null = null;
  if (clientId) {
    const { data: clientRow } = await admin
      .from("clients")
      .select("id, organization_id")
      .eq("id", clientId)
      .maybeSingle();
    const c = clientRow as { id: string; organization_id: string } | null;
    if (!c) return NextResponse.json({ error: "Client not found" }, { status: 404 });
    if (c.organization_id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    resolvedClientId = c.id;
  }

  // Attach only mailboxes that belong to this org, if any were selected. Unknown
  // ids are dropped rather than failing the draft.
  let validMailboxIds: string[] = [];
  if (mailboxIds.length > 0) {
    const { data: mbRows } = await admin
      .from("native_mailboxes")
      .select("id")
      .in("id", mailboxIds)
      .eq("organization_id", orgId);
    validMailboxIds = ((mbRows as { id: string }[] | null) ?? []).map((r) => r.id);
  }

  const flowGraph =
    body.flow_graph && typeof body.flow_graph === "object" ? body.flow_graph : null;

  // Seed the variable registry (migration 00092) from the campaign's copy. Prefer
  // the full flow graph — all A/B variants + both branches — so B/C-variant tokens
  // are registered; fall back to the linear steps for a graph-less create.
  const registryTemplates =
    flowGraph && Array.isArray((flowGraph as FlowGraph).nodes)
      ? allEmailTemplates(flowGraph as FlowGraph)
      : sorted.flatMap((s) => [s.subject_template ?? "", s.body_template ?? ""]);
  const variables = reconcileCampaignVariables(
    [],
    extractCampaignTokens(registryTemplates),
    [],
  );

  const { data: created, error: createError } = await admin
    .from("campaigns")
    .insert({
      organization_id: orgId,
      client_id: resolvedClientId,
      name,
      status: "draft",
      source_channel: "native_email",
      flow_graph: flowGraph,
      variables,
    })
    .select("id")
    .single();
  if (createError || !created) {
    console.error("[admin/campaigns/native] insert failed:", createError);
    return NextResponse.json({ error: "Could not create campaign" }, { status: 500 });
  }
  const campaignId = (created as { id: string }).id;

  // Steps are optional for a draft — insert only what was authored.
  if (sorted.length > 0) {
    const stepRows = sorted.map((s, i) => ({
      campaign_id: campaignId,
      step_index: i,
      kind: "email" as const,
      wait_days: typeof s.wait_days === "number" ? s.wait_days : 0,
      subject_template: i === 0 ? (s.subject_template ?? "").trim() : (s.subject_template ?? "").trim() || null,
      body_template: (s.body_template ?? "").trim(),
    }));
    const { error: stepsError } = await admin.from("campaign_steps").insert(stepRows);
    if (stepsError) {
      console.error(`[admin/campaigns/native] step insert failed; rolling back ${campaignId}:`, stepsError);
      await admin.from("campaigns").delete().eq("id", campaignId);
      return NextResponse.json({ error: "Could not save sequence steps" }, { status: 500 });
    }
  }

  // Mailbox pool is optional for a draft — attach only if any were selected.
  if (validMailboxIds.length > 0) {
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
  }

  return NextResponse.json({ id: campaignId, name });
}
