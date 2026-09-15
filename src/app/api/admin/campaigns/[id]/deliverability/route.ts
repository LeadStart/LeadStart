// GET /api/admin/campaigns/[id]/deliverability
//
// Owner-only deliverability pre-flight for a native email campaign: live
// SPF/DKIM/DMARC checks for each sending domain in the campaign's mailbox
// pool, plus a spam-signal score of the sequence copy. Advisory only.
//
// PATCH /api/admin/campaigns/[id]/deliverability
//
// Owner-only. Updates this campaign's deliverability settings: the per-campaign
// Million Verifier send-gate controls — verify_before_send (migration 00129, the
// master on/off) and verify_first_send_only (migration 00130, restricts the gate
// to the first touch). Together they express the three modes surfaced in the UI:
// every send / first send only / off.

import { NextRequest, NextResponse } from "next/server";
import { createClient as createServerClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { checkDomainAuth, scoreCopy, domainOf } from "@/lib/deliverability/check";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: campaignId } = await params;

  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (user.app_metadata?.role !== "owner" && user.app_metadata?.role !== "va") {
    return NextResponse.json({ error: "Owner or VA role required" }, { status: 403 });
  }

  const admin = createAdminClient();
  const { data: campaignRow } = await admin
    .from("campaigns")
    .select("id, organization_id, source_channel")
    .eq("id", campaignId)
    .maybeSingle();
  const campaign = campaignRow as { id: string; organization_id: string; source_channel: string } | null;
  if (!campaign) return NextResponse.json({ error: "Campaign not found" }, { status: 404 });
  if (campaign.organization_id !== user.app_metadata?.organization_id) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (campaign.source_channel !== "native_email") {
    return NextResponse.json({ error: "Deliverability checks apply to native email campaigns only" }, { status: 400 });
  }

  // Sending domains = distinct domains across the campaign's mailbox pool.
  const { data: pool } = await admin
    .from("campaign_mailboxes")
    .select("mailbox_id")
    .eq("campaign_id", campaignId);
  const mailboxIds = ((pool ?? []) as { mailbox_id: string }[]).map((r) => r.mailbox_id);
  let domains: string[] = [];
  if (mailboxIds.length > 0) {
    const { data: mbs } = await admin
      .from("native_mailboxes")
      .select("email_address")
      .in("id", mailboxIds);
    domains = [...new Set(((mbs ?? []) as { email_address: string }[]).map((m) => domainOf(m.email_address)))];
  }

  const { data: stepsData } = await admin
    .from("campaign_steps")
    .select("subject_template, body_template")
    .eq("campaign_id", campaignId)
    .order("step_index", { ascending: true });
  const steps = ((stepsData ?? []) as { subject_template: string | null; body_template: string | null }[]).map((s) => ({
    subject: s.subject_template ?? "",
    body: s.body_template ?? "",
  }));

  const [auth, copy] = await Promise.all([
    Promise.all(domains.map((d) => checkDomainAuth(d))),
    Promise.resolve(scoreCopy(steps)),
  ]);

  return NextResponse.json({ domains: auth, copy });
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: campaignId } = await params;

  let body: { verify_before_send?: unknown; verify_first_send_only?: unknown };
  try {
    body = (await req.json()) as { verify_before_send?: unknown; verify_first_send_only?: unknown };
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (typeof body.verify_before_send !== "boolean") {
    return NextResponse.json({ error: "verify_before_send must be a boolean" }, { status: 400 });
  }
  if (body.verify_first_send_only !== undefined && typeof body.verify_first_send_only !== "boolean") {
    return NextResponse.json({ error: "verify_first_send_only must be a boolean" }, { status: 400 });
  }

  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  // Owner-only, matching the sibling campaign-settings mutations (mailbox pool,
  // tag, client link). Turning the gate off means sending unverified addresses.
  if (user.app_metadata?.role !== "owner") {
    return NextResponse.json({ error: "Owner role required" }, { status: 403 });
  }

  const admin = createAdminClient();
  const { data: campaignRow } = await admin
    .from("campaigns")
    .select("id, organization_id, source_channel")
    .eq("id", campaignId)
    .maybeSingle();
  const campaign = campaignRow as { id: string; organization_id: string; source_channel: string } | null;
  if (!campaign) return NextResponse.json({ error: "Campaign not found" }, { status: 404 });
  if (campaign.organization_id !== user.app_metadata?.organization_id) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (campaign.source_channel !== "native_email") {
    return NextResponse.json(
      { error: "Deliverability settings apply to native email campaigns only" },
      { status: 400 },
    );
  }

  const update: Record<string, unknown> = {
    verify_before_send: body.verify_before_send,
    updated_at: new Date().toISOString(),
  };
  if (body.verify_first_send_only !== undefined) {
    update.verify_first_send_only = body.verify_first_send_only;
  }

  const { error } = await admin.from("campaigns").update(update).eq("id", campaignId);
  if (error) {
    // A 42703 here means migration 00129/00130 hasn't been applied to this DB yet.
    console.error(`[deliverability] verify settings update failed for ${campaignId}:`, error.message ?? error);
    return NextResponse.json({ error: "Couldn't update the verification setting" }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    verify_before_send: body.verify_before_send,
    verify_first_send_only: body.verify_first_send_only ?? null,
  });
}
